import { IncomingMessage } from "node:http";
import { getHeapStatistics } from "node:v8";

import { BodyCapacityExceeded } from "@std/api/errors/body-capacity-exceeded";
import { BodyTooLarge } from "@std/api/errors/body-too-large";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { SESSION_BODY_MAX_BYTES } from "@std/api/session";
import { apiTableNameOf } from "@std/definitions/names";
import { Effect, Stream, Predicate, Semaphore } from "effect";
import { FindMyWay, HttpRouter } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

import { tmfErrorResponse } from "./api/tmf-error.ts";
import { DEFINITION_KIND_OF_TABLE } from "./change-sets.ts";

/** Record-write budget: Martin, 2026-10-23, decision 0038; measured JSON
 * parsing costs ~30 ms/MiB and 28x RSS, accepting ~0.5 s at 16 MiB. */
export const BODY_MAX_BYTES = 16_777_216;

/** Definition budget: largest shipped complete change set = 103,713 bytes,
 * 202 operations (http-edge-limits test, 2026-10-23); 1 MiB gives 10.11x
 * headroom and still carries complete large definition sets. */
export const DEFINITION_BODY_MAX_BYTES = 1_048_576;

/** Hub budget: the existing resource=acmeAsset/cost=10 registration fixture
 * with https://callback.example/ serializes to 91 bytes (JSON.stringify,
 * http-edge-round2 receipt test, 2026-10-23). 128 KiB gives over 1,400x
 * headroom for longer selectors/URLs. Strings have no finite schema maximum;
 * this is an explicit HTTP budget, not a claimed per-string schema bound. */
export const HUB_BODY_MAX_BYTES = 131_072;

/** Dead-delivery tasks: type member + positive int8 deliveryId (19 decimal digits)
 * serialize to under 100 bytes; 1 KiB leaves over 10x envelope/whitespace headroom. */
export const TASK_BODY_MAX_BYTES = 1024;

/** Process byte budget: review measured 28x RSS amplification on a 4,192 MiB
 * heap (2026-10-23). 32 MiB reserves at most 896 MiB at that amplification, leaving
 * 3,296 MiB for normal work. Smaller heaps reserve at most a quarter / 28.
 * Reservations cover framed or actually retained bytes until the
 * response is built, including parsing, decoded work and transaction retries. */
export const BODY_IN_FLIGHT_MAX_BYTES = Math.min(
  33_554_432,
  Math.floor(getHeapStatistics().heap_size_limit / (28 * 4))
);

/** Temporary overload recovery advice: one second, exceeding the accepted
 * ~0.5 s maximum JSON pause; TMF630 v5 P1 §3.3.4 p.33 (decision 0038). */
export const BODY_RETRY_SECONDS = 1;

// One semaphore for every listener/application in this process.
const bodyCapacity = Semaphore.makeUnsafe(BODY_IN_FLIGHT_MAX_BYTES);

const bodyLimits = (config: Partial<FindMyWay.RouterConfig>) => {
  const routes = FindMyWay.make<number>(config);
  routes.on("POST", "/api/v1/session", SESSION_BODY_MAX_BYTES);
  routes.on("POST", "/api/v1/applyChangeSet", DEFINITION_BODY_MAX_BYTES);
  routes.on("POST", "/api/v1/hub", HUB_BODY_MAX_BYTES);
  routes.on("POST", "/tmf-api/:api/:version/hub", HUB_BODY_MAX_BYTES);
  routes.on("POST", "/tmf-api/event/v4/topic/:topicId/hub", HUB_BODY_MAX_BYTES);
  routes.on("POST", "/api/v1/retryDeadDelivery", TASK_BODY_MAX_BYTES);
  routes.on("POST", "/api/v1/discardDeadDelivery", TASK_BODY_MAX_BYTES);

  for (const table of DEFINITION_KIND_OF_TABLE.keys()) {
    const [namespace = "", name = ""] = table.split(".");
    routes.on(
      ["POST", "PATCH"],
      `/api/v1/${apiTableNameOf(namespace, name)}`,
      DEFINITION_BODY_MAX_BYTES
    );
    routes.on(
      "PATCH",
      `/api/v1/${apiTableNameOf(namespace, name)}/:id`,
      DEFINITION_BODY_MAX_BYTES
    );
  }

  const lookup = routes.find.bind(routes);

  return (request: HttpServerRequest) => {
    // DELETE and read/method routes have no body in their schemas (Contracts 10.5).
    if (request.method !== "POST" && request.method !== "PATCH") {
      return 0;
    }

    return (
      lookup(request.method, request.originalUrl)?.handler ?? BODY_MAX_BYTES
    );
  };
};

