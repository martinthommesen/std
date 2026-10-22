/**
 * The web app's session cookie on the server (Contracts 3.1; decision
 * 0018): setting it at cookie sign-in, clearing it at sign-out, and the
 * CSRF rule for requests it authenticates (`@std/api/session-cookie`).
 *
 * The cookie is `HttpOnly`, `SameSite=Strict`, limited to `/api/v1`, and
 * expires with its session. Whether it is `Secure` follows
 * `STD_SESSION_COOKIE_SECURE`:
 *
 * - `auto` (the default): `Secure` unless the request's `Host` is a
 *   loopback name (`localhost`, `127.0.0.0/8`, `[::1]`), where browsers
 *   reach `std serve` over plain HTTP. A proxy that terminates TLS for a
 *   public name passes that name, so the cookie is `Secure` there.
 * - `always`: always `Secure`, for a proxy that forwards a loopback `Host`.
 * - `never`: never `Secure`, only for a plain-HTTP deployment on a
 *   non-loopback address (a browser drops `Secure` cookies over HTTP, so
 *   sign-in would not stick). Anyone on the network can read the cookie.
 */
import {
  SESSION_COOKIE,
  SESSION_COOKIE_PATH,
  WEB_CLIENT,
  WEB_CLIENT_HEADER,
  sessionCookie,
} from "@std/api/session-cookie";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

/** When the session cookie is `Secure`. */
export const SessionCookieSecureSchema = Schema.Literals([
  "auto",
  "always",
  "never",
]);

/** When the session cookie is `Secure`. */
export type SessionCookieSecureMode = typeof SessionCookieSecureSchema.Type;

/** When the session cookie is `Secure`; `auto` unless configured. */
export const SessionCookieSecure = Context.Reference<SessionCookieSecureMode>(
  "@std/server/http/session-cookie/SessionCookieSecure",
  { defaultValue: () => "auto" }
);

/** Reads `STD_SESSION_COOKIE_SECURE` (`auto`, `always` or `never`). */
export const sessionCookieSecureFromEnv = Layer.effect(
  SessionCookieSecure,
  Effect.gen(function* readSessionCookieSecure() {
    return yield* Config.schema(
      SessionCookieSecureSchema,
      "STD_SESSION_COOKIE_SECURE"
    ).pipe(Config.withDefault("auto"));
  })
);

const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/u;

const PORT_SUFFIX = /:\d+$/u;

/**
 * Whether a `Host` header names this machine.
 *
 * @param host - The header, such as `localhost:8080` or `[::1]:8080`.
 * @returns Whether its name is `localhost`, in `127.0.0.0/8` or `[::1]`.
 */
export const isLoopbackHost = (host: string | undefined): boolean => {
  const name = (host ?? "").toLowerCase().replace(PORT_SUFFIX, "");

  return name === "localhost" || name === "[::1]" || IPV4_LOOPBACK.test(name);
};

/**
 * Whether the cookie a response sets for a request is `Secure`.
 *
 * @param mode - The configured mode.
 * @param host - The request's `Host` header.
 * @returns Whether to set `Secure`.
 */
export const cookieIsSecure = (
  mode: SessionCookieSecureMode,
  host: string | undefined
): boolean => {
  if (mode === "auto") {
    return !isLoopbackHost(host);
  }

  return mode === "always";
};

/** Methods a request may use with the cookie alone (RFC 9110 safe methods). */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether the session cookie may authenticate a request: a safe method, or
 * an unsafe one that carries `STD-Client: web`, which a cross-site form
 * cannot send.
 *
 * @param request - The request.
 * @returns Whether the cookie counts as a credential.
 */
export const cookieMayAuthenticate = (request: HttpServerRequest): boolean =>
  SAFE_METHODS.has(request.method) ||
  request.headers[WEB_CLIENT_HEADER] === WEB_CLIENT;

/**
 * Sets the session cookie on the response to the current request.
 *
 * @param token - The session token.
 * @param expiresAt - When the session expires, in epoch milliseconds.
 * @returns Nothing; the response carries the cookie.
 */
export const setSessionCookie = Effect.fn("SessionCookie.set")(
  function* setSessionCookie(token: Redacted.Redacted, expiresAt: number) {
    const request = yield* HttpServerRequest;
    const mode = yield* SessionCookieSecure;

    yield* HttpApiBuilder.securitySetCookie(sessionCookie, token, {
      expires: new Date(expiresAt),
      httpOnly: true,
      path: SESSION_COOKIE_PATH,
      sameSite: "strict",
      secure: cookieIsSecure(mode, request.headers.host),
    });
  }
);

/**
 * Clears the session cookie when it carried this token: sign-out of a
 * cookie session. A session presented as a bearer token leaves the cookie
 * alone.
 *
 * @param token - The token of the session that ended.
 * @returns Nothing; the response may clear the cookie.
 */
export const clearSessionCookie = Effect.fn("SessionCookie.clear")(
  function* clearSessionCookie(token: Redacted.Redacted) {
    const request = yield* HttpServerRequest;
    const mode = yield* SessionCookieSecure;

    if (request.cookies[SESSION_COOKIE] !== Redacted.value(token)) {
      return;
    }

    yield* HttpApiBuilder.securitySetCookie(sessionCookie, "", {
      expires: new Date(0),
      httpOnly: true,
      maxAge: 0,
      path: SESSION_COOKIE_PATH,
      sameSite: "strict",
      secure: cookieIsSecure(mode, request.headers.host),
    });
  }
);
