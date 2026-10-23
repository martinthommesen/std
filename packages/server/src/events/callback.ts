import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";

import { InvalidRequest } from "@std/api/errors/invalid-request";
import type { JsonObject } from "@std/values/json-value";
import { Config, Context, Effect, Layer } from "effect";

import { DeliveryFailed } from "../outbox/delivery-failed.ts";

const MAX_RESPONSE_BYTES = 65_536;
const CALLBACK_TIMEOUT_MS = 10_000;
const BRACKETS = /^\[|\]$/gu;
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
  hostname === "localhost" ||
  hostname === "::1" ||
  (isIP(hostname) === 4 && hostname.startsWith("127."));

const deniedV4 = new BlockList();

for (const [address, prefix] of [
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["0.0.0.0", 8],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["10.0.0.0", 8],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["100.64.0.0", 10],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["127.0.0.0", 8],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["169.254.0.0", 16],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["172.16.0.0", 12],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["192.0.0.0", 24],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Documentation addresses, never a callback destination.
  ["192.0.2.0", 24],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved ranges denied by the callback policy.
  ["192.168.0.0", 16],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Benchmark addresses, never a callback destination.
  ["198.18.0.0", 15],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Documentation addresses, never a callback destination.
  ["198.51.100.0", 24],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Documentation addresses, never a callback destination.
  ["203.0.113.0", 24],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Multicast and reserved IPv4 are never callback destinations.
  ["224.0.0.0", 3],
] as const) {
  deniedV4.addSubnet(address, prefix, "ipv4");
}

const publicV4 = (address: string): boolean => !deniedV4.check(address, "ipv4");

const deniedV6 = new BlockList();
const globalV6 = new BlockList();
const reachableSpecialV6 = new BlockList();

// Numeric global unicast membership (RFC 4291 §2.5.4).
// oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric global-unicast classification; never contacted.
globalV6.addSubnet("2000::", 3, "ipv6");

// IANA IPv6 Special-Purpose Address Registry, read 2026-10-23:
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// 2001::/23 is non-global except these explicitly globally reachable entries.
// Ranges outside 2000::/3 already fail globalV6; transition mechanisms below
// remain forbidden even with private callbacks enabled.
for (const [address, prefix] of [
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric IANA address-policy entry; never contacted.
  ["2001:1::1", 128],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric IANA address-policy entry; never contacted.
  ["2001:1::2", 128],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric IANA address-policy entry; never contacted.
  ["2001:1::3", 128],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric IANA address-policy entry; never contacted.
  ["2001:3::", 32],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric IANA address-policy entry; never contacted.
  ["2001:4:112::", 48],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric IANA address-policy entry; never contacted.
  ["2001:20::", 28],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric IANA address-policy entry; never contacted.
  ["2001:30::", 28],
] as const) {
  reachableSpecialV6.addSubnet(address, prefix, "ipv6");
}

for (const [address, prefix] of [
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved destination ranges are denied, never contacted.
  ["2002::", 16],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved destination ranges are denied, never contacted.
  ["2001::", 23],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved destination ranges are denied, never contacted.
  ["2001:db8::", 32],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved destination ranges are denied, never contacted.
  ["3fff::", 20],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- NAT64 must not bypass blocked embedded IPv4 destinations.
  ["64:ff9b::", 96],
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Local-use NAT64 also carries embedded IPv4 destinations.
  ["64:ff9b:1::", 48],
] as const) {
  deniedV6.addSubnet(address, prefix, "ipv6");
}

const alwaysDenied = new BlockList();

// oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved destination ranges are denied, never contacted.
alwaysDenied.addSubnet("169.254.0.0", 16, "ipv4");

// oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Alibaba metadata remains denied with private callbacks enabled.
alwaysDenied.addAddress("100.100.100.200", "ipv4");

// IPv4-compatible IPv6 is deprecated and must not bypass IPv4 metadata rules.
// oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Deny every compatible encoding, including hexadecimal forms.
const compatibleV6 = new BlockList();

compatibleV6.addSubnet("::", 96, "ipv6");

// oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved destination ranges are denied, never contacted.
alwaysDenied.addSubnet("fe80::", 10, "ipv6");

// oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reserved destination ranges are denied, never contacted.
alwaysDenied.addAddress("fd00:ec2::254", "ipv6");

/**
 * Reject non-public destinations, including IPv6 transition mechanisms.
 * @param address - Numeric address resolved for this attempt.
 * @returns Whether the destination is publicly routable.
 */
export const publicAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    return publicV4(address);
  }

  if (isIP(address) !== 6 || address.includes("%")) {
    return false;
  }

  const canonical = new URL(`https://[${address}]/`).hostname.replaceAll(
    BRACKETS,
    ""
  );

  return (
    globalV6.check(canonical, "ipv6") &&
    (!deniedV6.check(canonical, "ipv6") ||
      reachableSpecialV6.check(canonical, "ipv6"))
  );
};

