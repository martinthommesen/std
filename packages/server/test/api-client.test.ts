/**
 * The typed client of `@std/api` against a live server (Contracts 6.1,
 * 6.2, 6.4): the real HTTP application on Node's HTTP server at an
 * ephemeral port over the acme test database, called through
 * `makeStdClient` (`HttpApiClient.make` on the shared definition) with the
 * fetch client. Typed successes and typed errors for sign-in, `auth/me`,
 * reads, writes, history and sign-out; stale and malformed revisions;
 * the `STD-Schema-Revision` header on every response; and the OpenAPI 3.1
 * document generated from the same definition.
 */
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { OPENAPI_PATH, SCHEMA_REVISION_HEADER } from "@std/api/api";
import { authenticationClient, makeStdClient } from "@std/api/client";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import { AcmeFixture, acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { HttpAppLayer } from "../src/http/app.ts";

const REVISION = /^\d+\.[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

/** A revision this database never had. */
const NEVER_HAD = "999999.019a0000-0000-7000-8000-00000000abcd";

/** The STD API on Node's HTTP server, port 0, over the acme database. */
const LiveServer = HttpRouter.serve(HttpAppLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(
    NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
  ),
  Layer.provideMerge(acmeTestLayer())
);

/** Fetch without keep-alive, so the server closes promptly. */
const Fetch = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })
  )
);

/** The server's origin, such as `http://127.0.0.1:41234`. */
const baseUrl = Effect.gen(function* baseUrl() {
  const server = yield* HttpServer.HttpServer;

  return HttpServer.formatAddress(server.address);
});

/**
 * A typed client sending `token` as the bearer token (none before sign-in).
 *
 * @param token - The session token, if any.
 * @param schemaRevision - The revision to state, if any.
 * @returns The client.
 */
const clientFor = (token?: string, schemaRevision?: string) =>
  Effect.gen(function* makeClient() {
    const url = yield* baseUrl;

    return yield* makeStdClient(
      schemaRevision === undefined
        ? { baseUrl: url }
        : { baseUrl: url, schemaRevision }
    ).pipe(
      Effect.provide(
        authenticationClient(
          token === undefined ? undefined : Redacted.make(token)
        )
      )
    );
  });

/**
 * Signs in through the typed client.
 *
 * @param login - The login.
 * @returns The session token.
 */
const signIn = (login: string) =>
  Effect.gen(function* signInWithClient() {
    const client = yield* clientFor();

    const session = yield* client.signIn.signIn({
      payload: { login, password: `${login}-password` },
    });

    return session.token;
  });

/**
 * A plain request, for the response headers.
 *
 * @param path - The path.
 * @param init - Fetch options.
 * @returns The response.
 */
const fetchRaw = (path: string, init: RequestInit = {}) =>
  Effect.gen(function* fetchResponse() {
    const url = yield* baseUrl;

    return yield* Effect.promise(
      async () => await fetch(`${url}${path}`, { ...init, keepalive: false })
    );
  });

const ASSET = "acme.asset";

/** The parts of an OpenAPI document the test reads. */
const decodeOpenApi = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      openapi: Schema.String,
      paths: Schema.Record(Schema.String, Schema.Unknown),
    })
  )
);

