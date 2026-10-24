import type { Schema } from "effect";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { StdApi } from "./std-client.ts";

/** One canned answer of the fake server. */
export interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
  /** Response headers, such as `std-schema-revision`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A request the fake server received. */
export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  /** The query parameters, decoded. */
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const BASE_URL = "http://std.test";

const decoder = new TextDecoder();

/**
 * The real typed client over a fake server that answers by method and
 * path (`DELETE /api/v1/session/current`) or by path alone
 * (`/api/v1/tableMetadata`), for testing what a Command does with each
 * answer. Requests are recorded.
 *
 * @param answers - The answer for each method and path, or path.
 * @returns The `StdApi` layer and the requests it received.
 */
export const fakeStdApi = (answers: Readonly<Record<string, FakeAnswer>>) => {
  const seen: SeenRequest[] = [];

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url, BASE_URL);
      const path = decodeURIComponent(url.pathname);

      const answer = answers[`${request.method} ${path}`] ??
        answers[path] ?? { status: 599 };

      seen.push({
        body:
          request.body._tag === "Uint8Array"
            ? decoder.decode(request.body.body)
            : "",
        headers: request.headers,
        method: request.method,
        path,
        query: Object.fromEntries([
          ...url.searchParams.entries(),
          ...request.urlParams.params.map(
            ([name, value]) =>
              [name, Redacted.isRedacted(value) ? "<redacted>" : value] as const
          ),
        ]),
      });

      return HttpClientResponse.fromWeb(
        request,
        new Response(
          answer.body === undefined ? null : JSON.stringify(answer.body),
          {
            headers: {
              "content-type": "application/json",
              ...answer.headers,
            },
            status: answer.status,
          }
        )
      );
    })
  );

  const layer = StdApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
  );

  return { layer, seen };
};

/**
 * A TMF `Error` answer as the API sends one (Contracts 10.6).
 *
 * @param code - The error's code, such as `Unauthenticated`.
 * @param status - The HTTP status.
 * @param details - Extension members, such as `currentRevision`.
 * @returns The answer.
 */
export const tmfError = (
  code: string,
  status: number,
  details: Readonly<Record<string, Schema.Json>> = {}
): FakeAnswer => ({
  body: {
    "@baseType": "Error",
    "@type": code,
    code,
    reason: code,
    status: String(status),
    ...details,
  },
  status,
});