/**
 * Apply the same opt-in policy at registration and at each delivery attempt.
 * @param address - Numeric destination.
 * @param allowPrivate - Explicit development/private network opt-in.
 * @returns Whether the address is allowed.
 */
export const allowedAddress = (
  address: string,
  allowPrivate: boolean
): boolean => {
  const family = isIP(address);

  if (family === 0 || address.includes("%")) {
    return false;
  }

  const compatible =
    family === 6 &&
    compatibleV6.check(address, "ipv6") &&
    new URL(`https://[${address}]/`).hostname !== "[::1]";

  const disallowedV6 =
    family === 6 &&
    deniedV6.check(address, "ipv6") &&
    !reachableSpecialV6.check(address, "ipv6");

  if (
    disallowedV6 ||
    compatible ||
    alwaysDenied.check(address, family === 4 ? "ipv4" : "ipv6")
  ) {
    return false;
  }

  return allowPrivate || publicAddress(address);
};

const privateAddresses = Config.Boolean("STD_HUB_ALLOW_PRIVATE_ADDRESSES").pipe(
  Config.withDefault(false)
);

const validScheme = (url: URL): boolean =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && loopback(url.hostname.replaceAll(BRACKETS, "")));

/**
 * Validate registration syntax; delivery separately resolves and pins DNS.
 * @param text - The exact registered URL.
 * @returns The URL, or a client-safe validation error.
 */
const parseCallbackUrl = (text: string) =>
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

/** Validate a callback against the current literal-address policy. */
export const callbackUrl = Effect.fn("Callback.validate")(function* callbackUrl(
  text: string
) {
  const url = yield* parseCallbackUrl(text);
  const allowPrivate = yield* privateAddresses.pipe(Effect.orDie);
  const hostname = url.hostname.replaceAll(BRACKETS, "");

  if (
    (isIP(hostname) !== 0 && !allowedAddress(hostname, allowPrivate)) ||
    (hostname === "localhost" && !allowPrivate)
  ) {
    return yield* new InvalidRequest({
      message: "Callback destination is not allowed by the address policy.",
      parameter: "callback",
    });
  }

  return url;
});

/**
 * Resolve once, validate every answer, and pin subsequent socket lookups.
 * @param hostname - Registered hostname without IPv6 brackets.
 * @param allowPrivate - Explicit private network policy.
 * @param resolve - DNS boundary, replaceable by deterministic tests.
 * @returns The checked address and socket lookup function.
 */
export const resolveCallbackAddress = Effect.fn("Callback.resolveAddress")(
  function* resolveCallbackAddress(
    hostname: string,
    allowPrivate: boolean,
    resolve: (hostname: string) => Promise<readonly LookupAddress[]>
  ) {
    const addresses =
      isIP(hostname) === 0
        ? yield* Effect.tryPromise({
            catch: () =>
              new DeliveryFailed({ reason: "Callback DNS resolution failed." }),
            try: async () => await resolve(hostname),
          })
        : [{ address: hostname, family: isIP(hostname) }];

    const [address] = addresses;

    if (
      address === undefined ||
      addresses.some((entry) => !allowedAddress(entry.address, allowPrivate))
    ) {
      return yield* new DeliveryFailed({
        reason: "Callback destination is not public.",
      });
    }

    const pinned: LookupFunction = (_hostname, options, done) => {
      if (options.all === true) {
        done(null, [address]);
      } else {
        done(null, address.address, address.family);
      }
    };

    return { ...address, lookup: pinned };
  }
);

interface Destination {
  readonly url: URL;
  readonly address: string;
  readonly family: number;
  readonly path: string;
  readonly lookup: LookupFunction;
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
        lookup: destination.lookup,
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
      const allowPrivate = yield* privateAddresses;

      if (allowPrivate) {
        yield* Effect.logWarning(
          "Private hub callback addresses are enabled; link-local and metadata destinations remain blocked."
        );
      }

      const post = Effect.fn("CallbackTransport.post")(
        function* post(callback: string, body: JsonObject, changeId: string) {
          const url = yield* parseCallbackUrl(callback).pipe(
            Effect.mapError(failed)
          );

          const hostname = url.hostname.replaceAll(BRACKETS, "");
          const path = requestPath(callback);

          const address = yield* resolveCallbackAddress(
            hostname,
            allowPrivate,
            async (name) => await lookup(name, { all: true, order: "verbatim" })
          );

          if (url.protocol === "http:" && !loopback(address.address)) {
            return yield* new DeliveryFailed({
              reason: "Plaintext callback destination is not loopback.",
            });
          }

          return yield* send(
            {
              address: address.address,
              family: address.family,
              lookup: address.lookup,
              path,
              url,
            },
            body,
            changeId
          ).pipe(Effect.asVoid);
        },
        Effect.timeout(CALLBACK_TIMEOUT_MS),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new DeliveryFailed({
              reason: "Callback request timed out.",
            })
          )
        )
      );

      return CallbackTransport.of({ post });
    })
  );
}
