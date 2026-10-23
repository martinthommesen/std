import { IncomingMessage } from "node:http";
import { getHeapStatistics } from "node:v8";

import { BodyCapacityExceeded } from "@std/api/errors/body-capacity-exceeded";
import { BodyTooLarge } from "@std/api/errors/body-too-large";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { SESSION_BODY_MAX_BYTES } from "@std/api/session";
import { apiTableNameOf } from "@std/definitions/names";
import { Clock, Effect, Schedule, Stream, Predicate, Semaphore } from "effect";
import { FindMyWay, HttpRouter } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

import { tmfErrorResponse } from "./api/tmf-error.ts";
import { DEFINITION_KIND_OF_TABLE } from "./change-sets.ts";

/** Record-write latency budget: decision 0038, corrected record-route probes
 * (2026-10-23). 16 MiB still exceeded Martin's ~0.5 s target after the redundant
 * JSON decoder was removed; the repeated 4 MiB measurements are recorded there. */
export const BODY_MAX_BYTES = 4_194_304;

/** Definition budget: largest shipped complete change set = 106,677 bytes,
 * 207 operations (http-edge-limits test, 2026-10-23); 1 MiB gives 9.83x
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

/** Process byte budget: corrected probes measured about 184 MiB RSS growth for
 * a 4 MiB wrong-kind record (~46x), versus the review's original 55x.
 * Round up to 64x for allocator/GC headroom. A quarter of V8 heap protects
 * ordinary work; four maximum record bodies consume 16 MiB / 1 GiB amplified
 * on the measured 4,192 MiB heap. Smaller heaps admit whole record budgets.
 * Receipt: decision 0038, round 3 measurements, 2026-10-23.
 * Hold actual retained bytes through parsing, work, retries and response. */
export const BODY_IN_FLIGHT_MAX_BYTES =
  BODY_MAX_BYTES *
  Math.min(
    4,
    Math.floor(getHeapStatistics().heap_size_limit / (64 * 4 * BODY_MAX_BYTES))
  );

/** Per-user fairness budget: one maximum record body (4 MiB) of actual
 * received bytes per authenticated user, across all of that user's sessions
 * and every body route. Filling the process budget then needs as many distinct
 * users as it holds maximum records (four on the measured heap), and one user
 * still gets any number of small concurrent bodies. A per-user body count was
 * rejected: it refuses parallel small integration writes without bounding
 * memory, which is what this protects. Exhaustion is 503: TMF630 v5.0.0 Part 1
 * §3.3.3 p.33 keeps 429 for request-rate limits over a time window (with the
 * window headers of §1.5.4 p.14), while §3.3.4 p.33 gives 503 for temporary
 * overload, and the pinned TMF621 v5.0.1 POST/PATCH declare 503, not 429.
 * Decision 0038, round 4 (2026-10-23). */
export const BODY_USER_IN_FLIGHT_MAX_BYTES = BODY_MAX_BYTES;

/** Sign-in body budget, sized from decode memory (bodies are read before any
 * KDF slot, so worker count is the wrong basis). Receipt, 2026-10-23, two runs:
 * 64 retained 64-KiB envelopes through parseJson + checkedSessionCreate cost
 * about 8.7 MB heap for legal strings and 97.9-99.0 MB heap, 113.8-121.5 MB
 * RSS (27.1x-29.0x input) for wrong-kind object arrays. Allow 64x amplification
 * and at most 1/16 of V8 heap, capped at 4 MiB raw: 64 maximum bodies on the
 * measured 4,192-MiB heap. Decision 0038 records the command and shapes. */
export const SESSION_BODY_IN_FLIGHT_MAX_BYTES =
  SESSION_BODY_MAX_BYTES *
  Math.min(
    64,
    Math.floor(
      getHeapStatistics().heap_size_limit / (64 * 16 * SESSION_BODY_MAX_BYTES)
    )
  );

/** Upload rate budget: half the 1 Mbit/s minimum uplink in the UK broadband
 * universal-service specification (125,000 / 2 bytes/s), allowing protocol and
 * contention overhead. https://www.legislation.gov.uk/uksi/2018/445/schedule/1/made
 * Read 2026-10-23; decision 0038. */
export const BODY_MIN_BYTES_PER_SECOND = 62_500;

/** Recent-progress window: every check from one window after the read began
 * requires the bytes received in the latest window to reach
 * window * BODY_MIN_BYTES_PER_SECOND (500,000 bytes per 8 s). Bytes received
 * before the window never count. 8 s covers RFC 6298 §§2.1,5.5's first
 * 1+2+4-second retransmission waits for the first window; afterwards a client
 * at the full 1-Mbit/s uplink may stall up to half a window (4 s, the 1+2 s
 * waits) and still carry the half-rate minimum. A body that stops sending is
 * refused within one window plus one check interval of its last byte,
 * whatever its size. https://www.rfc-editor.org/rfc/rfc6298.html (2026-10-23). */
export const BODY_PROGRESS_WINDOW_MS = 8000;

/** Check once per initial 1-second TCP RTO (RFC 6298 §2.1); detection lags a
 * window by at most one interval. */
