/**
 * Change sets over HTTP (Contracts 1.4 to 1.8): the change-set endpoints,
 * generic record writes to definition tables as one-operation change sets,
 * protected definitions through both paths, concurrent access-rule edits,
 * one revision per request under mixed load while 50 change sets commit,
 * and retired fields through the read compiler and the save pipeline.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import {
  BUILT_IN_ROLE_IDS,
  CORE_NAMESPACE_ID,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Fiber, Ref, Schema } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  listOf,
  listPath,
  readsTestLayer,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import { ACME, addField, ensureSite, values } from "./schema-support.ts";
import { ASSET, LAPTOP, create, patch, remove } from "./writes-support.ts";

const CHANGE_SETS = "/api/v1/schema/change-sets";

const SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

const catalogFingerprint = values(
  `SELECT md5(string_agg(x, ',' ORDER BY x)) AS value FROM (
     SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relfilenode::text AS x
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT a.attrelid::regclass::text || '.' || a.attname || ':' || a.atttypid::text || ':' || a.attnotnull::text
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SCHEMAS} AND a.attnum > 0 AND NOT a.attisdropped
     UNION ALL SELECT n.nspname || '.' || con.conname || ':' || con.convalidated::text
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname NOT IN ${SCHEMAS}
   ) AS f`
).pipe(Effect.map(([value]) => value));

const AppliedSchema = Schema.Struct({
  changeSet: Schema.Struct({
    id: Schema.NullOr(Schema.String),
    revision: Schema.NullOr(Schema.Int),
    state: Schema.String,
  }),
  schemaRevision: Schema.Int,
});

const decodeApplied = Schema.decodeUnknownEffect(AppliedSchema);

const appliedOf = (response: TestResponse) =>
  decodeApplied(response.json).pipe(Effect.orDie);

/**
 * The revision number in a response's `STD-Schema-Revision` header.
 * @param response - A response.
 * @returns The number.
 */
const headerRevision = (response: TestResponse): number =>
  Number((response.headers.get("std-schema-revision") ?? "").split(".")[0]);

const versionOf = (id: string) =>
  Effect.gen(function* readVersion() {
    return (yield* (yield* Catalog).refresh).get(id)?.version ?? 0;
  });

/**
 * Alice becomes an admin (once) and signs in.
 * @returns Her session token.
 */
const adminToken = Effect.gen(function* signInAdmin() {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;
  const catalog = yield* Catalog;
  const { request } = yield* Transactions;

  const [held] = yield* values(
    `SELECT count(*)::text AS value FROM core."user_role" WHERE "user" = $1::uuid AND "role" = $2::uuid`,
    [fixture.alice.id, BUILT_IN_ROLE_IDS.admin]
  );

  if (held === "0") {
    yield* request(
      Effect.gen(function* grantAdmin() {
        yield* insertAsOwner(yield* catalog.current, USER_ROLE_CLASS_ID, [
          {
            values: {
              role: BUILT_IN_ROLE_IDS.admin,
              user: fixture.alice.id,
            },
          },
        ]);
      })
    );
  }

  return yield* http.signIn("alice", "alice-password");
});

const postChangeSet = (token: string, operations: readonly Operation[]) =>
  Effect.gen(function* post() {
    const http = yield* TestHttpClient;
    const parsed = parseJson(JSON.stringify({ operations }));
    const body: JsonValue = parsed.ok ? parsed.value : null;

    return yield* http.request("POST", CHANGE_SETS, { body, token });
  });

/**
 * Appends a response to the ones kept.
 * @param endpoint - Where it came from.
 * @param response - The response.
 * @returns The update.
 */
const appendResponse =
  (endpoint: string, response: TestResponse) =>
  (
    all: readonly (readonly [string, TestResponse])[]
  ): readonly (readonly [string, TestResponse])[] => [
    ...all,
    [endpoint, response],
  ];

