/**
 * `v2-client`: the typed client derived from the shared `StdApi`
 * definition (`@std/api/client`) works against the real server: sign-in,
 * table metadata, every record endpoint, history, and TMF errors.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { isTmfError, makeStdClient } from "@std/api/client";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { UNKNOWN_ID } from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";

const BASE_URL = "http://std.test";

/** A revision this database never had. */
const NEVER_HAD = "999999.019a0000-0000-7000-8000-00000000abcd";

const REVISION = /^\d+\.[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

/**
 * Runs client effects over the test server's fetch.
 *
 * @param fetch - The test server's fetch.
 * @returns A function that provides the fetch client to an effect.
 */
const fetchWith =
  (fetch: typeof FetchHttpClient.Fetch.Service) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch)
    );

describe("api-client", () => {
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

        const withFetch = fetchWith(http.fetch);

        const anonymous = yield* withFetch(
          makeStdClient({ baseUrl: BASE_URL })
        );

        const session = yield* anonymous.session.create({
          payload: {
            login: "alice",
            password: "alice-password",
            tokenDelivery: "body",
          },
        });

        assert.strictEqual(session.tokenDelivery, "body");

        const client = yield* withFetch(
          makeStdClient({
            baseUrl: BASE_URL,
            token: Redacted.make(session.token ?? ""),
          })
        );

        const current = yield* client.session.current();

        assert.strictEqual(current.user.id, session.user.id);

        const tables = yield* client.tableMetadata.list();
        const asset = tables.find((entry) => entry.name === "acme.asset");

        assert.strictEqual(asset?.id, "acmeAsset");
        assert.strictEqual(asset?.resourceType, "AcmeAsset");

        const metadata = yield* client.tableMetadata.get({
          params: { table: "acmeAsset" },
        });

        assert.strictEqual(metadata.name, "acme.asset");
        assert.include(
          metadata.fields.map((field) => field.apiName),
          "status"
        );

        const [page, response] = yield* client.records.list({
          params: { table: "acmeAsset" },
          query: { condition: 'status = "spare"', limit: "50" },
          responseMode: "decoded-and-response",
        });

        assert.isString(response.headers["std-schema-revision"]);
        assert.isTrue(page.every((resource) => resource.status === "spare"));

        const created = yield* client.records.create({
          params: { table: "acmeAsset" },
          payload: { name: "Typed", status: "spare" },
        });

        const ids = { id: created.id, table: "acmeAsset" };

        const merged = yield* client.records.patch({
          headers: { "if-match": '"1"' },
          params: ids,
          payload: { name: "Typed 2" },
        });

        assert.strictEqual(merged.name, "Typed 2");

        const patched = yield* client.records.patch({
          headers: { "if-match": '"2"' },
          params: ids,
          payload: [{ op: "replace", path: "/name", value: "Typed 3" }],
        });

        assert.strictEqual(patched.name, "Typed 3");

        const history = yield* client.records.history({
          params: ids,
          query: { limit: "10" },
        });

        assert.strictEqual(history.length, 3);

        const [first] = history;

        const entry = yield* client.records.historyEntry({
          params: { ...ids, changeId: first?.id ?? "" },
          query: {},
        });

        assert.strictEqual(entry.id, first?.id);

        yield* client.records.delete({
          headers: { "if-match": '"3"' },
          params: ids,
        });

        const missing = yield* client.records
          .get({ params: ids, query: {} })
          .pipe(Effect.flip);

        assert.isTrue(isTmfError("NotFound")(missing));

        // Alice's own laptop through the parent collection, one field.
        const viaParent = yield* client.records.get({
          params: { id: records.K, table: "acmeAsset" },
          query: { fields: "name" },
        });

        assert.strictEqual(viaParent.id, records.K);

        const unknownId = yield* client.records
          .get({
            params: { id: UNKNOWN_ID, table: "acmeAsset" },
            query: {},
          })
          .pipe(Effect.flip);

        assert.isTrue(isTmfError("NotFound")(unknownId));
      })
    );

    dbTest.effect(
      "a stale or malformed stated revision is a typed failure",
      () =>
        Effect.gen(function* statedRevision() {
          const http = yield* TestHttpClient;

          const token = Redacted.make(
            yield* http.signIn("bob", "bob-password")
          );

          const withFetch = fetchWith(http.fetch);

          const stale = yield* withFetch(
            makeStdClient({
              baseUrl: BASE_URL,
              schemaRevision: NEVER_HAD,
              token,
            })
          );

          const malformed = yield* withFetch(
            makeStdClient({
              baseUrl: BASE_URL,
              schemaRevision: "12.not-a-uuid",
              token,
            })
          );

          const listed = yield* stale.records
            .list({ params: { table: "acmeAsset" }, query: {} })
            .pipe(Effect.flip);

          assert.isTrue(isTmfError("SchemaChanged")(listed));

          const current = yield* stale.session.current().pipe(Effect.flip);

          assert.isTrue(isTmfError("SchemaChanged")(current));

          const bad = yield* malformed.records
            .list({
              params: { table: "acmeAsset" },
              query: {},
            })
            .pipe(Effect.flip);

          assert.isTrue(isTmfError("InvalidSchemaRevision")(bad));

          // Sign-out checks the format but never refuses a stale client.
          yield* stale.session.signOut();
        })
    );

    dbTest.effect("sign-out through the client ends the session", () =>
      Effect.gen(function* signOut() {
        const http = yield* TestHttpClient;

        const token = Redacted.make(
          yield* http.signIn("alice", "alice-password")
        );

        const withFetch = fetchWith(http.fetch);

        const client = yield* withFetch(
          makeStdClient({ baseUrl: BASE_URL, token })
        );

        yield* client.session.current();
        yield* client.session.signOut();

        const ended = yield* client.session.current().pipe(Effect.flip);

        assert.isTrue(isTmfError("Unauthenticated")(ended));
      })
    );

    dbTest.effect("refusals and hidden records are TMF errors", () =>
      Effect.gen(function* refusals() {
        const http = yield* TestHttpClient;
        const { records } = yield* AcmeFixture;

        const withFetch = fetchWith(http.fetch);

        const bob = yield* withFetch(
          makeStdClient({
            baseUrl: BASE_URL,
            token: Redacted.make(yield* http.signIn("bob", "bob-password")),
          })
        );

        // Alice's laptop is hidden from Bob like a record that is not there.
        const hidden = yield* bob.records
          .get({
            params: { id: records.K, table: "acmeAsset" },
            query: {},
          })
          .pipe(Effect.flip);

        assert.isTrue(isTmfError("NotFound")(hidden));

        const platform = yield* bob.records
          .list({ params: { table: "coreChange" }, query: {} })
          .pipe(Effect.flip);

        assert.isTrue(isTmfError("UnknownTable")(platform));

        const anonymous = yield* withFetch(
          makeStdClient({ baseUrl: BASE_URL })
        );

        const wrong = yield* anonymous.session
          .create({
            payload: {
              login: "alice",
              password: "wrong",
              tokenDelivery: "body",
            },
          })
          .pipe(Effect.flip);

        assert.isTrue(isTmfError("InvalidCredentials")(wrong));
      })
    );

    dbTest.effect("a write the caller may not make is a typed NotAllowed", () =>
      Effect.gen(function* writeRefused() {
        const http = yield* TestHttpClient;
        const { alice } = yield* AcmeFixture;

        const withFetch = fetchWith(http.fetch);

        const bob = yield* withFetch(
          makeStdClient({
            baseUrl: BASE_URL,
            token: Redacted.make(yield* http.signIn("bob", "bob-password")),
          })
        );

        // Bob may create only assets he owns.
        const refused = yield* bob.records
          .create({
            params: { table: "acmeAsset" },
            payload: {
              name: "Not mine",
              owner: { id: alice.id },
              status: "spare",
            },
          })
          .pipe(Effect.flip);

        assert.isTrue(
          isTmfError("NotAllowed")(refused),
          JSON.stringify(refused)
        );
      })
    );

    dbTest.effect("the response headers carry the revision and the ETag", () =>
      Effect.gen(function* responseHeaders() {
        const http = yield* TestHttpClient;
        const { records } = yield* AcmeFixture;

        const withFetch = fetchWith(http.fetch);

        const client = yield* withFetch(
          makeStdClient({
            baseUrl: BASE_URL,
            token: Redacted.make(yield* http.signIn("alice", "alice-password")),
          })
        );

        const [resource, response] = yield* client.records.get({
          params: { id: records.K, table: "acmeAsset" },
          query: {},
          responseMode: "decoded-and-response",
        });

        assert.match(response.headers["std-schema-revision"] ?? "", REVISION);
        assert.strictEqual(
          response.headers.etag,
          `"${String(resource.revision)}"`
        );
      })
    );
  });
});
