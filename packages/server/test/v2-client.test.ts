/**
 * `v2-client`: the typed client derived from the shared `StdApiV2`
 * definition (`@std/api/v2/client`) works against the real server: sign-in,
 * table metadata, every record endpoint, history, and TMF errors.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { isTmfError, makeStdClientV2 } from "@std/api/v2/client";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { readsTestLayer } from "./reads-support.ts";

const BASE_URL = "http://std.test";
const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

describe("v2-client", () => {
  it("recognizes TMF errors by code", () => {
    const failure = { code: "NotFound", reason: "x" };

    assert.isTrue(isTmfError("NotFound", "UnknownTable")(failure));
    assert.isFalse(isTmfError("Unauthenticated")(failure));
    assert.isFalse(isTmfError("NotFound")(new Error("NotFound")));
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("the typed client signs in, reads, writes and fails", () =>
      Effect.gen(function* typedClient() {
        const http = yield* TestHttpClient;
        const { records } = yield* AcmeFixture;

        const withFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, http.fetch)
          );

        const anonymous = yield* withFetch(
          makeStdClientV2({ baseUrl: BASE_URL })
        );

        const session = yield* withFetch(
          anonymous.session.create({
            payload: {
              login: "alice",
              password: "alice-password",
              tokenDelivery: "body",
            },
          })
        );

        assert.strictEqual(session.tokenDelivery, "body");

        const client = yield* withFetch(
          makeStdClientV2({
            baseUrl: BASE_URL,
            token: Redacted.make(session.token ?? ""),
          })
        );

        const current = yield* withFetch(client.session.current());

        assert.strictEqual(current.user.id, session.user.id);

        const tables = yield* withFetch(client.tableMetadata.list());
        const asset = tables.find((entry) => entry.name === "acme.asset");

        assert.strictEqual(asset?.id, "acmeAsset");
        assert.strictEqual(asset?.resourceType, "AcmeAsset");

        const metadata = yield* withFetch(
          client.tableMetadata.get({ params: { table: "acmeAsset" } })
        );

        assert.strictEqual(metadata.name, "acme.asset");
        assert.include(
          metadata.fields.map((field) => field.apiName),
          "status"
        );

        const [page, response] = yield* withFetch(
          client.records.list({
            params: { table: "acmeAsset" },
            query: { condition: 'status = "spare"', limit: "50" },
            responseMode: "decoded-and-response",
          })
        );

        assert.isString(response.headers["std-schema-revision"]);
        assert.isTrue(page.every((resource) => resource.status === "spare"));

        const created = yield* withFetch(
          client.records.create({
            params: { table: "acmeAsset" },
            payload: { name: "Typed", status: "spare" },
          })
        );

        const ids = { id: created.id, table: "acmeAsset" };

        const merged = yield* withFetch(
          client.records.patch({
            headers: { "if-match": '"1"' },
            params: ids,
            payload: { name: "Typed 2" },
          })
        );

        assert.strictEqual(merged.name, "Typed 2");

        const patched = yield* withFetch(
          client.records.patch({
            headers: { "if-match": '"2"' },
            params: ids,
            payload: [{ op: "replace", path: "/name", value: "Typed 3" }],
          })
        );

        assert.strictEqual(patched.name, "Typed 3");

        const history = yield* withFetch(
          client.records.history({ params: ids, query: { limit: "10" } })
        );

        assert.strictEqual(history.length, 3);

        const [first] = history;

        const entry = yield* withFetch(
          client.records.historyEntry({
            params: { ...ids, changeId: first?.id ?? "" },
            query: {},
          })
        );

        assert.strictEqual(entry.id, first?.id);

        yield* withFetch(
          client.records.delete({ headers: { "if-match": '"3"' }, params: ids })
        );

        const missing = yield* withFetch(
          client.records.get({ params: ids, query: {} })
        ).pipe(Effect.flip);

        assert.isTrue(isTmfError("NotFound")(missing));

        // Alice's own laptop through the parent collection, one field.
        const viaParent = yield* withFetch(
          client.records.get({
            params: { id: records.K, table: "acmeAsset" },
            query: { fields: "name" },
          })
        );

        assert.strictEqual(viaParent.id, records.K);

        const unknownId = yield* withFetch(
          client.records.get({
            params: { id: RANDOM_ID, table: "acmeAsset" },
            query: {},
          })
        ).pipe(Effect.flip);

        assert.isTrue(isTmfError("NotFound")(unknownId));
      })
    );
  });
});
