import { IncomingMessage } from "node:http";

import { BodyTooLarge } from "@std/api/errors/body-too-large";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { SESSION_BODY_MAX_BYTES } from "@std/api/session";
import { Effect, Stream, Predicate } from "effect";
import { FindMyWay, HttpRouter } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

import { tmfErrorResponse } from "./api/tmf-error.ts";

/**
 * Tripwire, measured 2026-10-23: helpdesk/v3 set serialized as a change set
 * = 95,538 bytes / 186 operations, largest operation 1,638 bytes
 * (`pnpm --filter \@std/server test test/http-edge-limits.test.ts`); largest existing record-image fixture has 40 text
 * fields (1,391 bytes, recreated with JSON.stringify on 2026-10-23). Also allow a maximum longText (1,000,000 code points), including
 * JSON's worst-case 12-byte escaped supplementary characters (12,000,000 bytes).
 * 64 MiB leaves over five times that single-field transport requirement.
 */
export const BODY_MAX_BYTES = 67_108_864;

/**
 * The request byte limit, including sign-in's smaller schema budget.
 * @param request - Incoming request.
 * @param config - Application router configuration.
 * @returns Maximum body bytes.
 */
const bodyLimitOf = (
  request: HttpServerRequest,
  config: Partial<FindMyWay.RouterConfig>
): number => {
  // Use the application's router semantics, including encoded path segments,
  // case and duplicate/trailing slashes. Raw URL comparisons miss aliases.
  const routes = FindMyWay.make<number>(config);
  routes.on("POST", "/api/v1/session", SESSION_BODY_MAX_BYTES);

  const lookup = routes.find.bind(routes);

  return lookup(request.method, request.originalUrl)?.handler ?? BODY_MAX_BYTES;
};

const tooLarge = (limit: number, received: number | string) =>
  new BodyTooLarge({
    limit,
    message: `body_max_bytes=${limit}; received ${received} bytes. Reduce the request body.`,
    received,
  });

const unreadable = () =>
  new InvalidRequest({
    message: "The body could not be read.",
    parameter: "body",
  });

// The default Effect Node reader destroys the socket on early termination.
// Paused-mode reads let overflow send 413 before Connection: close takes effect.
const nodeBody = (source: IncomingMessage, limit: number) =>
  Effect.callback<string, BodyTooLarge | InvalidRequest>((resume) => {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let done = false;

    const fail = (error: BodyTooLarge | InvalidRequest) => {
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
  const limit = bodyLimitOf(request, yield* HttpRouter.RouterConfig);
  const { source } = request;

  if (source instanceof IncomingMessage) {
    return yield* nodeBody(source, limit);
  }

  if (source instanceof Request && source.body === null) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  yield* request.stream.pipe(
    Stream.mapError(unreadable),
    Stream.runForEach((chunk) => {
      received += chunk.byteLength;

      if (received > limit) {
        return Effect.fail(tooLarge(limit, received));
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
const bodies = new WeakMap<
  object,
  Effect.Effect<string, BodyTooLarge | InvalidRequest>
>();

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
  (app) =>
    Effect.gen(function* bodyLimits() {
      const request = yield* HttpServerRequest;
      const limit = bodyLimitOf(request, yield* HttpRouter.RouterConfig);
      const length = Number(request.headers["content-length"] ?? 0);

      if (length > limit) {
        return tmfErrorResponse(
          tooLarge(limit, request.headers["content-length"] ?? length)
        );
      }

      return yield* app;
    }),
  { global: true }
);