export const BODY_PROGRESS_INTERVAL_MS = 1000;

/** Temporary overload recovery advice: one second, exceeding the accepted
 * ~0.5 s maximum JSON pause; TMF630 v5 P1 §3.3.4 p.33 (decision 0038). */
export const BODY_RETRY_SECONDS = 1;

// One semaphore for every listener/application in this process.
const bodyCapacity = Semaphore.makeUnsafe(BODY_IN_FLIGHT_MAX_BYTES);

const sessionBodyCapacity = Semaphore.makeUnsafe(
  SESSION_BODY_IN_FLIGHT_MAX_BYTES
);

/** A route's body budget; only sign-in reads a body without a user. */
interface BodyRoute {
  readonly limit: number;
  readonly signIn: boolean;
}

const userBody = (limit: number): BodyRoute => ({ limit, signIn: false });

const NO_BODY = userBody(0);
const RECORD_BODY = userBody(BODY_MAX_BYTES);

const bodyLimits = (config: Partial<FindMyWay.RouterConfig>) => {
  const routes = FindMyWay.make<BodyRoute>(config);
  routes.on("POST", "/api/v1/session", {
    limit: SESSION_BODY_MAX_BYTES,
    signIn: true,
  });
  routes.on(
    "POST",
    "/api/v1/applyChangeSet",
    userBody(DEFINITION_BODY_MAX_BYTES)
  );
  routes.on("POST", "/api/v1/hub", userBody(HUB_BODY_MAX_BYTES));
  routes.on("POST", "/tmf-api/:api/:version/hub", userBody(HUB_BODY_MAX_BYTES));
  routes.on(
    "POST",
    "/tmf-api/event/v4/topic/:topicId/hub",
    userBody(HUB_BODY_MAX_BYTES)
  );
  routes.on("POST", "/api/v1/retryDeadDelivery", userBody(TASK_BODY_MAX_BYTES));
  routes.on(
    "POST",
    "/api/v1/discardDeadDelivery",
    userBody(TASK_BODY_MAX_BYTES)
  );

  for (const table of DEFINITION_KIND_OF_TABLE.keys()) {
    const [namespace = "", name = ""] = table.split(".");
    routes.on(
      ["POST", "PATCH"],
      `/api/v1/${apiTableNameOf(namespace, name)}`,
      userBody(DEFINITION_BODY_MAX_BYTES)
    );
    routes.on(
      "PATCH",
      `/api/v1/${apiTableNameOf(namespace, name)}/:id`,
      userBody(DEFINITION_BODY_MAX_BYTES)
    );
  }

  const lookup = routes.find.bind(routes);

  return (request: HttpServerRequest): BodyRoute => {
    // DELETE and read/method routes have no body in their schemas (Contracts 10.5).
    if (request.method !== "POST" && request.method !== "PATCH") {
      return NO_BODY;
    }

    return lookup(request.method, request.originalUrl)?.handler ?? RECORD_BODY;
  };
};

type BodyReadError = BodyTooLarge | InvalidRequest | BodyCapacityExceeded;

interface BodyPolicy {
  readonly limit: number;
  readonly signIn: boolean;
  readonly received: () => number;
  readonly reserve: (received: number) => BodyCapacityExceeded | undefined;
}

const policies = new WeakMap<object, BodyPolicy>();
const bodyOwners = new WeakMap<object, string>();
const userBodyBytes = new Map<string, number>();

/**
 * Bind a protected body's capacity to its authenticated user after SQL releases.
 * The outer policy holds/releases the reservation through work and retries.
 * @param request - Incoming request owned by BodyLimitsLayer.
 * @param userId - Authenticated user's identity, shared across sessions.
 */
