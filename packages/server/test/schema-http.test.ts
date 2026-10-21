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
  PLATFORM_CLASS_IDS,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Context, Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { StepBoundary } from "../src/schema/recovery-settings.ts";
import { advisoryObjectId, CONFIG_KEY, SCHEMA_KEY } from "../src/sql/locks.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { overridesOf } from "./config-support.ts";
import {
  listOf,
  listPath,
  readsTestLayer,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import {
  ACME,
  ACME_SET_DIRECTORY,
  addAccessRule,
  addField,
  addRole,
  change,
  createClass,
  ensureSite,
  values,
} from "./schema-support.ts";
import { errorOf, waitUntil } from "./support.ts";
import { ASSET, LAPTOP, create, patch, remove } from "./writes-support.ts";

const CHANGE_SETS = "/api/v1/schema/change-sets";

/** An ID no definition has. */
const MISSING_ID = "0b0d6c3e-5a0e-4c33-9a43-6e7f6d1b2a99";

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

/**
 * A response's body with one ID replaced, to compare refusals that name
 * different IDs.
 * @param response - The response.
 * @param id - The ID.
 * @returns The body text.
 */
const asMissing = (response: TestResponse, id: string): string =>
  response.text.replaceAll(id, "<id>");

/**
 * A read-deny rule hiding one role, by name, from admins.
 * @param nameFieldId - The ID of `core.role.name`.
 * @param roleName - The role to hide.
 * @returns The operation.
 */
const hideRole = (nameFieldId: string, roleName: string): Operation => {
  const deny = addAccessRule(
    PLATFORM_CLASS_IDS.role,
    [BUILT_IN_ROLE_IDS.admin],
    {
      condition: {
        left: { path: [nameFieldId] },
        op: "eq",
        right: { value: roleName },
      },
    }
  );

  return deny.op.op === "createAccessRule"
    ? {
        definition: {
          ...deny.op.definition,
          actions: ["read"],
          effect: "deny",
        },
        op: "createAccessRule",
      }
    : deny.op;
};

/**
 * A definition's field at a revision: its latest definition revision at or
 * before it.
 */
const FIELD_AT = `SELECT effective FROM core."definition_revision"
  WHERE definition_id = f.key::uuid AND revision <= c.schema_revision
  ORDER BY revision DESC LIMIT 1`;

/** The version-3 change of a record, read through its revision's fields. */
const HISTORY_READ_BACK = `SELECT (d.effective ->> 'name') || ':' || (f.value ->> 'before') || '>' || (f.value ->> 'after') AS value
  FROM core."change" c CROSS JOIN LATERAL jsonb_each(c.fields) AS f(key, value)
  JOIN LATERAL (${FIELD_AT}) AS d ON true
  WHERE c.record_id = $1::uuid AND c.record_version = 3`;

/** How many history fields do not exist at their entry's revision. */
const UNRESOLVED_HISTORY = `SELECT count(*)::text AS value
  FROM core."change" c CROSS JOIN LATERAL jsonb_each(c.fields) AS f(key, value)
  WHERE NOT EXISTS (${FIELD_AT})`;

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

/**
 * Holds a generic definition write between its request checks and its
 * change set (`definition-write:prepared`) until the test releases it.
 */
class PreparedGate extends Context.Service<
  PreparedGate,
  {
    readonly reached: Deferred.Deferred<boolean>;
    readonly release: Deferred.Deferred<boolean>;
  }
>()("test/schema-http/PreparedGate") {
  /** The gate and the step-boundary hook that waits on it. */
  static readonly layer = Layer.effect(
    StepBoundary,
    Effect.gen(function* hook() {
      const gate = yield* PreparedGate;

      return (label: string) =>
        label === "definition-write:prepared"
          ? Deferred.succeed(gate.reached, true).pipe(
              Effect.andThen(Deferred.await(gate.release)),
              Effect.asVoid
            )
          : Effect.void;
    })
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        PreparedGate,
        Effect.gen(function* gate() {
          return PreparedGate.of({
            reached: yield* Deferred.make<boolean>(),
            release: yield* Deferred.make<boolean>(),
          });
        })
      )
    )
  );
}

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

            const rules = [
              addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin], {
                description: "local first",
              }),
              addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin], {
                description: "local second",
              }),
            ];

            // Local rules: edits of shipped ones are overrides (8.2), and
            // a shipped rule's description is not overridable.
            yield* change(rules.map((rule) => rule.op));

            const snapshot = yield* (yield* Catalog).refresh;
            const [first, second] = rules.map((rule) => snapshot.get(rule.id));

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

            // The two change sets committed at consecutive revisions, each
            // editing one rule (a response is served after its own commit,
            // possibly after the other one's too).
            const committed = yield* values(
              `SELECT first_revision::text || ':' || (operations -> 0 ->> 'targetId') AS value
               FROM core."schema_change" ORDER BY first_revision DESC LIMIT 2`
            );

            const [later, earlier] = committed.map((entry) => entry.split(":"));

            assert.strictEqual(Number(later?.[0]), Number(earlier?.[0]) + 1);
            assert.sameMembers(
              [later?.[1], earlier?.[1]],
              [first?.id, second?.id]
            );

            for (const response of responses) {
              assert.isAtLeast(headerRevision(response), Number(earlier?.[0]));
            }
          })
      );

      dbTest.effect(
        "shipped edits through both HTTP paths are stored as overrides and survive an upgrade; non-overridable properties are refused on both",
        () =>
          Effect.gen(function* shippedEdit() {
            const admin = yield* adminToken;
            const snapshot = yield* (yield* Catalog).refresh;

            const rule = snapshot
              .accessRules()
              .find((entry) => entry.owner.layer === "app" && entry.active);

            const version = rule?.version ?? 0;

            const refused = yield* patch(
              admin,
              "core.access_rule",
              rule?.id ?? "",
              version,
              { description: "not overridable" }
            );

            assert.strictEqual(refused.status, 422, refused.text);
            assert.strictEqual(yield* tagOf(refused), "DefinitionInvalid");

            const label = yield* patch(
              admin,
              "core.field",
              ACME.cost,
              yield* versionOf(ACME.cost),
              { label: "Local cost" }
            );

            assert.strictEqual(label.status, 200, label.text);
            assert.deepStrictEqual(
              yield* values(
                `SELECT property || '=' || (value #>> '{}') AS value FROM core."config_override" WHERE record_id = $1::uuid`,
                [ACME.cost]
              ),
              ["label=Local cost"]
            );
            assert.deepStrictEqual(
              yield* values(
                "SELECT label AS value FROM core.field WHERE id = $1::uuid",
                [ACME.cost]
              ),
              ["Local cost"]
            );

            // The change-set endpoint plans the same override writes, in
            // the same change set as the effective change.
            const batch = yield* postChangeSet(admin, [
              {
                changes: { label: "Batch cost" },
                id: ACME.cost,
                op: "update",
                version: yield* versionOf(ACME.cost),
              },
            ]);

            assert.strictEqual(batch.status, 201, batch.text);
            assert.deepStrictEqual(yield* overridesOf(ACME.cost), [
              "label=Batch cost@Cost",
            ]);

            const batchRefused = yield* postChangeSet(admin, [
              {
                changes: { description: "not overridable" },
                id: rule?.id ?? "",
                op: "update",
                version,
              },
            ]);

            assert.strictEqual(batchRefused.status, 422, batchRefused.text);
            assert.strictEqual(yield* tagOf(batchRefused), "DefinitionInvalid");

            // An upgrade (the acme set loaded again) keeps the local label,
            // and doctor finds the effective record and its override agree.
            yield* loadSetDirectory(ACME_SET_DIRECTORY);

            assert.deepStrictEqual(
              yield* values(
                "SELECT label AS value FROM core.field WHERE id = $1::uuid",
                [ACME.cost]
              ),
              ["Batch cost"]
            );
            assert.deepStrictEqual(
              (yield* runDoctor()).findings.flatMap((entry) =>
                entry.code === "effectiveMismatch" ? [entry.subject] : []
              ),
              []
            );

            // A no-op update still states its version: a stale one fails
            // the whole batch, though it would change nothing.
            const { revision } = yield* (yield* Catalog).refresh;

            const stale = yield* postChangeSet(admin, [
              addRole("after_stale").op,
              {
                changes: { label: "Batch cost" },
                id: ACME.cost,
                op: "update",
                version: 999,
              },
            ]);

            assert.strictEqual(stale.status, 422, stale.text);
            assert.include(stale.text, "versionConflict");
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).revision,
              revision,
              "nothing committed"
            );
          })
      );

      dbTest.effect(
        "adopt runs only through the config layers: a still-shipped record is refused on the endpoint, and an unplanned adopt by the engine",
        () =>
          Effect.gen(function* adoptRefused() {
            const admin = yield* adminToken;

            const adopt: Operation = {
              id: ACME.cost,
              op: "adopt",
              version: yield* versionOf(ACME.cost),
            };

            const refused = yield* postChangeSet(admin, [adopt]);

            assert.strictEqual(refused.status, 422, refused.text);
            assert.strictEqual(yield* tagOf(refused), "DefinitionInvalid");
            assert.include(refused.text, "still shipped");

            const direct = errorOf(yield* Effect.exit(change([adopt])));

            assert.strictEqual(direct?._tag, "DefinitionInvalid");
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).get(ACME.cost)?.owner.layer,
              "app"
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT removed::text AS value FROM core."config_base" WHERE id = $1::uuid`,
                [ACME.cost]
              ),
              ["false"]
            );
          })
      );

      dbTest.effect(
        "a definition the caller cannot read is NotFound on writes, before the version check, like an unknown ID",
        () =>
          Effect.gen(function* hiddenDefinition() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const hidden = addRole("hidden_role");

            assert.strictEqual(
              (yield* postChangeSet(admin, [hidden.op])).status,
              201
            );

            const snapshot = yield* (yield* Catalog).refresh;
            const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");

            assert.strictEqual(
              (yield* postChangeSet(admin, [
                hideRole(name?.id ?? "", "hidden_role"),
              ])).status,
              201
            );

            const read = yield* http.get(recordPath("core.role", hidden.id), {
              token: admin,
            });

            const responses = [
              read,
              yield* patch(admin, "core.role", hidden.id, 99, { label: "x" }),
              yield* patch(admin, "core.role", hidden.id, 1, { label: "x" }),
              yield* remove(admin, "core.role", hidden.id, 99),
              yield* patch(admin, "core.role", MISSING_ID, 1, { label: "x" }),
            ];

            for (const response of responses) {
              assert.strictEqual(response.status, 404, response.text);
              assert.strictEqual(yield* tagOf(response), "NotFound");
            }

            // The change-set endpoint: a hidden target, and a create that
            // references a hidden role, get exactly what a missing one gets.
            const missing = yield* postChangeSet(admin, [
              {
                changes: { label: "x" },
                id: MISSING_ID,
                op: "update",
                version: 1,
              },
            ]);

            assert.strictEqual(missing.status, 422, missing.text);

            const grant = addAccessRule(ACME.asset, [hidden.id]).op;
            const missingGrant = addAccessRule(ACME.asset, [MISSING_ID]).op;

            const batches = [
              [
                {
                  changes: { label: "x" },
                  id: hidden.id,
                  op: "update",
                  version: 99,
                },
              ],
              [
                {
                  changes: { label: "x" },
                  id: hidden.id,
                  op: "update",
                  version: 1,
                },
              ],
              [
                addRole("bystander").op,
                { id: hidden.id, op: "retire", version: 1 },
              ],
            ] satisfies Operation[][];

            for (const operations of batches) {
              const response = yield* postChangeSet(admin, operations);

              assert.strictEqual(
                asMissing(response, hidden.id),
                asMissing(missing, MISSING_ID)
              );
            }

            const hiddenParent = yield* postChangeSet(admin, [grant]);
            const missingParent = yield* postChangeSet(admin, [missingGrant]);

            assert.strictEqual(hiddenParent.status, 422, hiddenParent.text);
            assert.strictEqual(
              asMissing(hiddenParent, hidden.id),
              asMissing(missingParent, MISSING_ID)
            );

            const after = yield* (yield* Catalog).refresh;

            assert.strictEqual(after.role(hidden.id)?.label, "hidden_role");
            assert.strictEqual(after.role(hidden.id)?.state, "active");
            assert.isUndefined(
              after.roleByName("bystander"),
              "the whole batch failed"
            );
          })
      );

      dbTest.effect(
        "the change-set endpoint checks STD-Schema-Revision: malformed is 400, a revision this database never had is 409, nothing committed",
        () =>
          Effect.gen(function* statedRevision() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const before = (yield* (yield* Catalog).refresh).key;
            const role = addRole("stated_revision");
            const parsed = parseJson(JSON.stringify({ operations: [role.op] }));
            const body: JsonValue = parsed.ok ? parsed.value : null;

            const post = (header: string) =>
              http.request("POST", CHANGE_SETS, {
                body,
                headers: { "std-schema-revision": header },
                token: admin,
              });

            const broken = yield* post("broken");

            assert.strictEqual(broken.status, 400, broken.text);
            assert.strictEqual(yield* tagOf(broken), "InvalidSchemaRevision");

            const future = yield* post(
              `${before.revision + 5}.${before.changeSetId}`
            );

            assert.strictEqual(future.status, 409, future.text);
            assert.strictEqual(yield* tagOf(future), "SchemaChanged");
            assert.deepStrictEqual(
              (yield* (yield* Catalog).refresh).key,
              before,
              "nothing committed"
            );

            const current = yield* post(
              `${before.revision}.${before.changeSetId}`
            );

            assert.strictEqual(current.status, 201, current.text);
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
        "definition writes are checked against field rules, the stated revision and If-Match",
        () =>
          Effect.gen(function* fieldRulesAndChecks() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const fixture = yield* AcmeFixture;
            const auditor = addRole("http_auditor");

            assert.strictEqual(
              (yield* postChangeSet(admin, [auditor.op])).status,
              201
            );

            // A field-level deny on core.role.label for admins.
            const snapshot = yield* (yield* Catalog).refresh;

            const label = snapshot.fieldByName(
              PLATFORM_CLASS_IDS.role,
              "label"
            );

            const deny = addAccessRule(
              PLATFORM_CLASS_IDS.role,
              [BUILT_IN_ROLE_IDS.admin],
              { fields: [label?.id ?? ""] }
            );

            const denyRule: Operation =
              deny.op.op === "createAccessRule"
                ? {
                    definition: {
                      ...deny.op.definition,
                      actions: ["update"],
                      effect: "deny",
                    },
                    op: "createAccessRule",
                  }
                : deny.op;

            assert.strictEqual(
              (yield* postChangeSet(admin, [denyRule])).status,
              201
            );

            const generic = yield* patch(admin, "core.role", auditor.id, 1, {
              label: "Auditors",
            });

            assert.strictEqual(generic.status, 403, generic.text);

            const fixed = yield* postChangeSet(admin, [
              {
                changes: { label: "Auditors" },
                id: auditor.id,
                op: "update",
                version: 1,
              },
            ]);

            assert.strictEqual(fixed.status, 403, fixed.text);
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).role(auditor.id)?.label,
              "http_auditor"
            );

            assert.strictEqual(
              (yield* remove(admin, "core.access_rule", deny.id, 1)).status,
              200
            );

            // A stale stated revision: SchemaChanged, nothing applied.
            const stale = yield* http.request(
              "PATCH",
              recordPath("core.role", auditor.id),
              {
                body: { label: "Auditors" },
                headers: {
                  "if-match": '"1"',
                  "std-schema-revision": `999999.${fixture.alice.id}`,
                },
                token: admin,
              }
            );

            assert.strictEqual(stale.status, 409, stale.text);
            assert.strictEqual(yield* tagOf(stale), "SchemaChanged");

            // A stale If-Match: VersionConflict with the current version.
            const updated = yield* patch(admin, "core.role", auditor.id, 1, {
              label: "Auditors",
            });

            assert.strictEqual(updated.status, 200, updated.text);

            const conflict = yield* patch(admin, "core.role", auditor.id, 1, {
              label: "Auditing",
            });

            assert.strictEqual(conflict.status, 409, conflict.text);
            assert.strictEqual(yield* tagOf(conflict), "VersionConflict");
            assert.include(conflict.text, '"currentVersion":2');
          })
      );

      dbTest.effect(
        "definition records get one change entry per version, with actor and operation",
        () =>
          Effect.gen(function* definitionHistory() {
            const admin = yield* adminToken;
            const fixture = yield* AcmeFixture;

            const created = yield* create(admin, "core.role", {
              name: "historian",
            });

            assert.strictEqual(created.status, 201, created.text);

            const { id } = yield* recordOf(created);

            for (const [version, label] of [
              [1, "Historian"],
              [2, "Chronicler"],
            ] as const) {
              assert.strictEqual(
                (yield* patch(admin, "core.role", id, version, { label }))
                  .status,
                200
              );
            }

            assert.deepStrictEqual(
              yield* values(
                `SELECT record_version::text || ':' || kind || ':' || actor_id::text || ':' || (operation_id IS NOT NULL)::text AS value
                 FROM core."change" WHERE record_id = $1::uuid ORDER BY record_version`,
                [id]
              ),
              [
                `1:create:${fixture.alice.id}:true`,
                `2:update:${fixture.alice.id}:true`,
                `3:update:${fixture.alice.id}:true`,
              ]
            );

            // Each entry carries the revision its change set committed.
            const committed = yield* values(
              `SELECT first_revision::text AS value FROM core."schema_change"
               WHERE operations @> jsonb_build_array(jsonb_build_object('targetId', $1::text))
               ORDER BY first_revision`,
              [id]
            );

            assert.lengthOf(committed, 3);
            assert.deepStrictEqual(
              yield* values(
                `SELECT schema_revision::text AS value FROM core."change"
                 WHERE record_id = $1::uuid ORDER BY record_version`,
                [id]
              ),
              committed
            );

            // 4.4: the old label reads back through the field definitions
            // as they were at the entry's revision.
            assert.deepStrictEqual(yield* values(HISTORY_READ_BACK, [id]), [
              "label:Historian>Chronicler",
            ]);

            // Every entry, the core set's first load included, names only
            // fields that exist at its recorded revision.
            assert.deepStrictEqual(yield* values(UNRESOLVED_HISTORY), ["0"]);
          })
      );

      dbTest.effect("SchemaBusy carries Retry-After on both paths", () =>
        Effect.scoped(
          Effect.gen(function* busy() {
            const admin = yield* adminToken;
            const database = yield* TestDatabase;
            const holder = yield* database.session("schema-key-holder");

            yield* holder.query(
              `SELECT pg_advisory_lock(${SCHEMA_KEY.toString()})`
            );

            const fixed = yield* postChangeSet(admin, [
              addField(ACME.asset, "busy_one", { kind: "text" }).op,
            ]);

            const generic = yield* create(admin, "core.field", {
              label: "Busy",
              name: "busy_two",
              required: false,
              table_id: ACME.asset,
              type: { kind: "text" },
            });

            yield* holder.query(
              `SELECT pg_advisory_unlock(${SCHEMA_KEY.toString()})`
            );

            for (const response of [fixed, generic]) {
              assert.strictEqual(response.status, 503, response.text);
              assert.strictEqual(yield* tagOf(response), "SchemaBusy");
              assert.strictEqual(response.headers.get("retry-after"), "5");
            }
          })
        )
      );

      dbTest.effect(
        "a write refused for a retired table stays NotFound for records the caller cannot see",
        () =>
          Effect.gen(function* retiredHidden() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const alice = yield* http.signIn("alice", "alice-password");
            const bob = yield* http.signIn("bob", "bob-password");
            const fixture = yield* AcmeFixture;

            yield* ensureSite;

            const gadget = createClass("hidden_gadget", {
              parentId: ACME.asset,
            });

            assert.strictEqual(
              (yield* postChangeSet(admin, [gadget.op])).status,
              201
            );

            const made = yield* create(alice, "site.hidden_gadget", {
              name: "alice's",
              owner: fixture.alice.id,
            });

            assert.strictEqual(made.status, 201, made.text);

            const record = yield* recordOf(made);

            assert.strictEqual(
              (yield* patch(admin, "core.class", gadget.id, 1, {
                state: "retired",
              })).status,
              200
            );

            const hidden = yield* patch(
              bob,
              "site.hidden_gadget",
              record.id,
              record.version,
              { name: "bob's" }
            );

            const unknown = yield* patch(
              bob,
              "site.hidden_gadget",
              fixture.alice.id,
              record.version,
              { name: "bob's" }
            );

            assert.strictEqual(hidden.status, 404);
            assert.strictEqual(hidden.text, unknown.text);

            const own = yield* patch(
              alice,
              "site.hidden_gadget",
              record.id,
              record.version,
              { name: "still alice's" }
            );

            assert.strictEqual(own.status, 403);
            assert.strictEqual(yield* tagOf(own), "NotAllowed");
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
              // Reads succeed with 200 and creates with 201; nothing else.
              assert.strictEqual(
                response.status,
                endpoint === "create" ? 201 : 200,
                response.text
              );

              const revision = headerRevision(response);

              const expected = [...addedAt]
                .flatMap(([name, at]) => (at <= revision ? [name] : []))
                .toSorted();

              const records =
                endpoint === "create"
                  ? [yield* recordOf(response)]
                  : (yield* listOf(response)).records;

              if (endpoint !== "create") {
                assert.strictEqual(
                  (yield* listOf(response)).schemaRevision,
                  revision
                );
              }

              // Through the laptop endpoint (reads and creates) every laptop
              // field of the header's revision shows, and no later one;
              // through the asset endpoint no child-only field ever does.
              for (const record of records) {
                const loadFields = Object.keys(record.values)
                  .filter((key) => key.startsWith("load_"))
                  .toSorted();

                assert.deepStrictEqual(
                  loadFields,
                  endpoint === ASSET ? [] : expected,
                  `${endpoint} at revision ${revision}`
                );
              }
            }
          })
      );

      dbTest.effect(
        "schema_purger revoked while a purge waits for CONFIG_KEY: the purge is refused and the column stays",
        () =>
          Effect.scoped(
            Effect.gen(function* purgerRevoked() {
              const admin = yield* adminToken;
              const fixture = yield* AcmeFixture;
              const catalog = yield* Catalog;
              const database = yield* TestDatabase;
              const { request } = yield* Transactions;

              const doomed = addField(ACME.asset, "purge_target", {
                kind: "text",
              });

              yield* change([doomed.op]);
              yield* change([{ id: doomed.id, op: "retire", version: 1 }]);

              yield* request(
                Effect.gen(function* grantPurger() {
                  yield* insertAsOwner(
                    yield* catalog.current,
                    USER_ROLE_CLASS_ID,
                    [
                      {
                        values: {
                          role: BUILT_IN_ROLE_IDS.schema_purger,
                          user: fixture.alice.id,
                        },
                      },
                    ]
                  );
                })
              );

              const holder = yield* database.session("config-key-holder");

              yield* holder.query("BEGIN");
              yield* holder.query(
                `SELECT pg_advisory_xact_lock_shared(${CONFIG_KEY.toString()})`
              );

              const purge = yield* Effect.forkChild(
                postChangeSet(admin, [
                  {
                    confirm: { id: doomed.id, version: 2 },
                    id: doomed.id,
                    op: "purge",
                    version: 2,
                  },
                ])
              );

              yield* waitUntil(
                values(
                  `SELECT count(*)::text AS value FROM pg_locks
                   WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'
                     AND objid = $1::oid`,
                  [String(advisoryObjectId(CONFIG_KEY))]
                ).pipe(Effect.map(([count]) => count !== "0"))
              );

              // Alice loses schema_purger, as table owner, before the commit.
              yield* holder.query(
                `DELETE FROM core."user_role" WHERE "user" = $1::uuid AND "role" = $2::uuid`,
                [fixture.alice.id, BUILT_IN_ROLE_IDS.schema_purger]
              );
              yield* holder.query("COMMIT");

              const response = yield* Fiber.join(purge);

              assert.strictEqual(response.status, 403, response.text);
              assert.strictEqual(yield* tagOf(response), "PermissionRequired");
              assert.strictEqual(
                (yield* catalog.refresh).field(doomed.id)?.state,
                "retired"
              );
              assert.deepStrictEqual(
                yield* values(
                  `SELECT count(*)::text AS value FROM information_schema.columns
                   WHERE table_schema = 'acme' AND table_name = 'asset' AND column_name = 'purge_target'`
                ),
                ["1"]
              );
            })
          )
      );

      dbTest.effect(
        "a rule revoked between the request's check and the commit refuses the write",
        () =>
          Effect.scoped(
            Effect.gen(function* revokedMeanwhile() {
              const admin = yield* adminToken;
              const database = yield* TestDatabase;
              const target = addRole("revocation_target");

              assert.strictEqual(
                (yield* postChangeSet(admin, [target.op])).status,
                201
              );

              // A session holds CONFIG_KEY shared, so the change set's main
              // transaction waits for it after the request's own check.
              const holder = yield* database.session("config-key-holder");

              yield* holder.query("BEGIN");
              yield* holder.query(
                `SELECT pg_advisory_xact_lock_shared(${CONFIG_KEY.toString()})`
              );

              const write = yield* Effect.forkChild(
                patch(admin, "core.role", target.id, 1, { label: "Revoked?" })
              );

              yield* waitUntil(
                values(
                  `SELECT count(*)::text AS value FROM pg_locks
                   WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'
                     AND objid = $1::oid`,
                  [String(advisoryObjectId(CONFIG_KEY))]
                ).pipe(Effect.map(([count]) => count !== "0"))
              );

              // Meanwhile the admin rules are revoked, as table owner, in a
              // new revision; then the lock is released.
              yield* holder.query(
                `UPDATE core."access_rule" SET active = false WHERE $1::uuid = ANY (SELECT jsonb_array_elements_text(role_ids)::uuid)`,
                [BUILT_IN_ROLE_IDS.admin]
              );
              yield* holder.query(
                "UPDATE core.config_state SET revision = revision + 1, change_set_id = uuidv7()"
              );
              yield* holder.query("COMMIT");

              const response = yield* Fiber.join(write);

              // With no rule left on core.role the table is unknown to the
              // caller (3.4), as in the request's own check. This test
              // runs last: the admin rules stay revoked.
              assert.strictEqual(response.status, 404, response.text);
              assert.strictEqual(yield* tagOf(response), "UnknownTable");
              assert.strictEqual(
                (yield* (yield* Catalog).refresh).role(target.id)?.label,
                "revocation_target"
              );
            })
          )
      );
    }
  );

  layer(readsTestLayer().pipe(Layer.provideMerge(PreparedGate.layer)), {
    excludeTestServices: true,
    timeout: 300_000,
  })((dbTest) => {
    dbTest.effect(
      "a target updated and hidden between a generic write's checks and its change set is NotFound, with no version",
      () =>
        Effect.gen(function* hiddenMeanwhile() {
          const admin = yield* adminToken;
          const gate = yield* PreparedGate;
          const target = addRole("race_target");

          yield* change([target.op]);

          const write = yield* Effect.forkChild(
            patch(admin, "core.role", target.id, 1, { label: "Mine" })
          );

          // The write passed its checks at version 1, visible. Another
          // commit now updates the role and hides it from admins.
          yield* Deferred.await(gate.reached);

          const snapshot = yield* (yield* Catalog).refresh;
          const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");

          yield* change([
            {
              changes: { label: "Theirs" },
              id: target.id,
              op: "update",
              version: 1,
            },
            hideRole(name?.id ?? "", "race_target"),
          ]);
          yield* Deferred.succeed(gate.release, true);

          const response = yield* Fiber.join(write);

          assert.strictEqual(response.status, 404, response.text);
          assert.strictEqual(yield* tagOf(response), "NotFound");
          assert.notInclude(response.text, "currentVersion");
          assert.strictEqual(
            (yield* (yield* Catalog).refresh).role(target.id)?.label,
            "Theirs"
          );
        })
    );
  });
});
