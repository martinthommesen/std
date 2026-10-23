import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { InvalidRequest } from "@std/api/errors/invalid-request";
import type { JsonObject } from "@std/values/json-value";
import { Config, Context, Effect, Layer } from "effect";

import { DeliveryFailed } from "../outbox/delivery-failed.ts";

const MAX_RESPONSE_BYTES = 65_536;
const CALLBACK_TIMEOUT_MS = 10_000;
const BRACKETS = /^\[|\]$/gu;
const GLOBAL_V6 = /^[23][\da-f]{3}:/iu;
const NON_PUBLIC_V4 = new Set([0, 10, 127]);
const PRINTABLE_URL = /^[!-~]+$/u;

const requestPath = (urlText: string): string => {
  const authority = urlText.indexOf("://") + 3;
  const slash = urlText.indexOf("/", authority);
  const query = urlText.indexOf("?", authority);

  const start = Math.min(
    slash === -1 ? urlText.length : slash,
    query === -1 ? urlText.length : query
  );

  const raw = urlText.slice(start);

  return raw.startsWith("/") ? raw : `/${raw}`;
};

const loopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");

const publicV4 = (address: string): boolean => {
  const [first = 0, second = 0] = address.split(".").map(Number);

  if (NON_PUBLIC_V4.has(first) || first >= 224) {
    return false;
  }

  switch (first) {
    case 100: {
      return second < 64 || second > 127;
    }

    case 169: {
      return second !== 254;
    }

    case 172: {
      return second < 16 || second > 31;
    }

    case 192: {
      return second !== 168 && second !== 0;
    }

    case 198: {
      return second !== 18 && second !== 19;
    }

    default: {
      return true;
    }
  }
};

/**
 * Reject non-public destinations, including mapped IPv4 and multicast.
 * @param address - Numeric address resolved for this attempt.
 * @returns Whether the destination is publicly routable.
 */
export const publicAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    return publicV4(address);
  }

  return (
    isIP(address) === 6 &&
    GLOBAL_V6.test(address) &&
    !address.toLowerCase().startsWith("2001:db8:")
  );
};

const validScheme = (url: URL): boolean =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && loopback(url.hostname.replaceAll(BRACKETS, "")));

/**
 * Validate registration syntax; delivery separately resolves and pins DNS.
 * @param text - The exact registered URL.
 * @returns The URL, or a client-safe validation error.
 */
export const callbackUrl = (text: string) =>
  Effect.try({
    catch: () =>
      new InvalidRequest({
        message:
          "A callback must be HTTPS (HTTP only on loopback), without credentials or a fragment.",
        parameter: "callback",
      }),
    try: () => {
      const url = new URL(text);
      const credentials = url.username !== "" || url.password !== "";

      const unsafeText =
        !PRINTABLE_URL.test(text) || text.includes("\\") || text.includes("#");

      if (credentials || unsafeText || !validScheme(url)) {
        throw new Error("Invalid callback");
      }

      return url;
    },
  });

interface Destination {
  readonly url: URL;
  readonly address: string;
  readonly family: number;
  readonly path: string;
}

const failed = () => new DeliveryFailed({ reason: "Callback request failed." });

// A transport adapter uses node:http to pin the checked DNS result while TLS
// verifies the original host. The signal closes the socket on interruption.
const send = (destination: Destination, body: JsonObject, changeId: string) =>
  Effect.callback<boolean, DeliveryFailed>((resume, signal) => {
    const bytes = Buffer.from(JSON.stringify(body));

    const request = (
      destination.url.protocol === "https:" ? httpsRequest : httpRequest
    )(
      destination.url,
      {
        agent: false,
        family: destination.family,
        headers: {
          "content-length": String(bytes.length),
          "content-type": "application/json",
          "idempotency-key": changeId,
        },
        lookup: (_name, _options, done) => {
          done(null, destination.address, destination.family);
        },
        method: "POST",
        path: destination.path,
        signal,
      },
      (response) => {
        let size = 0;
        response.on("data", (chunk: Uint8Array) => {
          size += chunk.byteLength;

          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Callback response too large"));
          }
        });
        response.on("error", () => {
          resume(Effect.fail(failed()));
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resume(
            status >= 200 && status < 300
              ? Effect.succeed(true)
              : Effect.fail(failed())
          );
        });
      }
    );

    request.on("error", () => {
      resume(Effect.fail(failed()));
    });
    request.end(bytes);
  });

/** Callback transport captured by the external delivery handler. */
export class CallbackTransport extends Context.Service<
  CallbackTransport,
  {
    readonly post: (
      callback: string,
      body: JsonObject,
      changeId: string
    ) => Effect.Effect<void, DeliveryFailed>;
  }
>()("std/events/CallbackTransport") {
  static readonly layer = Layer.effect(
    CallbackTransport,
    Effect.gen(function* callbackTransportLayer() {
      const allowPrivate = yield* Config.Boolean(
        "STD_HUB_ALLOW_PRIVATE_ADDRESSES"
      ).pipe(Config.withDefault(false));

      const post = Effect.fn("CallbackTransport.post")(
        function* post(callback: string, body: JsonObject, changeId: string) {
          const url = yield* callbackUrl(callback).pipe(
            Effect.mapError(failed)
          );

          const hostname = url.hostname.replaceAll(BRACKETS, "");
          const path = requestPath(callback);

          const addresses = yield* Effect.tryPromise({
            catch: () =>
              new DeliveryFailed({ reason: "Callback DNS resolution failed." }),
            try: async () =>
              await lookup(hostname, { all: true, order: "verbatim" }),
          });

          const [address] = addresses;

          if (
            address === undefined ||
            (!allowPrivate &&
              addresses.some((entry) => !publicAddress(entry.address)))
          ) {
            return yield* new DeliveryFailed({
              reason: "Callback destination is not public.",
            });
          }

          if (url.protocol === "http:" && !loopback(address.address)) {
            return yield* new DeliveryFailed({
              reason: "Plaintext callback destination is not loopback.",
            });
          }

          return yield* send(
            { address: address.address, family: address.family, path, url },
            body,
            changeId
          ).pipe(Effect.asVoid);
        },
        Effect.timeout(CALLBACK_TIMEOUT_MS),
        Effect.mapError(
          () =>
            new DeliveryFailed({
              reason: "Callback request failed or timed out.",
            })
        )
      );

      return CallbackTransport.of({ post });
    })
  );
}