describe("api-client", () => {
  it("states the revision header the client sends", () => {
    assert.strictEqual(SCHEMA_REVISION_HEADER, "std-schema-revision");
  });

  layer(Layer.merge(LiveServer, Fetch), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect("signs in, reads and refuses with typed errors", () =>
        Effect.gen(function* reads() {
          const { records } = yield* AcmeFixture;
          const bob = yield* clientFor(yield* signIn("bob"));
          const alice = yield* clientFor(yield* signIn("alice"));

          const me = yield* bob.session.me();
          assert.deepStrictEqual(me.roles.map((role) => role.name).toSorted(), [
            "authenticated",
            "employee",
          ]);

          const list = yield* bob.records.list({
            params: { table: ASSET },
            query: { count: "true", sort: "name" },
          });

          assert.deepStrictEqual(
            list.records.map((record) => record.values.name),
            ["L", "M", "S"]
          );
          assert.strictEqual(list.count, 3);

          const laptop = yield* bob.records.get({
            params: { id: records.L, table: "acme.laptop" },
            query: {},
          });

          assert.strictEqual(laptop.record.class, "acme.laptop");
          assert.notProperty(laptop.record.values, "cost");

          const hidden = yield* bob.records
            .get({ params: { id: records.K, table: ASSET }, query: {} })
            .pipe(Effect.flip);

          assert.strictEqual(hidden._tag, "NotFound");

          const platform = yield* bob.records
            .list({ params: { table: "core.change" }, query: {} })
            .pipe(Effect.flip);

          assert.strictEqual(platform._tag, "UnknownTable");

          const unknownField = yield* bob.records
            .list({ params: { table: ASSET }, query: { sort: "cost" } })
            .pipe(Effect.flip);

          assert.strictEqual(unknownField._tag, "UnknownField");

          const asAlice = yield* alice.records.get({
            params: { id: records.K, table: ASSET },
            query: { labels: "true" },
          });

          assert.strictEqual(asAlice.record.values.name, "K");

          const wrong = yield* (yield* clientFor()).signIn
            .signIn({ payload: { login: "alice", password: "wrong" } })
            .pipe(Effect.flip);

          assert.strictEqual(wrong._tag, "InvalidCredentials");
        })
      );

      dbTest.effect("writes, history and sign-out through the client", () =>
        Effect.gen(function* writes() {
          const { alice: aliceUser } = yield* AcmeFixture;
          const token = yield* signIn("alice");
          const alice = yield* clientFor(token);

          const created = yield* alice.records.create({
            params: { table: "acme.monitor" },
            payload: { name: "client monitor", owner: aliceUser.id },
          });

          const { id } = created.record;
          assert.strictEqual(created.record.version, 1);

          const updated = yield* alice.records.update({
            headers: { "if-match": '"1"' },
            params: { id, table: ASSET },
            payload: { status: "spare" },
          });

          assert.strictEqual(updated.record.version, 2);

          const conflict = yield* alice.records
            .update({
              headers: { "if-match": '"1"' },
              params: { id, table: ASSET },
              payload: { status: "in_use" },
            })
            .pipe(Effect.flip);

          assert.strictEqual(conflict._tag, "VersionConflict");

          const required = yield* alice.records
            .update({
              headers: {},
              params: { id, table: ASSET },
              payload: { name: "x" },
            })
            .pipe(Effect.flip);

          assert.strictEqual(required._tag, "VersionRequired");

          const history = yield* alice.records.history({
            params: { id, table: "acme.monitor" },
            query: {},
          });

          assert.deepStrictEqual(
            history.entries.map((entry) => `${entry.version}:${entry.kind}`),
            ["1:create", "2:update"]
          );

          const removed = yield* alice.records.remove({
            headers: { "if-match": '"2"' },
            params: { id, table: "acme.monitor" },
          });

          assert.strictEqual(removed.version, 3);

          const gone = yield* alice.records
            .get({ params: { id, table: ASSET }, query: {} })
            .pipe(Effect.flip);

          assert.strictEqual(gone._tag, "NotFound");

          yield* alice.session.signOut();

          const ended = yield* alice.session.me().pipe(Effect.flip);
          assert.strictEqual(ended._tag, "Unauthenticated");
        })
      );

      dbTest.effect("stale and malformed revisions are typed errors", () =>
        Effect.gen(function* revisions() {
          const token = yield* signIn("bob");
          const stale = yield* clientFor(token, NEVER_HAD);
          const malformed = yield* clientFor(token, "12.not-a-uuid");

          const listed = yield* stale.records
            .list({ params: { table: ASSET }, query: {} })
            .pipe(Effect.flip);

          assert.strictEqual(listed._tag, "SchemaChanged");

          const me = yield* stale.session.me().pipe(Effect.flip);
          assert.strictEqual(me._tag, "SchemaChanged");

          const signedIn = yield* stale.signIn
            .signIn({ payload: { login: "bob", password: "bob-password" } })
            .pipe(Effect.flip);

          assert.strictEqual(signedIn._tag, "SchemaChanged");

          const bad = yield* malformed.records
            .list({ params: { table: ASSET }, query: {} })
            .pipe(Effect.flip);

          assert.strictEqual(bad._tag, "InvalidSchemaRevision");

          const badMe = yield* malformed.session.me().pipe(Effect.flip);
          assert.strictEqual(badMe._tag, "InvalidSchemaRevision");

          // Sign-out checks the format but never refuses a stale client.
          yield* stale.session.signOut();
        })
      );

      dbTest.effect("every response carries the revision header", () =>
        Effect.gen(function* headers() {
          const { records } = yield* AcmeFixture;
          const token = yield* signIn("bob");
          const bearer = { authorization: `Bearer ${token}` };
          const json = { "content-type": "application/json" };

          const responses = [
            yield* fetchRaw("/api/v1/auth/sign-in", {
              body: JSON.stringify({ login: "bob", password: "bob-password" }),
              headers: json,
              method: "POST",
            }),
            yield* fetchRaw("/api/v1/auth/sign-in", {
              body: JSON.stringify({ login: "bob", password: "wrong" }),
              headers: json,
              method: "POST",
            }),
            yield* fetchRaw("/api/v1/auth/me", { headers: bearer }),
            yield* fetchRaw("/api/v1/auth/me"),
            yield* fetchRaw(`/api/v1/tables/${ASSET}/records`, {
              headers: bearer,
            }),
            yield* fetchRaw(`/api/v1/tables/${ASSET}/records/${records.K}`, {
              headers: bearer,
            }),
            yield* fetchRaw(
              `/api/v1/tables/${ASSET}/records/${records.L}/history`,
              { headers: bearer }
            ),
            yield* fetchRaw(`/api/v1/tables/${ASSET}/records`, {
              body: "{",
              headers: { ...bearer, ...json },
              method: "POST",
            }),
            yield* fetchRaw("/api/v1/no-such-route"),
            yield* fetchRaw(OPENAPI_PATH),
          ];

          for (const response of responses) {
            assert.match(
              response.headers.get(SCHEMA_REVISION_HEADER) ?? "",
              REVISION,
              `${response.status} ${response.url}`
            );
          }

          assert.deepStrictEqual(
            responses.map((response) => response.status),
            [200, 401, 200, 401, 200, 404, 200, 400, 404, 200]
          );
        })
      );

      dbTest.effect("serves the OpenAPI 3.1 document of the definition", () =>
        Effect.gen(function* openApi() {
          const response = yield* fetchRaw(OPENAPI_PATH);

          const text = yield* Effect.promise(async () => await response.text());

          const document = yield* decodeOpenApi(text).pipe(Effect.orDie);

          assert.strictEqual(response.status, 200);
          assert.isTrue(document.openapi.startsWith("3.1"));
          assert.includeMembers(Object.keys(document.paths), [
            "/api/v1/auth/sign-in",
            "/api/v1/auth/me",
            "/api/v1/auth/sign-out",
            "/api/v1/tables/{table}/records",
            "/api/v1/tables/{table}/records/{id}",
            "/api/v1/tables/{table}/records/{id}/history",
          ]);
        })
      );
    }
  );
});
