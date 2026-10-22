/**
 * The web app's session cookie (Contracts 3.1, 6.1; decision 0018).
 *
 * `POST /api/v1/auth/cookie-sign-in` puts the same session token that
 * `POST /api/v1/auth/sign-in` returns into an HTTP-only, `SameSite=Strict`
 * cookie limited to the API's path, so the browser sends it and page
 * scripts never see it. The server accepts the cookie wherever it accepts
 * `Authorization: Bearer <token>`; a bearer token wins when a request
 * carries both.
 *
 * CSRF: a request authenticated by the cookie whose method is not GET,
 * HEAD or OPTIONS must carry `STD-Client: web`. Without it the cookie is
 * not a credential and the request is `401 Unauthenticated`. A page on
 * another site can neither set that header on a form post nor send it with
 * `fetch` without a CORS preflight, which STD never approves.
 */
import { HttpApiSecurity } from "effect/http-api";

/** The cookie's name. */
export const SESSION_COOKIE = "std_session";

/**
 * The cookie's path: the API only, never the web app's pages. It is `/api`
 * from Step 3, so one session serves `/api/v1` and `/api/v2` while both
 * exist (Contracts 10.1).
 */
export const SESSION_COOKIE_PATH = "/api";

/**
 * The request header that marks a request as sent by STD's own web app
 * (lower case, as Node delivers header names).
 */
export const WEB_CLIENT_HEADER = "std-client";

/** The value of {@link WEB_CLIENT_HEADER}. */
export const WEB_CLIENT = "web";

/** The cookie as an `HttpApi` security scheme. */
export const sessionCookie = HttpApiSecurity.apiKey({
  in: "cookie",
  key: SESSION_COOKIE,
});
