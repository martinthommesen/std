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
import { readsTestLayer, recordPath, tagOf } from "./reads-support.ts";
import { asObject, V2 } from "./v2-support.ts";
import { ASSET, LAPTOP } from "./writes-support.ts";

/** One request shape, applied to a record ID. */
interface Probe {
  readonly name: string;
  readonly method: string;
  readonly path: (id: string) => string;
  readonly options: TestRequestOptions;
}

/** How an API version spells its by-ID paths and body media type. */
interface Api {
  readonly asset: (id: string) => string;
  readonly laptop: (id: string) => string;
  /** The content type of a PATCH body. */
  readonly patchType: string;
}

const V1_API: Api = {
  asset: (id) => recordPath(ASSET, id),
  laptop: (id) => recordPath(LAPTOP, id),
  patchType: "application/json",
};

const V2_API: Api = {
  asset: (id) => `${V2.asset}/${id}`,
  laptop: (id) => `${V2.laptop}/${id}`,
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

const VERSIONS = [
  [
    "v1",
    "an invisible record and an unknown ID give byte-identical responses",
    V1_API,
  ],
  [
    "v2",
    "an invisible record and an unknown ID give byte-identical responses in /api/v2",
    V2_API,
  ],
] as const;

describe("invisible-identity", () => {
  it("covers every by-ID route", () => {
    const methods = new Set(probes("t", V2_API).map((probe) => probe.method));

    assert.deepStrictEqual([...methods].toSorted(), ["DELETE", "GET", "PATCH"]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    for (const [version, title, api] of VERSIONS) {
      dbTest.effect(title, () =>
        Effect.gen(function* identical() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const unknown = randomUUID();

          for (const probe of probes(bob, api)) {
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

            assert.strictEqual(
              hidden.status,
              missing.status,
              `${version} ${probe.name}`
            );
            assert.strictEqual(
              hidden.text,
              missing.text,
              `${version} ${probe.name}`
            );
          }
        })
      );
    }

    dbTest.effect(
      "on a visible record the same parameters give their own errors",
      () =>
        Effect.gen(function* visible() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const { L } = fixture.records;

          const unknownField = yield* http.get(
            historyPath((id) => recordPath(LAPTOP, id), "field=nosuchfield")(L),
            { token: bob }
          );

          assert.strictEqual(unknownField.status, 400);
          assert.strictEqual(yield* tagOf(unknownField), "UnknownField");

          const badDate = yield* http.get(
            historyPath((id) => recordPath(ASSET, id), "since=yesterday")(L),
            { token: bob }
          );

          assert.strictEqual(badDate.status, 400);
          assert.strictEqual(yield* tagOf(badDate), "InvalidRequest");
        })
    );

    dbTest.effect(
      "on a visible record the same parameters give their own errors in /api/v2",
      () =>
        Effect.gen(function* visibleV2() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const { L } = fixture.records;

          const unknownField = yield* http.get(
            historyPath(V2_API.laptop, "field=nosuchfield")(L),
            { token: bob }
          );

          assert.strictEqual(unknownField.status, 400, unknownField.text);
          assert.strictEqual(asObject(unknownField.json).code, "UnknownField");

          const badDate = yield* http.get(
            historyPath(V2_API.asset, "since=yesterday")(L),
            { token: bob }
          );

          assert.strictEqual(badDate.status, 400, badDate.text);
          assert.strictEqual(asObject(badDate.json).code, "InvalidRequest");
        })
    );
  });
});
