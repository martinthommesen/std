/**
 * By-ID requests on a record the caller cannot see answer exactly like an
 * unknown ID, whatever their parameters and body (Contracts 3.8, 3.9,
 * `invisible-404`): every check that can fire before visibility is
 * independent of the record, and every check that depends on it comes
 * after visibility.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { asObject, API } from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";

/** One request shape, applied to a record ID. */
interface Probe {
  readonly name: string;
  readonly method: string;
  readonly path: (id: string) => string;
  readonly options: TestRequestOptions;
}

/** How the API spells its by-ID paths and a merge patch's media type. */
interface Api {
  readonly asset: (id: string) => string;
  readonly laptop: (id: string) => string;
  /** The content type of a PATCH body. */
  readonly patchType: string;
}

const PATHS: Api = {
  asset: (id) => `${API.asset}/${id}`,
  laptop: (id) => `${API.laptop}/${id}`,
  patchType: "application/merge-patch+json",
};

const historyPath =
  (path: (id: string) => string, query: string) => (id: string) =>
    `${path(id)}/history?${query}`;

const probes = (token: string, api: Api): readonly Probe[] => [
  {
    method: "GET",
    name: "GET with an unknown field",
    options: { token },
    path: (id) => `${api.laptop(id)}?fields=nosuchfield`,
  },
  {
    method: "GET",
    name: "GET with a bad labels flag",
    options: { token },
    path: (id) => `${api.asset(id)}?labels=perhaps`,
  },
  {
    method: "GET",
    name: "history with an unknown field filter",
    options: { token },
    path: historyPath(api.laptop, "field=nosuchfield"),
  },
  {
    method: "GET",
    name: "history with a bad date",
    options: { token },
    path: historyPath(api.asset, "since=yesterday"),
  },
  {
    method: "GET",
    name: "history with a bad kind and actor",
    options: { token },
    path: historyPath(api.asset, "kind=rename&actor=nobody"),
  },
  {
    method: "PATCH",
    name: "PATCH with an unknown field",
    options: {
      body: { nosuchfield: 1 },
      headers: { "content-type": api.patchType, "if-match": '"1"' },
      token,
    },
    path: (id) => api.laptop(id),
  },
  {
    method: "PATCH",
    name: "PATCH naming class",
    options: {
      body: { class: "x" },
      headers: { "content-type": api.patchType, "if-match": '"1"' },
      token,
    },
    path: (id) => api.asset(id),
  },
  {
    method: "PATCH",
    name: "PATCH with an invalid value and a stale version",
    options: {
      body: { cost: 12.5, name: null },
      headers: { "content-type": api.patchType, "if-match": '"99"' },
      token,
    },
    path: (id) => api.asset(id),
  },
  {
    method: "PATCH",
    name: "PATCH with a body that is not JSON",
    options: {
      headers: { "content-type": api.patchType, "if-match": '"1"' },
      token,
    },
    path: (id) => api.laptop(id),
  },
  {
    method: "PATCH",
    name: "PATCH with a malformed If-Match",
    options: {
      body: { name: "x" },
      headers: { "content-type": api.patchType, "if-match": "1" },
      token,
    },
    path: (id) => api.laptop(id),
  },
  {
    method: "DELETE",
    name: "DELETE with a stale version",
    options: { headers: { "if-match": '"99"' }, token },
    path: (id) => api.asset(id),
  },
  {
    method: "DELETE",
    name: "DELETE without If-Match",
    options: { token },
    path: (id) => api.laptop(id),
  },
];

describe("invisible-identity", () => {
  it("covers every by-ID route", () => {
    const methods = new Set(probes("t", PATHS).map((probe) => probe.method));

    assert.deepStrictEqual([...methods].toSorted(), ["DELETE", "GET", "PATCH"]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an invisible record and an unknown ID give byte-identical responses",
      () =>
        Effect.gen(function* identical() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const unknown = randomUUID();

          for (const probe of probes(bob, PATHS)) {
            const hidden = yield* http.request(
              probe.method,
              probe.path(fixture.records.K),
              probe.options
            );

            const missing = yield* http.request(
              probe.method,
              probe.path(unknown),
              probe.options
            );

            assert.strictEqual(hidden.status, missing.status, probe.name);
            assert.strictEqual(hidden.text, missing.text, probe.name);
          }
        })
    );

    dbTest.effect(
      "on a visible record the same parameters give their own errors",
      () =>
        Effect.gen(function* visible() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const { L } = fixture.records;

          const unknownField = yield* http.get(
            historyPath(PATHS.laptop, "field=nosuchfield")(L),
            { token: bob }
          );

          assert.strictEqual(unknownField.status, 400, unknownField.text);
          assert.strictEqual(asObject(unknownField.json).code, "UnknownField");

          const badDate = yield* http.get(
            historyPath(PATHS.asset, "since=yesterday")(L),
            { token: bob }
          );

          assert.strictEqual(badDate.status, 400, badDate.text);
          assert.strictEqual(asObject(badDate.json).code, "InvalidRequest");
        })
    );
  });
});