type BodyReadError = BodyTooLarge | InvalidRequest | BodyCapacityExceeded;

interface BodyPolicy {
  readonly limit: number;
  readonly reserve: (received: number) => BodyCapacityExceeded | undefined;
}

const policies = new WeakMap<object, BodyPolicy>();

const tooLarge = (limit: number, received: number | string) => {
  const message = `body_max_bytes=${limit}; received ${received} bytes. ${limit === 0 ? "This method takes no body." : "Reduce the request body."}`;

  return limit === 0
    ? new InvalidRequest({ limit, message, parameter: "body", received })
    : new BodyTooLarge({ limit, message, received });
};

const unreadable = () =>
  new InvalidRequest({
    message: "The body could not be read.",
    parameter: "body",
  });

// The default Effect Node reader destroys the socket on early termination.
// Paused-mode reads let overflow send 413 before Connection: close takes effect.
const nodeBody = (source: IncomingMessage, policy: BodyPolicy) =>
  Effect.callback<string, BodyReadError>((resume) => {
    const { limit } = policy;
    const chunks: Uint8Array[] = [];
    let received = 0;
    let done = false;

    const fail = (error: BodyReadError) => {
      if (done) {
        return;
      }

      done = true;
      source.pause();
      resume(Effect.fail(error));
    };

    const read = () => {
      if (done) {
        return;
      }

      while (true) {
        const chunk: unknown = source.read();

        if (chunk === null) {
          return;
        }

        if (!(chunk instanceof Uint8Array)) {
          fail(unreadable());

          return;
        }

        received += chunk.byteLength;

        if (received > limit) {
          fail(tooLarge(limit, received));

          return;
        }

        const refusal = policy.reserve(received);

        if (refusal !== undefined) {
          fail(refusal);

          return;
        }

        chunks.push(chunk);
      }
    };

    const end = () => {
      if (done) {
        return;
      }

      done = true;
      resume(Effect.succeed(Buffer.concat(chunks, received).toString("utf-8")));
    };

    const error = () => {
      fail(unreadable());
    };

    source.on("readable", read);
    source.on("end", end);
    source.on("error", error);
    source.on("aborted", error);
    read();

    return Effect.sync(() => {
      done = true;
      source.pause();
      source.off("readable", read);
      source.off("end", end);
      source.off("error", error);
      source.off("aborted", error);
    });
  });

/**
 * Reads bytes with backpressure and stops at the first overflowing chunk.
 * Used by every JSON and DELETE reader; errors never become an empty body.
 */
const readBody = Effect.fn("Http.readBody")(function* readBody(
  request: HttpServerRequest
) {
  const policy = policies.get(request.source);

  if (policy === undefined) {
    return yield* Effect.die(
      new Error("BodyLimitsLayer must own every body read")
    );
  }

  const { limit } = policy;
  const refusal = policy.reserve(0);

  if (refusal !== undefined) {
    return yield* refusal;
  }

  const { source } = request;

  if (source instanceof IncomingMessage) {
    return yield* nodeBody(source, policy);
  }

  if (source instanceof Request && source.body === null) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  yield* request.stream.pipe(
    Stream.mapError(unreadable),
    Stream.runForEach((chunk): Effect.Effect<void, BodyReadError> => {
      received += chunk.byteLength;

      if (received > limit) {
        return Effect.fail(tooLarge(limit, received));
      }

      const capacityRefusal = policy.reserve(received);

      if (capacityRefusal !== undefined) {
        return Effect.fail(capacityRefusal);
      }

      chunks.push(chunk);

      return Effect.void;
    })
  );

  return Buffer.concat(chunks, received).toString("utf-8");
});

