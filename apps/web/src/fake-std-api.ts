import { authenticationClient, makeStdClient } from "@std/api/client";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { StdApi } from "./std-client.ts";

/** One canned answer of the fake server. */
export interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
}

/** A request the fake server received. */
export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const BASE_URL = "http://std.test";

const decoder = new TextDecoder();

/**
 * The real typed client over a fake server that answers by path, for
 * testing what a Command does with each answer. Requests are recorded.
 *
 * @param answers - The answer for each path, such as `/api/v1/auth/me`.
 * @returns The `StdApi` layer and the requests it received.
 */
export const fakeStdApi = (answers: Readonly<Record<string, FakeAnswer>>) => {
  const seen: SeenRequest[] = [];

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const answer = answers[path] ?? { status: 599 };

      seen.push({
        body:
          request.body._tag === "Uint8Array"
            ? decoder.decode(request.body.body)
            : "",
        headers: request.headers,
        method: request.method,
        path,
      });

      return HttpClientResponse.fromWeb(
        request,
        new Response(
          answer.body === undefined ? null : JSON.stringify(answer.body),
          {
            headers: { "content-type": "application/json" },
            status: answer.status,
          }
        )
      );
    })
  );

  const layer = Layer.effect(
    StdApi,
    makeStdClient({ baseUrl: BASE_URL, webClient: true }).pipe(
      Effect.provide(authenticationClient())
    )
  ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));

  return { layer, seen };
};
