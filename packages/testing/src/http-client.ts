/**
 * An HTTP test client for the STD API: the server's real HTTP application
 * (`HttpAppLayer`: routing, middleware, handlers, error encoding and the
 * revision header) as a web handler over the test database, so tests see
 * exact status codes, headers and body bytes without opening a port.
 *
 * ```ts
 * const http = yield* TestHttpClient;
 * const token = yield* http.signIn("bob", "bob-password");
 * const response = yield* http.get("/api/v1/acmeAsset", { token });
 * const cookie = yield* http.cookieSignIn("bob", "bob-password");
 * const viaCookie = yield* http.get("/api/v1/session/current", { cookie });
 * ```
 */
import { Session } from "@std/api/session";
import {
  SESSION_COOKIE,
  WEB_CLIENT,
  WEB_CLIENT_HEADER,
} from "@std/api/session-cookie";
import { HttpAppLayer, tmfRoutes } from "@std/server/http/app";
import type { TmfRegistry } from "@std/server/http/tmf/context";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Context, Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServer } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { checkApiExchange } from "./api-contract.ts";
import { checkTmfExchange, pinnedContracts } from "./tmf-oas-contract.ts";
import type { TmfContract } from "./tmf-oas-contract.ts";

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
  /**
   * A `fetch` over the same application, for typed clients built with
   * `FetchHttpClient` (`FetchHttpClient.Fetch`). Every response is checked
   * as `request`'s are (an `/api/v1` answer against the shared definition,
   * a TMF API answer against its pinned OpenAPI document), on a clone, so
   * callers keep normal `Response` semantics; a mismatch rejects the call.
   */
  readonly fetch: typeof globalThis.fetch;
  /** Signs in and returns the session token; dies when sign-in fails. */
  readonly signIn: (login: string, password: string) => Effect.Effect<string>;
  /**
   * Signs in as the web app does (`POST /api/v1/session` with the token in the cookie) and returns
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
const CONTENT_TYPE_HEADER = "content-type";

const decodeSignIn = Schema.decodeUnknownEffect(Session);

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
    if (!headers.has(CONTENT_TYPE_HEADER)) {
      headers.set(CONTENT_TYPE_HEADER, "application/json");
    }

    init.body = text;
  }

  return init;
};

/** What a test client serves besides the server's own application. */
export interface TestHttpOptions {
  /** TMF API mappings to serve too (test fixtures). */
  readonly tmfApis: TmfRegistry;
  /** Their contracts, checked like the pinned APIs' (`tmf-oas-contract`). */
  readonly contracts: readonly TmfContract[];
}

/**
 * Builds the client: the server's application, plus fixture TMF APIs.
 *
 * @param options - Fixture TMF APIs and their contracts.
 * @returns The client.
 */
const makeTestHttpClient = Effect.fnUntraced(function* makeTestHttpClient(
  options: TestHttpOptions
) {
  const routes =
    options.tmfApis.length === 0
      ? HttpAppLayer
      : Layer.merge(HttpAppLayer, tmfRoutes(options.tmfApis));

  const contracts = [...pinnedContracts(), ...options.contracts];

  const app = yield* HttpRouter.toHttpEffect(
    routes.pipe(Layer.provideMerge(HttpServer.layerServices))
  );

  const context = yield* Effect.context();

  const handler: (request: Request) => Promise<Response> =
    HttpEffect.toWebHandlerWith<never, HttpServerRequest | Scope.Scope>(
      context
    )(app);

  // Every exchange, through `request` or `fetch`, is checked against what
  // it must be: an `/api/v1` answer against the shared definition (and so
  // `/api/v1/openapi.json`), a TMF API answer against its pinned OpenAPI
  // document (`tmf-oas-contract`, Contracts 11.1). A mismatch is a defect.
  const checkExchange = (exchange: {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly text: string;
    readonly json: JsonValue | undefined;
    readonly contentType: string | null;
  }) =>
    Effect.all([
      checkApiExchange(exchange),
      checkTmfExchange(contracts, exchange),
    ]).pipe(
      Effect.mapError((problem) => new Error(problem)),
      Effect.orDie,
      Effect.asVoid
    );

  const request = Effect.fn("TestHttpClient.request")(function* request(
    method: string,
    path: string,
    requestOptions: TestRequestOptions = {}
  ) {
    const headers = new Headers(requestOptions.headers);

    if (requestOptions.token !== undefined) {
      headers.set("authorization", `Bearer ${requestOptions.token}`);
    }

    if (requestOptions.cookie !== undefined) {
      headers.append("cookie", `${SESSION_COOKIE}=${requestOptions.cookie}`);

      if (requestOptions.webClient !== false) {
        headers.set(WEB_CLIENT_HEADER, WEB_CLIENT);
      }
    }

    const init = requestInit(method, headers, requestOptions);

    const response = yield* Effect.promise(
      async () => await handler(new Request(`${BASE}${path}`, init))
    );

    const text = yield* Effect.promise(async () => await response.text());
    const json = bodyJson(text);

    yield* checkExchange({
      contentType: response.headers.get(CONTENT_TYPE_HEADER),
      json,
      method,
      path,
      status: response.status,
      text,
    });

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
    const response = yield* request("POST", "/api/v1/session", {
      body: { login, password, tokenDelivery: "body" },
    });

    const session = yield* decodeSignIn(response.json).pipe(
      Effect.mapError(
        () => new Error(`sign-in as ${login} failed with ${response.status}`)
      ),
      Effect.orDie
    );

    return session.token ?? "";
  });

  const cookieSignIn = Effect.fn("TestHttpClient.cookieSignIn")(
    function* cookieSignIn(login: string, password: string) {
      const response = yield* request("POST", "/api/v1/session", {
        body: { login, password, tokenDelivery: "cookie" },
        headers: { [WEB_CLIENT_HEADER]: WEB_CLIENT },
      });

      const token = setCookieValue(response, SESSION_COOKIE);

      if (response.status !== 201 || token === undefined) {
        return yield* Effect.die(
          new Error(`cookie sign-in as ${login} failed with ${response.status}`)
        );
      }

      return token;
    }
  );

  // `fetch` keeps normal Response semantics: a clone is read and checked,
  // and a mismatch rejects the call.
  const fetchOver: typeof globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
    const response = await handler(outgoing);
    const text = await response.clone().text();

    await Effect.runPromise(
      checkExchange({
        contentType: response.headers.get(CONTENT_TYPE_HEADER),
        json: bodyJson(text),
        method: outgoing.method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        text,
      })
    );

    return response;
  };

  const client: TestHttpClientApi = {
    cookieSignIn,
    fetch: fetchOver,
    get: (path, requestOptions) => request("GET", path, requestOptions),
    request,
    signIn,
  };

  return client;
});

/** The HTTP test client of the current test database. */
export class TestHttpClient extends Context.Service<
  TestHttpClient,
  TestHttpClientApi
>()("@std/testing/http-client/TestHttpClient") {
  /** Builds the server's HTTP application over the services in context. */
  static readonly layer = Layer.effect(
    TestHttpClient,
    Effect.suspend(() => makeTestHttpClient({ contracts: [], tmfApis: [] }))
  );

  /**
   * The client of the server's application plus fixture TMF APIs.
   *
   * @param options - The fixture APIs and their contracts.
   * @returns The layer.
   */
  static readonly layerWith = (options: TestHttpOptions) =>
    Layer.effect(TestHttpClient, makeTestHttpClient(options));
}
