/**
 * The system user's history starts with a complete create (Contracts 4.2,
 * 4.5; decision 0023, review round 3 finding 1).
 *
 * - A fresh install: the change set that creates `core.user` inserts the
 *   system user and its version-1 create entry together.
 * - An upgraded database, whose system user predates that: `data`
 *   migration 0015 writes the same entry, once.
 * - Why it matters: a subscription on `core.user` whose identity is denied
 *   active users gets the system user's rename with its name, because the
 *   system user's `active` (false) is known from that entry; without it the
 *   rule could not decide and the payload would be empty.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { AccessRuleDraft } from "@std/definitions/definition";
import {
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_FIELD_IDS,
} from "@std/definitions/well-known";
import { Effect, Ref, Schema } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import type { Delivery } from "../src/outbox/delivery-effects.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { runDataMigrations } from "../src/platform/data-migrations.ts";
import { updateRecord } from "../src/records/save-pipeline.ts";
import { subscribe } from "./outbox-support.ts";
import { change, freshId, values } from "./schema-support.ts";
import { actingAs, serveOnly, workerTestLayer } from "./worker-support.ts";

/** The fields the system user's create entry records. */
const EXPECTED_FIELDS = {
  [USER_FIELD_IDS.active]: { after: false, before: null },
  [USER_FIELD_IDS.login]: { after: "system", before: null },
  [USER_FIELD_IDS.name]: { after: "System", before: null },
};

const EntrySchema = Schema.Struct({
  actor: Schema.String,
  cause: Schema.Unknown,
  class: Schema.String,
  fields: Schema.Unknown,
  kind: Schema.String,
  revision: Schema.Number,
});

const decodeEntry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EntrySchema)
);

/** The system user's version-1 entry, as one JSON object. */
const createEntry = values(
  `SELECT json_build_object('kind', kind, 'actor', actor_id::text,
     'class', record_class_id::text, 'revision', schema_revision,
     'cause', cause, 'fields', fields)::text AS value
   FROM core."change"
   WHERE record_id = $1::uuid AND record_version = 1`,
  [SYSTEM_USER_ID]
).pipe(
  // oxlint-disable-next-line github/array-foreach, unicorn/no-array-method-this-argument -- Effect.forEach, not Array.prototype.forEach
  Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeEntry(row))),
  Effect.orDie
);

const userCreatedAt = values(
  `SELECT min(revision)::text AS value FROM core.definition_revision
   WHERE definition_id = $1::uuid`,
  [USER_CLASS_ID]
).pipe(Effect.map(([revision]) => Number(revision)));

const freshInstall = Effect.gen(function* freshInstallTest() {
  const [entry] = yield* createEntry;

  assert.deepStrictEqual(entry, {
    actor: SYSTEM_USER_ID,
    cause: { kind: "system" },
    class: USER_CLASS_ID,
    fields: EXPECTED_FIELDS,
    kind: "create",
    revision: yield* userCreatedAt,
  });
});

const renamePayload = Effect.gen(function* renamePayloadTest() {
  const fixture = yield* AcmeFixture;
  const delivered = yield* Ref.make<readonly Delivery[]>([]);

  const employeeId =
    (yield* (yield* Catalog).refresh).roleByName("employee")?.id ?? "";

  const deny: AccessRuleDraft = {
    actions: ["read"],
    active: true,
    classId: USER_CLASS_ID,
    condition: {
      left: { path: [USER_FIELD_IDS.active] },
      op: "eq",
      right: { value: true },
    },
    description: null,
    effect: "deny",
    id: freshId(),
    kind: "accessRule",
    name: null,
    owner: { layer: "local" },
    protected: false,
    roleIds: [employeeId],
    target: { kind: "records" },
  };

  yield* change([{ definition: deny, op: "createAccessRule" }]);

  const subscription = yield* subscribe({
    classId: USER_CLASS_ID,
    identityId: fixture.bob.id,
    operations: ["update"],
  });

  yield* serveOnly(subscription, {
    kind: "external",
    run: (delivery: Delivery) =>
      Ref.update(delivered, (all) => [...all, delivery]),
  });

  const [version] = yield* values(
    `SELECT version::text AS value FROM core."user" WHERE id = $1::uuid`,
    [SYSTEM_USER_ID]
  );

  yield* updateRecord({
    body: { name: "System (renamed)" },
    endpointClassId: USER_CLASS_ID,
    expectedVersion: Number(version),
    id: SYSTEM_USER_ID,
  }).pipe(actingAs(fixture.admin.id));

  assert.strictEqual(yield* workerPass(), 1);

  const [rename] = yield* Ref.get(delivered);

  assert.isTrue(rename?.payload.visible, "the inactive system user is visible");
  assert.strictEqual(
    rename?.payload.image[USER_FIELD_IDS.name],
    "System (renamed)"
  );
});

const upgradedDatabase = Effect.gen(function* upgradedDatabaseTest() {
  const [fresh] = yield* createEntry;

  // An installation from before the fix: no version-1 entry, migration
  // 0015 not yet in the ledger.
  yield* values(
    `DELETE FROM core."change" WHERE record_id = $1::uuid AND record_version = 1
     RETURNING id::text AS value`,
    [SYSTEM_USER_ID]
  );
  yield* values(
    `DELETE FROM core.platform_migration WHERE id = 15 RETURNING id::text AS value`
  );
  assert.deepStrictEqual(yield* createEntry, []);

  const outcomes = yield* runDataMigrations();

  assert.deepStrictEqual(
    outcomes
      .filter((outcome) => outcome.id === 15)
      .map((outcome) => [outcome.outcome, outcome.changed]),
    [["applied", 1]]
  );

  const [restored] = yield* createEntry;

  const withoutCause = (entry: typeof restored) =>
    entry === undefined
      ? null
      : {
          actor: entry.actor,
          class: entry.class,
          fields: entry.fields,
          kind: entry.kind,
          revision: entry.revision,
        };

  assert.deepStrictEqual(
    withoutCause(restored),
    withoutCause(fresh),
    "the same entry as a fresh install's"
  );
  assert.deepStrictEqual(restored?.cause, {
    kind: "system",
    migration: { id: 15, name: "system-user-history" },
  });

  // A rerun finds nothing to do.
  yield* runDataMigrations();
  assert.lengthOf(yield* createEntry, 1);
});

describe("system-user-history", () => {
  it("expects the values the system user is inserted with", () => {
    assert.lengthOf(Object.keys(EXPECTED_FIELDS), 3);
  });

  layer(workerTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a fresh install writes the system user's version-1 create entry with the user",
      () => freshInstall
    );

    dbTest.effect(
      "a subscription identity denied active users gets the system user's rename with its name",
      () => renamePayload
    );

    dbTest.effect(
      "an upgraded database gets the same entry from data migration 0015, once",
      () => upgradedDatabase
    );
  });
});