// Requests can be read again after a retried SQL transaction. Like Effect's
// Node incoming-message reader, cache the bounded result, including failures.
// The source survives request wrappers; weak keys release completed requests.
const bodies = new WeakMap<object, Effect.Effect<string, BodyReadError>>();

/**
 * Reads a request once and reuses its bounded result across transaction retries.
 * @param request - Incoming request.
 * @returns Body text, or the original read/size refusal.
 */
export const textBodyOf = (request: HttpServerRequest) => {
  const key = Predicate.isObject(request.source) ? request.source : request;
  const existing = bodies.get(key);

  if (existing !== undefined) {
    return existing;
  }

  // Effect's own NodeHttpIncomingMessage uses cached + runSync to allocate
  // the lazy memoizer atomically, before any caller can start the read.
  const body = Effect.runSync(Effect.cached(readBody(request)));
  bodies.set(key, body);

  return body;
};

/** The outer body policy: reject Content-Length before any body read. */
export const BodyLimitsLayer = HttpRouter.middleware(
  Effect.gen(function* bodyLimitsLayer() {
    if (BODY_IN_FLIGHT_MAX_BYTES < BODY_MAX_BYTES) {
      return yield* Effect.die(
        new Error(
          `body_in_flight_max_bytes=${BODY_IN_FLIGHT_MAX_BYTES}; asked to reserve record_body_max_bytes=${BODY_MAX_BYTES}; heap_size_limit=${getHeapStatistics().heap_size_limit}. Increase the V8 heap so the process can admit one record body within its quarter-heap budget.`
        )
      );
    }

    const limitOf = bodyLimits(yield* HttpRouter.RouterConfig);

    return (app) =>
      Effect.gen(function* bodyLimitsRequest() {
        const request = yield* HttpServerRequest;
        const limit = limitOf(request);
        const length = Number(request.headers["content-length"] ?? 0);

        if (length > limit) {
          return tmfErrorResponse(
            tooLarge(limit, request.headers["content-length"] ?? length)
          );
        }

        // Node enforces Content-Length framing, so reserve that exact length
        // before reading. Web adapters and chunked uploads reserve actual bytes
        // cumulatively before retaining each chunk. Tiny writes must not pay
        // the maximum record budget (aggregate-race-http exercises concurrency).
        const framed = request.source instanceof IncomingMessage ? length : 0;
        let reserved = 0;

        const reserve = (
          received: number
        ): BodyCapacityExceeded | undefined => {
          const asked = Math.max(framed, received) - reserved;

          if (asked <= 0) {
            return undefined;
          }

          // takeIfAvailable never suspends in Effect 4.0.5 (Semaphore.ts).
          // Synchronous acquisition is required inside Node's readable callback.
          if (!Effect.runSync(bodyCapacity.takeIfAvailable(asked))) {
            return new BodyCapacityExceeded({
              limit: BODY_IN_FLIGHT_MAX_BYTES,
              message: `body_in_flight_max_bytes=${BODY_IN_FLIGHT_MAX_BYTES}; asked for ${asked} additional bytes. Retry after capacity is released.`,
              requested: asked,
              retryAfterSeconds: BODY_RETRY_SECONDS,
            });
          }

          reserved += asked;

          return undefined;
        };

        policies.set(request.source, { limit, reserve });

        return yield* app.pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              reserved > 0 ? bodyCapacity.release(reserved) : Effect.void
            )
          )
        );
      });
  }),
  { global: true }
);