export const ownBody = (request: HttpServerRequest, userId: string): void => {
  bodyOwners.set(request.source, userId);
};

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
const readBodyBytes = Effect.fn("Http.readBodyBytes")(function* readBodyBytes(
  request: HttpServerRequest
) {
  const policy = policies.get(request.source);

  if (policy === undefined) {
    return yield* Effect.die(
      new Error("BodyLimitsLayer must own every body read")
    );
  }

  const { limit } = policy;

  // Every positive budget except sign-in belongs to a user's share; a route
  // that skipped readAuthenticatedBody would read uncharged (decision 0038).
  if (limit > 0 && !policy.signIn && !bodyOwners.has(request.source)) {
    return yield* Effect.die(
      new Error(
        `A protected body (body_max_bytes=${limit}) must be read through readAuthenticatedBody, which charges body_user_in_flight_max_bytes=${BODY_USER_IN_FLIGHT_MAX_BYTES} to its user.`
      )
    );
  }

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

// Race the reader, not SQL or parsing. Effect interruption removes Node listeners
// and pauses the source before the actionable error closes the connection.
const readBody = Effect.fn("Http.readBody")(function* readBody(
  request: HttpServerRequest
) {
  const started = yield* Clock.currentTimeMillis;
  // One sample per check: (time, bytes received so far).
  const samples = [{ at: started, received: 0 }];

  const progress = Effect.gen(function* bodyProgress() {
    const now = yield* Clock.currentTimeMillis;
    const received = policies.get(request.source)?.received() ?? 0;
    const windowStart = now - BODY_PROGRESS_WINDOW_MS;

    // The baseline is the latest sample at or before the window start, so a
    // late check measures a slightly longer window, never borrows older bytes.
    while (samples[1] !== undefined && samples[1].at <= windowStart) {
      samples.shift();
    }

    const [baseline = { at: started, received: 0 }] = samples;
    const windowMs = now - baseline.at;
    const recent = received - baseline.received;
    const required = (windowMs * BODY_MIN_BYTES_PER_SECOND) / 1000;

    if (now - started >= BODY_PROGRESS_WINDOW_MS && recent < required) {
      return yield* new InvalidRequest({
        limit: BODY_MIN_BYTES_PER_SECOND,
        message: `body_min_bytes_per_second=${BODY_MIN_BYTES_PER_SECOND}; body_progress_window_ms=${BODY_PROGRESS_WINDOW_MS}; received ${received} bytes in ${now - started} ms, of which ${recent} in the last ${windowMs} ms; required at least ${Math.ceil(required)} bytes in that window. Send at least the minimum rate in every window, or reduce the body.`,
        parameter: "body_min_bytes_per_second",
        received,
      });
    }

    // The first check runs at the start; keep the zero baseline for that instant.
    if (now > (samples.at(-1)?.at ?? started)) {
      samples.push({ at: now, received });
    }

    return yield* Effect.void;
  }).pipe(
    Effect.repeat(Schedule.spaced(BODY_PROGRESS_INTERVAL_MS)),
    Effect.andThen(Effect.never)
  );

  return yield* Effect.raceFirst(readBodyBytes(request), progress);
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

    const routeOf = bodyLimits(yield* HttpRouter.RouterConfig);

    return (app) =>
      Effect.gen(function* bodyLimitsRequest() {
        const request = yield* HttpServerRequest;
        const { limit, signIn } = routeOf(request);
        const length = Number(request.headers["content-length"] ?? 0);

        if (length > limit) {
          return tmfErrorResponse(
            tooLarge(limit, request.headers["content-length"] ?? length)
          );
        }

        // Declared bytes consume no memory. Charge each received chunk before
        // retaining it, identically for framed, chunked and web requests.
        const capacity = signIn ? sessionBodyCapacity : bodyCapacity;

        const capacityLimit = signIn
          ? SESSION_BODY_IN_FLIGHT_MAX_BYTES
          : BODY_IN_FLIGHT_MAX_BYTES;

        const capacityName = signIn
          ? "session_body_in_flight_max_bytes"
          : "body_in_flight_max_bytes";

        let reserved = 0;

        // Bytes charged to the owner's share; released exactly, even if the
        // owner was bound after an earlier unowned reservation.
        let charged:
          | { readonly owner: string; readonly bytes: number }
          | undefined;

        const reserve = (
          received: number
        ): BodyCapacityExceeded | undefined => {
          const asked = received - reserved;

          if (asked <= 0) {
            return undefined;
          }

          const owner = bodyOwners.get(request.source);

          const userReserved =
            owner === undefined ? 0 : (userBodyBytes.get(owner) ?? 0);

          if (
            owner !== undefined &&
            userReserved + asked > BODY_USER_IN_FLIGHT_MAX_BYTES
          ) {
            return new BodyCapacityExceeded({
              limit: BODY_USER_IN_FLIGHT_MAX_BYTES,
              message: `body_user_in_flight_max_bytes=${BODY_USER_IN_FLIGHT_MAX_BYTES}; user already holds ${userReserved} bytes; asked for ${asked} additional bytes. Retry after this user's capacity is released.`,
              requested: asked,
              retryAfterSeconds: BODY_RETRY_SECONDS,
            });
          }

          // takeIfAvailable never suspends in Effect 4.0.5 (Semaphore.ts).
          // Synchronous acquisition is required inside Node's readable callback.
          if (!Effect.runSync(capacity.takeIfAvailable(asked))) {
            return new BodyCapacityExceeded({
              limit: capacityLimit,
              message: `${capacityName}=${capacityLimit}; asked for ${asked} additional bytes. Retry after capacity is released.`,
              requested: asked,
              retryAfterSeconds: BODY_RETRY_SECONDS,
            });
          }

          reserved += asked;

          if (owner !== undefined) {
            userBodyBytes.set(owner, userReserved + asked);
            charged = { bytes: (charged?.bytes ?? 0) + asked, owner };
          }

          return undefined;
        };

        policies.set(request.source, {
          limit,
          received: () => reserved,
          reserve,
          signIn,
        });

        return yield* app.pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (charged !== undefined) {
                const { bytes, owner } = charged;
                const remaining = (userBodyBytes.get(owner) ?? 0) - bytes;

                if (remaining === 0) {
                  userBodyBytes.delete(owner);
                } else {
                  userBodyBytes.set(owner, remaining);
                }
              }

              return reserved > 0 ? capacity.release(reserved) : Effect.void;
            })
          )
        );
      });
  }),
  { global: true }
);