describe("schema-http", () => {
  it("change sets live under /api/v1/schema", () => {
    assert.strictEqual(CHANGE_SETS, "/api/v1/schema/change-sets");
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: 300_000 })(
    (dbTest) => {
      dbTest.effect(
        "the change-set endpoint applies operations as one change set and returns its journal",
        () =>
          Effect.gen(function* changeSetEndpoint() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const bob = yield* http.signIn("bob", "bob-password");

            const first = addField(ACME.asset, "sticker", { kind: "text" });
            const second = addField(ACME.asset, "badge", { kind: "integer" });

            const posted = yield* postChangeSet(admin, [first.op, second.op]);

            assert.strictEqual(posted.status, 201, posted.text);

            const applied = yield* appliedOf(posted);

            assert.strictEqual(applied.changeSet.state, "completed");
            assert.strictEqual(headerRevision(posted), applied.schemaRevision);

            const journal = yield* http.get(
              `${CHANGE_SETS}/${applied.changeSet.id ?? ""}`,
              { token: admin }
            );

            assert.strictEqual(journal.status, 200);
            assert.include(journal.text, '"op":"addField"');

            // Bob's rules allow no definition writes, and he cannot read the
            // journal, which looks like an unknown change set.
            const refused = yield* postChangeSet(bob, [
              addField(ACME.asset, "bob_field", { kind: "text" }).op,
            ]);

            assert.strictEqual(refused.status, 403);
            assert.strictEqual(yield* tagOf(refused), "NotAllowed");

            const hidden = yield* http.get(
              `${CHANGE_SETS}/${applied.changeSet.id ?? ""}`,
              { token: bob }
            );

            assert.strictEqual(hidden.status, 404);
          })
      );

      dbTest.effect(
        "protected definitions are refused through the generic API and the change-set endpoint; a label change succeeds",
        () =>
          Effect.gen(function* protectedOverHttp() {
            const admin = yield* adminToken;
            const fingerprint = yield* catalogFingerprint;
            const userVersion = yield* versionOf(USER_CLASS_ID);

            const nameField = (yield* (yield* Catalog).refresh).fieldByName(
              USER_CLASS_ID,
              "name"
            );

            const attempts: readonly (readonly [
              Effect.Effect<TestResponse, never, TestHttpClient>,
              number,
              string,
            ])[] = [
              [
                patch(admin, "core.class", USER_CLASS_ID, userVersion, {
                  name: "person",
                }),
                403,
                "DefinitionProtected",
              ],
              [
                patch(admin, "core.class", USER_CLASS_ID, userVersion, {
                  extensible: false,
                }),
                403,
                "DefinitionProtected",
              ],
              [
                remove(admin, "core.field", nameField?.id ?? "", 1),
                409,
                "UseRetireOrPurge",
              ],
              [
                patch(admin, "core.role", BUILT_IN_ROLE_IDS.admin, 1, {
                  state: "retired",
                }),
                403,
                "DefinitionProtected",
              ],
              [
                remove(admin, "core.namespace", CORE_NAMESPACE_ID, 1),
                409,
                "UseRetireOrPurge",
              ],
              [
                postChangeSet(admin, [
                  {
                    id: USER_CLASS_ID,
                    name: "person",
                    op: "rename",
                    version: userVersion,
                  },
                ]),
                403,
                "DefinitionProtected",
              ],
              [
                postChangeSet(admin, [
                  {
                    id: BUILT_IN_ROLE_IDS.schema_purger,
                    op: "delete",
                    version: 1,
                  },
                ]),
                403,
                "DefinitionProtected",
              ],
            ];

            for (const [attempt, status, tag] of attempts) {
              const response = yield* attempt;

              assert.strictEqual(response.status, status, response.text);
              assert.strictEqual(yield* tagOf(response), tag);
            }

            assert.strictEqual(yield* catalogFingerprint, fingerprint);

            const relabeled = yield* patch(
              admin,
              "core.class",
              USER_CLASS_ID,
              userVersion,
              { label: "Person" }
            );

            assert.strictEqual(relabeled.status, 200, relabeled.text);
            assert.strictEqual(
              (yield* recordOf(relabeled)).values.label,
              "Person"
            );
            assert.strictEqual(yield* catalogFingerprint, fingerprint);
          })
      );

      dbTest.effect(
        "DELETE of a field definition through the generic API is refused; column and data unchanged",
        () =>
          Effect.gen(function* deleteFieldOverHttp() {
            const admin = yield* adminToken;

            const before = yield* values(
              `SELECT coalesce(cost::text, '-') AS value FROM "acme"."asset" ORDER BY id`
            );

            const refused = yield* remove(admin, "core.field", ACME.cost, 1);

            assert.strictEqual(refused.status, 409);
            assert.strictEqual(yield* tagOf(refused), "UseRetireOrPurge");
            assert.deepStrictEqual(
              yield* values(
                `SELECT coalesce(cost::text, '-') AS value FROM "acme"."asset" ORDER BY id`
              ),
              before
            );
          })
      );

      dbTest.effect(
        "two concurrent access-rule edits through the generic API both succeed, at consecutive revisions",
        () =>
          Effect.gen(function* concurrentRuleEdits() {
            const admin = yield* adminToken;
            const snapshot = yield* (yield* Catalog).refresh;

            const [first, second] = snapshot
              .accessRules()
              .filter((rule) => rule.owner.layer === "app");

            const edit = (id: string, version: number, description: string) =>
              patch(admin, "core.access_rule", id, version, { description });

            const responses = yield* Effect.all(
              [
                edit(first?.id ?? "", first?.version ?? 0, "edited first"),
                edit(second?.id ?? "", second?.version ?? 0, "edited second"),
              ],
              { concurrency: 2 }
            );

            for (const response of responses) {
              assert.strictEqual(response.status, 200, response.text);
            }

            const revisions = responses
              .map(headerRevision)
              .toSorted((left, right) => left - right);

            assert.strictEqual(revisions[1], (revisions[0] ?? 0) + 1);
          })
      );

      dbTest.effect(
        "a retired field is hidden by default, returned when selected, refuses writes, and comes back optional",
        () =>
          Effect.gen(function* retiredOverHttp() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const alice = yield* http.signIn("alice", "alice-password");

            const tag = addField(
              ACME.asset,
              "asset_tag",
              { kind: "text" },
              { default: "none", required: true }
            );

            assert.strictEqual(
              (yield* postChangeSet(admin, [tag.op])).status,
              201
            );

            const created = yield* create(alice, ASSET, {
              asset_tag: "T-1",
              name: "tagged",
            });

            assert.strictEqual(created.status, 201, created.text);

            const record = yield* recordOf(created);

            const retired = yield* patch(admin, "core.field", tag.id, 1, {
              state: "retired",
            });

            assert.strictEqual(retired.status, 200, retired.text);

            // Hidden by default, returned when selected.
            const plain = yield* http.get(recordPath(ASSET, record.id), {
              token: alice,
            });

            assert.notProperty((yield* recordOf(plain)).values, "asset_tag");

            const selected = yield* http.get(
              recordPath(ASSET, record.id, { fields: "name,asset_tag" }),
              { token: alice }
            );

            assert.strictEqual(
              (yield* recordOf(selected)).values.asset_tag,
              "T-1"
            );

            // Writes are refused; inserts without it succeed.
            const written = yield* patch(
              alice,
              ASSET,
              record.id,
              record.version,
              { asset_tag: "T-2" }
            );

            assert.strictEqual(written.status, 422);
            assert.include(written.text, "DefinitionRetired");

            const without = yield* create(alice, ASSET, { name: "untagged" });

            assert.strictEqual(without.status, 201, without.text);

            // Reactivated it is optional, with its value intact.
            const back = yield* patch(admin, "core.field", tag.id, 2, {
              state: "active",
            });

            assert.strictEqual(back.status, 200, back.text);

            const again = yield* create(alice, ASSET, { name: "still none" });

            assert.strictEqual(again.status, 201, again.text);
            assert.strictEqual(
              (yield* recordOf(
                yield* http.get(recordPath(ASSET, record.id), { token: alice })
              )).values.asset_tag,
              "T-1"
            );
          })
      );

      dbTest.effect(
        "one revision per request under mixed load while 50 change sets commit",
        () =>
          Effect.gen(function* mixedLoad() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const alice = yield* http.signIn("alice", "alice-password");

            yield* ensureSite;

            const done = yield* Ref.make(false);

            const responses = yield* Ref.make<
              readonly (readonly [string, TestResponse])[]
            >([]);

            const addedAt = new Map<string, number>();

            const keep = (endpoint: string, response: TestResponse) =>
              Ref.update(responses, appendResponse(endpoint, response));

            const reader = Effect.gen(function* readLaptops() {
              while (!(yield* Ref.get(done))) {
                yield* keep(
                  LAPTOP,
                  yield* http.get(listPath(LAPTOP, { limit: "5" }), {
                    token: alice,
                  })
                );
                yield* keep(
                  ASSET,
                  yield* http.get(listPath(ASSET, { limit: "5" }), {
                    token: alice,
                  })
                );
              }
            });

            const writer = Effect.gen(function* writeLaptops() {
              let index = 0;

              while (!(yield* Ref.get(done))) {
                index += 1;
                yield* keep(
                  "create",
                  yield* create(alice, LAPTOP, {
                    name: `load ${index}`,
                    purchased_on: "2026-01-01",
                  })
                );
              }
            });

            const readers = yield* Effect.forkChild(
              Effect.all([reader, reader, writer], {
                concurrency: "unbounded",
                discard: true,
              })
            );

            for (let index = 0; index < 50; index += 1) {
              const name = `load_${index}`;

              const posted = yield* postChangeSet(admin, [
                addField(ACME.laptop, name, { kind: "integer" }).op,
              ]);

              assert.strictEqual(posted.status, 201, posted.text);
              addedAt.set(
                name,
                (yield* appliedOf(posted)).changeSet.revision ?? 0
              );
            }

            yield* Ref.set(done, true);
            yield* Fiber.join(readers);

            const all = yield* Ref.get(responses);

            assert.isAbove(all.length, 50);
            assert.isFalse(all.some(([, response]) => response.status >= 500));

            for (const [endpoint, response] of all) {
              if (response.status === 200) {
                const revision = headerRevision(response);
                const body = yield* listOf(response);

                const expected = [...addedAt]
                  .flatMap(([name, at]) => (at <= revision ? [name] : []))
                  .toSorted();

                // Through the laptop endpoint every laptop field shows; the
                // asset endpoint never shows child-only fields (2.3).
                for (const record of body.records) {
                  if (endpoint === LAPTOP) {
                    assert.deepStrictEqual(
                      Object.keys(record.values)
                        .filter((key) => key.startsWith("load_"))
                        .toSorted(),
                      expected,
                      `revision ${revision}`
                    );
                  }
                }

                assert.strictEqual(body.schemaRevision, revision);
              }
            }
          })
      );
    }
  );
});
