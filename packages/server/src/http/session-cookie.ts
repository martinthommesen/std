/**
 * The web app's session cookie on the server (Contracts 3.1; decision
 * 0018): setting it at cookie sign-in, clearing it at sign-out, and the
 * CSRF rule for requests it authenticates (`@std/api/session-cookie`).
 *
 * The cookie is `HttpOnly`, `SameSite=Strict`, limited to `/api`, and
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
 *
 * Migration from the `/api/v1` path: before Step 3 the cookie's path was
 * `/api/v1`. A browser that still holds such a cookie beside a new `/api`
 * one would send both to `/api/v1`, the more specific path first, so a
 * request could carry two different sessions. Therefore every response
 * that sets or clears the cookie also expires a `std_session` cookie with
 * `Path=/api/v1`, and a request that carries more than one `std_session`
 * cookie authenticates by no cookie (which session it meant is ambiguous;
 * a bearer token still works). After the upgrade the first sign-in or
 * sign-out removes the legacy cookie.
 */
import {
  LEGACY_SESSION_COOKIE_PATH,
  SESSION_COOKIE,
  SESSION_COOKIE_PATH,
  WEB_CLIENT,
  WEB_CLIENT_HEADER,
  sessionCookie,
} from "@std/api/session-cookie";
import {
  Config,
  Context,
  Effect,
  Layer,
  Redacted,
  Result,
  Schema,
} from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { fromReadonlyRecord, makeCookie } from "effect/http/Cookies";
import { appendPreResponseHandler } from "effect/http/HttpEffect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { updateCookies } from "effect/http/HttpServerResponse";

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
 * How many `std_session` cookies the raw `Cookie` header carries; the
 * parsed `request.cookies` keeps only one.
 *
 * @param request - The request.
 * @returns The count.
 */
const sessionCookieCount = (request: HttpServerRequest): number => {
  const header = request.headers.cookie ?? "";
  let count = 0;

  for (const pair of header.split(";")) {
    if (pair.split("=")[0]?.trim() === SESSION_COOKIE) {
      count += 1;
    }
  }

  return count;
};

/**
 * Whether the session cookie may authenticate a request: it is the only
 * `std_session` cookie the request carries (several are ambiguous, for
 * example a legacy `/api/v1` cookie beside a new one), and the method is
 * safe or the request carries `STD-Client: web`, which a cross-site form
 * cannot send.
 *
 * @param request - The request.
 * @returns Whether the cookie counts as a credential.
 */
export const cookieMayAuthenticate = (request: HttpServerRequest): boolean =>
  sessionCookieCount(request) <= 1 &&
  (SAFE_METHODS.has(request.method) ||
    request.headers[WEB_CLIENT_HEADER] === WEB_CLIENT);

/** Key of the legacy expiry in a response's cookie record (never sent). */
const LEGACY_KEY = `${SESSION_COOKIE}; Path=${LEGACY_SESSION_COOKIE_PATH}`;

/**
 * Expires the legacy `/api/v1` cookie on the response. Response cookies are
 * keyed by name, so it is stored under its own key; both lines are sent as
 * `Set-Cookie`.
 *
 * @param secure - Whether the cookie is `Secure`.
 * @returns Nothing; the response carries the expired cookie.
 */
const expireLegacyCookie = (secure: boolean) =>
  appendPreResponseHandler((_request, response) =>
    Effect.sync(() => {
      const made = makeCookie(SESSION_COOKIE, "", {
        expires: new Date(0),
        httpOnly: true,
        maxAge: 0,
        path: LEGACY_SESSION_COOKIE_PATH,
        sameSite: "strict",
        secure,
      });

      return updateCookies(response, (cookies) =>
        Result.isSuccess(made)
          ? fromReadonlyRecord({
              ...cookies.cookies,
              [LEGACY_KEY]: made.success,
            })
          : cookies
      );
    })
  );

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

    yield* expireLegacyCookie(cookieIsSecure(mode, request.headers.host));
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
 * cookie session. A session presented as a bearer token leaves the `/api`
 * cookie alone. The legacy `/api/v1` cookie is always expired.
 *
 * @param token - The token of the session that ended.
 * @returns Nothing; the response may clear the cookie.
 */
export const clearSessionCookie = Effect.fn("SessionCookie.clear")(
  function* clearSessionCookie(token: Redacted.Redacted) {
    const request = yield* HttpServerRequest;
    const mode = yield* SessionCookieSecure;

    yield* expireLegacyCookie(cookieIsSecure(mode, request.headers.host));

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
