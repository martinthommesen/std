/**
 * An HTTP test client for the STD API: the server's real HTTP application
 * (`HttpAppLayer`: routing, middleware, handlers, error encoding and the
 * revision header) as a web handler over the test database, so tests see
 * exact status codes, headers and body bytes without opening a port.
 *
 * ```ts
 * const http = yield* TestHttpClient;
 * const token = yield* http.signIn("bob", "bob-password");
 * const response = yield* http.get("/api/v1/tables/acme.asset/records", { token });
 * const cookie = yield* http.cookieSignIn("bob", "bob-password");
 * const viaCookie = yield* http.get("/api/v1/auth/me", { cookie });
 * ```
 */
import { SignInResponseSchema } from "@std/api/auth";
import {
  SESSION_COOKIE,
  WEB_CLIENT,
  WEB_CLIENT_HEADER,
} from "@std/api/session-cookie";
import { HttpAppLayer } from "@std/server/http/app";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Context, Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServer } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { checkV2Exchange } from "./v2-contract.ts";

/** A response as the client received it. */
export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The exact body text. */
  readonly text: string;
  /** The body as JSON, or undefined when it is empty or not JSON. */
  readonly json: JsonValue | undefined;
}

/** Options of one request. */
export interface TestRequestOptions {
  /** A session token, sent as `Authorization: Bearer <token>`. */
  readonly token?: string;
  /**
   * A session token, sent as the web app's session cookie; also sends
   * `STD-Client: web` unless `webClient` is `false` (decision 0018).
   */
  readonly cookie?: string;
  /** Whether a request with `cookie` sends `STD-Client: web` (default true). */
  readonly webClient?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  /** A JSON body. */
  readonly body?: JsonValue;
  /** A body sent as is with `content-type: application/json`, such as malformed JSON. */
  readonly rawBody?: string;
}

/** The client. */
export interface TestHttpClientApi {
  readonly request: (
    method: string,
    path: string,
    options?: TestRequestOptions
  ) => Effect.Effect<TestResponse>;
  readonly get: (
    path: string,
    options?: TestRequestOptions
  ) => Effect.Effect<TestResponse>;
  /** Signs in and returns the session token; dies when sign-in fails. */
  readonly signIn: (login: string, password: string) => Effect.Effect<string>;
  /**
   * Signs in as the web app does (`POST /auth/cookie-sign-in`) and returns
   * the token from the session cookie it sets; dies when sign-in fails.
   */
  readonly cookieSignIn: (
    login: string,
    password: string
  ) => Effect.Effect<string>;
}

/**
 * The value of a cookie that a response sets.
 *
 * @param response - The response.
 * @param name - The cookie's name.
 * @returns The value, or undefined when the response does not set it.
 */
export const setCookieValue = (
  response: TestResponse,
  name: string
): string | undefined => {
  for (const line of response.headers.getSetCookie()) {
    // The legacy `/api/v1` expiry that rides along is not the session.
    if (line.includes("; Path=/api/v1;")) {
      continue;
    }

    const [pair = ""] = line.split(";");
    const separator = pair.indexOf("=");

    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }

  return undefined;
};

const BASE = "http://std.test";

const decodeSignIn = Schema.decodeUnknownEffect(SignInResponseSchema);

const bodyJson = (text: string): JsonValue | undefined => {
  const parsed = parseJson(text);

  return parsed.ok ? parsed.value : undefined;
};

const requestInit = (
  method: string,
  headers: Headers,
  options: TestRequestOptions
): RequestInit => {
  const init: RequestInit = { headers, method };

  const text =
    options.body === undefined ? options.rawBody : JSON.stringify(options.body);

  if (text !== undefined) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    init.body = text;
  }

  return init;
};

/** The HTTP test client of the current test database. */
export class TestHttpClient extends Context.Service<
  TestHttpClient,
  TestHttpClientApi
>()("@std/testing/http-client/TestHttpClient") {
  /** Builds the server's HTTP application over the services in context. */
  static readonly layer = Layer.effect(
    TestHttpClient,
    Effect.gen(function* buildTestHttpClient() {
      const app = yield* HttpRouter.toHttpEffect(
        HttpAppLayer.pipe(Layer.provideMerge(HttpServer.layerServices))
      );

      const context = yield* Effect.context();

      const handler: (request: Request) => Promise<Response> =
        HttpEffect.toWebHandlerWith<never, HttpServerRequest | Scope.Scope>(
          context
        )(app);

      const request = Effect.fn("TestHttpClient.request")(function* request(
        method: string,
        path: string,
        options: TestRequestOptions = {}
      ) {
        const headers = new Headers(options.headers);

        if (options.token !== undefined) {
          headers.set("authorization", `Bearer ${options.token}`);
        }

        if (options.cookie !== undefined) {
          headers.append("cookie", `${SESSION_COOKIE}=${options.cookie}`);

          if (options.webClient !== false) {
            headers.set(WEB_CLIENT_HEADER, WEB_CLIENT);
          }
        }

        const init = requestInit(method, headers, options);

        const response = yield* Effect.promise(
          async () => await handler(new Request(`${BASE}${path}`, init))
        );

        const text = yield* Effect.promise(async () => await response.text());
        const json = bodyJson(text);

        // Every `/api/v2` answer must be what the shared definition (and so
        // `/api/v2/openapi.json`) documents for it.
        yield* checkV2Exchange({
          json,
          method,
          path,
          status: response.status,
          text,
        }).pipe(
          Effect.mapError((problem) => new Error(problem)),
          Effect.orDie
        );

        return {
          headers: response.headers,
          json,
          status: response.status,
          text,
        } satisfies TestResponse;
      });

      const signIn = Effect.fn("TestHttpClient.signIn")(function* signIn(
        login: string,
        password: string
      ) {
        const response = yield* request("POST", "/api/v1/auth/sign-in", {
          body: { login, password },
        });

        const session = yield* decodeSignIn(response.json).pipe(
          Effect.mapError(
            () =>
              new Error(`sign-in as ${login} failed with ${response.status}`)
          ),
          Effect.orDie
        );

        return session.token;
      });

      const cookieSignIn = Effect.fn("TestHttpClient.cookieSignIn")(
        function* cookieSignIn(login: string, password: string) {
          const response = yield* request(
            "POST",
            "/api/v1/auth/cookie-sign-in",
            {
              body: { login, password },
              headers: { [WEB_CLIENT_HEADER]: WEB_CLIENT },
            }
          );

          const token = setCookieValue(response, SESSION_COOKIE);

          if (response.status !== 200 || token === undefined) {
            return yield* Effect.die(
              new Error(
                `cookie sign-in as ${login} failed with ${response.status}`
              )
            );
          }

          return token;
        }
      );

      return TestHttpClient.of({
        cookieSignIn,
        get: (path, options) => request("GET", path, options),
        request,
        signIn,
      });
    })
  );
}
