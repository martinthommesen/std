/** The offline v2 to v3 upgrade retains records, audit, and local customization. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import type { LayoutElement } from "@std/definitions/definition";
import type { NamedSetFile } from "@std/definitions/set-file";
import {
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
  BUILT_IN_ROLE_IDS,
} from "@std/definitions/well-known";
import type { JsonValue } from "@std/values/json-value";
import { Plaintext } from "@std/values/write-only";
import { Schema, Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import {
  HELPDESK,
  HelpdeskFixture,
  HELPDESK_SET_DIRECTORIES,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { ensureUser } from "../src/auth/bootstrap-admin.ts";
import { hashPassword } from "../src/auth/password.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { readSetDirectory } from "../src/config/set-files.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { runDataMigrations } from "../src/platform/data-migrations.ts";
import { DataMigrationFailed } from "../src/platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../src/platform/migrations.ts";
import { migration0018 } from "../src/platform/migrations/0018-helpdesk-v3.ts";
import {
  createRecord,
  updateRecord,
  deleteRecord,
} from "../src/records/save-pipeline.ts";
import { overridesOf } from "./config-support.ts";
import {
  HELPDESK_V3,
  recordServices,
  createTicket,
  patchTicket,
  itilLayer,
  clientFor,
} from "./itil-support.ts";
import { subscribe } from "./outbox-support.ts";
import {
  addField,
  change,
  freshId,
  currentRevision,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { textOf } from "./v2-support.ts";

const edit = Effect.fn("HelpdeskUpgrade.edit")(function* edit(
  id: string,
  changes: Readonly<Record<string, JsonValue>>
) {
  const snapshot = yield* (yield* Catalog).refresh;
  yield* editDefinition({
    actorId: (yield* HelpdeskFixture).admin.id,
    changes,
    id,
    version: snapshot.get(id)?.version ?? 1,
  });
});

const history = values(
  "SELECT row_to_json(c)::text AS value FROM core.change AS c WHERE record_id IN (SELECT id FROM helpdesk.ticket) ORDER BY id"
);

const preserved = values(
  `SELECT json_build_array(id, number, short_description, status, assignee, customer_email, internal_cost, resolution_notes)::text AS value FROM helpdesk.ticket ORDER BY id`
);

const countChanges = values("SELECT count(*)::text AS value FROM core.change");

const LOCAL_FORM: readonly LayoutElement[] = [
  { kind: "section", label: "Triage" },
  { fieldId: HELPDESK.fields.shortDescription, kind: "field" },
  { fieldId: HELPDESK.fields.priority, kind: "field" },
  { fieldId: HELPDESK.fields.status, kind: "field" },
  { fieldId: HELPDESK.fields.assignee, kind: "field" },
  { fieldId: HELPDESK.fields.number, kind: "field" },
];

const categorized = (
  category: string,
  entries: readonly { readonly id: string }[] = []
): [string, string][] => entries.map((entry) => [entry.id, category]);

const definitionsByCategory = (
  files: readonly NamedSetFile[]
): Map<string, string> =>
  new Map(
    files.flatMap(({ content }) => [
      ...categorized("set", content.set === undefined ? [] : [content.set]),
      ...categorized("namespaces", content.namespaces),
      ...categorized("roles", content.roles),
      ...categorized("permissions", content.permissions),
      ...categorized("grants", content.grants),
      ...categorized("accessRules", content.accessRules),
      ...categorized("recordRules", content.recordRules),
      ...categorized("subscriptions", content.subscriptions),
      ...categorized("tables", content.tables),
      ...(content.tables ?? []).flatMap((table) => [
        ...categorized("fields", table.fields),
        ...categorized("indexes", table.indexes),
        ...categorized("overrides", table.overrides),
        ...categorized("layouts", table.layouts),
        ...categorized("savedFilters", table.savedFilters),
        ...(table.fields ?? []).flatMap((field) =>
          categorized("choices", field.choices)
        ),
      ]),
    ])
  );

describe("helpdesk-v3-upgrade", () => {
  it("declares the old-key rewrite in contract rather than expand", () => {
    assert.strictEqual(migration0018.phase, "contract");
    assert.deepStrictEqual(migration0018.requiredSet, {
      minVersion: 3,
      name: "helpdesk",
    });
  });

  it.effect(
    "v2 to v3 keeps every incident, all prior history and the Step 2 choice and layout overrides",
    () =>
      Effect.gen(function* upgradeThousandIncidents() {
        // The same four customizations as the Step 2 upgrade proof.
        yield* edit(HELPDESK.choices.inProgress, { label: "Working" });
        yield* edit(HELPDESK.choices.onHold, { label: "Waiting on caller" });
        yield* edit(HELPDESK.choices.awaitingApproval, { hidden: true });
        yield* edit(HELPDESK.layouts.incidentForm, {
          elements: LOCAL_FORM.map((entry) => ({ ...entry })),
        });
        yield* runUpgrade({ sets: [HELPDESK_SET_DIRECTORIES.v2] });

        // Five fixture incidents plus 995 gives exactly 1,000, each with history.
        for (let index = 0; index < 995; index += 1) {
          const record = yield* createRecord({
            body: {
              impact: "low",
              priority: "moderate",
              short_description: `Upgrade incident ${index}`,
            },
            endpointClassId: HELPDESK.incident,
          }).pipe(Effect.provide(recordServices));

          yield* updateRecord({
            body: { status: "in_progress" },
            endpointClassId: HELPDESK.incident,
            expectedVersion: null,
            id: record.id,
          }).pipe(Effect.provide(recordServices));
        }

        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM helpdesk.incident"
          ),
          ["1000"]
        );
        const oldRows = yield* preserved;
        const oldHistory = yield* history;

        const result = yield* runUpgrade({
          dataBatchSize: 100,
          sets: [HELPDESK_V3],
        });

        assert.deepStrictEqual(result.plan.refusals, []);
        assert.strictEqual(
          result.plan.migrations.find((migration) => migration.id === 18)
            ?.state,
          "pending"
        );
        assert.strictEqual(
          result.dataMigrations.find((entry) => entry.id === 18)?.changed,
          1001
        );

        // The assignee rename changes only a physical column's name, never values.
        const newRows = yield* values(
          `SELECT json_build_array(id, number, short_description, status, assigned_to, customer_email, internal_cost, resolution_notes)::text AS value FROM helpdesk.ticket ORDER BY id`
        );

        assert.deepStrictEqual(newRows, oldRows);
        const newHistory = yield* history;
        assert.isTrue(oldHistory.every((entry) => newHistory.includes(entry)));
        assert.lengthOf(newHistory, oldHistory.length + 1001);
        assert.deepStrictEqual(
          yield* values(
            "SELECT DISTINCT priority AS value FROM helpdesk.ticket ORDER BY priority"
          ),
          ["1", "2", "3", "4"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT impact AS value FROM helpdesk.ticket WHERE id IN (SELECT id FROM helpdesk.incident WHERE legacy_impact = 'high')"
          ),
          ["1"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT hold_reason AS value FROM helpdesk.ticket WHERE status = 'on_hold'"
          ),
          ["awaiting_caller"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM helpdesk.ticket WHERE description IS NULL OR status_changed_at IS NULL OR urgency <> '3'"
          ),
          ["0"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM helpdesk.ticket WHERE status IN ('resolved','closed') AND resolved_at IS NULL"
          ),
          ["0"]
        );
        assert.deepStrictEqual(
          yield* overridesOf(HELPDESK.choices.inProgress),
          ["label=Working@In progress"]
        );
        assert.deepStrictEqual(
          yield* overridesOf(HELPDESK.choices.awaitingApproval),
          ["hidden=true@false"]
        );
        const snapshot = yield* (yield* Catalog).refresh;
        assert.deepStrictEqual(
          snapshot.get(HELPDESK.layouts.incidentForm)?.kind,
          "layout"
        );
        const layout = snapshot.get(HELPDESK.layouts.incidentForm);
        assert.deepStrictEqual(
          layout?.kind === "layout" ? layout.elements : [],
          LOCAL_FORM
        );
        assert.strictEqual(
          snapshot.get(HELPDESK.choices.onHold)?.kind,
          "choice"
        );
        assert.deepStrictEqual(yield* overridesOf(HELPDESK.choices.onHold), []);
        const beforeRerun = yield* countChanges;
        const revision = yield* currentRevision;
        const rerun = yield* runUpgrade({ sets: [HELPDESK_V3] });
        assert.deepStrictEqual(rerun.dataMigrations, []);
        assert.isUndefined(
          rerun.plan.migrations.find((migration) => migration.id === 18)
        );
        assert.deepStrictEqual(yield* countChanges, beforeRerun);
        assert.strictEqual(yield* currentRevision, revision);
        assert.strictEqual((yield* runDoctor()).exitCode, 0);
      }).pipe(
        Effect.provide(helpdeskTestLayer({ version: "v1" })),
        TestClock.withLive
      )
  );

  it.effect(
    "an interrupted v3 backfill resumes committed batches and proves remaining zero before applied",
    () =>
      Effect.gen(function* interruptedBackfill() {
        const snapshot = yield* (yield* Catalog).refresh;
        const owner = snapshot.classByName("core.user")?.owner;

        if (owner === undefined) {
          throw new Error("Missing core owner");
        }

        yield* loadSetDirectory(HELPDESK_V3, {
          required: new Map([["core", owner]]),
        });
        let batches = 0;

        const interrupted = {
          ...migration0018,
          batch: Effect.fn("HelpdeskUpgrade.interrupt")(function* batch(
            after: string | null,
            size: number
          ) {
            batches += 1;

            if (batches === 2) {
              return yield* new DataMigrationFailed({
                id: 18,
                migration: "helpdesk-v3",
                reason: "test interruption after one committed batch",
              });
            }

            return yield* migration0018.batch(after, size);
          }),
        };

        const failure = yield* runDataMigrations({
          batchSize: 2,
          migrations: PLATFORM_MIGRATIONS.map((migration) =>
            migration.id === 18 ? interrupted : migration
          ),
        }).pipe(Effect.flip);

        assert.strictEqual(failure._tag, "DataMigrationFailed");
        assert.deepStrictEqual(
          yield* values(
            "SELECT state AS value FROM core.platform_migration WHERE id = 18"
          ),
          ["running"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT progress ->> 'changed' AS value FROM core.platform_migration WHERE id = 18"
          ),
          ["2"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM helpdesk.ticket WHERE priority IN ('critical','high','moderate','low')"
          ),
          ["4"]
        );

        const incomplete = {
          ...migration0018,
          batch: () => Effect.succeed({ changed: 0, next: null }),
        };

        const proof = yield* runDataMigrations({
          migrations: PLATFORM_MIGRATIONS.map((migration) =>
            migration.id === 18 ? incomplete : migration
          ),
        }).pipe(Effect.flip);

        assert.strictEqual(proof._tag, "DataMigrationFailed");
        assert.include(proof.message, "4 records still needing the change");
        assert.deepStrictEqual(
          yield* values(
            "SELECT state AS value FROM core.platform_migration WHERE id = 18"
          ),
          ["running"]
        );

        const result = yield* runUpgrade({
          dataBatchSize: 2,
          sets: [HELPDESK_V3],
        });

        assert.strictEqual(
          result.dataMigrations.find((entry) => entry.id === 18)?.outcome,
          "resumed"
        );
        assert.strictEqual(
          result.dataMigrations.find((entry) => entry.id === 18)?.changed,
          4
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT state AS value FROM core.platform_migration WHERE id = 18"
          ),
          ["applied"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM helpdesk.ticket WHERE priority IN ('critical','high','moderate','low') OR description IS NULL OR status_changed_at IS NULL"
          ),
          ["0"]
        );
        const beforeRerun = yield* countChanges;
        yield* runUpgrade({ sets: [HELPDESK_V3] });
        assert.deepStrictEqual(yield* countChanges, beforeRerun);
      }).pipe(
        Effect.provide(helpdeskTestLayer({ version: "v2" })),
        TestClock.withLive
      )
  );
  it.effect(
    "a fresh helpdesk v3 install and unchanged reload leave doctor clean",
    () =>
      Effect.gen(function* freshHelpdesk() {
        yield* runUpgrade({ sets: [HELPDESK_V3] });
        const snapshot = yield* (yield* Catalog).refresh;
        assert.isDefined(snapshot.classByName("helpdesk.problem"));
        assert.isDefined(snapshot.classByName("helpdesk.ticket_note"));
        assert.strictEqual(
          snapshot
            .recordRulesOf(HELPDESK.incident)
            .filter((rule) => rule.ruleKind === "guard").length,
          6
        );
        assert.isTrue(
          snapshot
            .recordRulesOf(HELPDESK.ticket)
            .some(
              (rule) =>
                rule.name === "description_required" &&
                rule.ruleKind === "invariant"
            )
        );
        assert.strictEqual(
          snapshot
            .recordRulesOf(snapshot.classByName("helpdesk.problem")?.id ?? "")
            .filter((rule) => rule.ruleKind === "guard").length,
          8
        );
        const revision = yield* currentRevision;
        yield* runUpgrade({ sets: [HELPDESK_V3] });
        assert.strictEqual(yield* currentRevision, revision);
        assert.strictEqual((yield* runDoctor()).exitCode, 0);
      }).pipe(Effect.provide(schemaTestLayer()), TestClock.withLive)
  );
  it.effect(
    "a later upgrade preserves v3 impact and a deliberately cleared status date",
    () =>
      Effect.gen(function* preserveV3() {
        const created = yield* createTicket("helpdeskIncident", {
          impact: "1",
        });

        const cleared = yield* patchTicket(created, { statusChangedAt: null });
        const before = yield* countChanges;
        const result = yield* runUpgrade({ sets: [HELPDESK_V3] });
        assert.deepStrictEqual(result.dataMigrations, []);
        const client = yield* clientFor();

        const after = yield* client.records.get({
          params: { id: textOf(created.id), table: "helpdeskIncident" },
          query: {},
        });

        assert.deepStrictEqual(after, cleared);
        assert.strictEqual(after.impact, "1");
        assert.notProperty(after, "statusChangedAt");
        assert.deepStrictEqual(yield* countChanges, before);
        assert.deepStrictEqual(
          yield* values(
            "SELECT state AS value FROM core.platform_migration WHERE id = 18"
          ),
          ["applied"]
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "legacy local priority keys still receive missing descriptions and status dates",
    () =>
      Effect.gen(function* localPriority() {
        yield* change([
          {
            definition: {
              fieldId: HELPDESK.fields.priority,
              hidden: false,
              id: freshId(),
              key: "local_priority",
              kind: "choice",
              label: "Local priority",
              order: 99,
              owner: { layer: "local" },
              protected: false,
            },
            op: "createChoice",
          },
        ]);

        const ticket = yield* createRecord({
          body: {
            priority: "local_priority",
            short_description: "Local priority legacy ticket",
          },
          endpointClassId: HELPDESK.ticket,
        }).pipe(Effect.provide(recordServices));

        yield* runUpgrade({ sets: [HELPDESK_V3] });
        assert.deepStrictEqual(
          yield* values(
            "SELECT description AS value FROM helpdesk.ticket WHERE id = $1::uuid",
            [ticket.id]
          ),
          ["Local priority legacy ticket"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM helpdesk.ticket WHERE id = $1::uuid AND status_changed_at IS NOT NULL AND priority = 'local_priority'",
            [ticket.id]
          ),
          ["1"]
        );

        const saved = yield* updateRecord({
          body: { resolution_notes: "Editable after upgrade" },
          endpointClassId: HELPDESK.ticket,
          expectedVersion: null,
          id: ticket.id,
        }).pipe(Effect.provide(recordServices));

        assert.strictEqual(saved.outcome, "updated");
      }).pipe(
        Effect.provide(helpdeskTestLayer({ version: "v2" })),
        TestClock.withLive
      )
  );

  it.effect(
    "unknown legacy impact fails as DataMigrationFailed naming the record and rolls back its batch",
    () =>
      Effect.gen(function* invalidImpact() {
        yield* change([
          {
            definition: {
              fieldId: HELPDESK.fields.impact,
              hidden: false,
              id: freshId(),
              key: "local_impact",
              kind: "choice",
              label: "Local impact",
              order: 99,
              owner: { layer: "local" },
              protected: false,
            },
            op: "createChoice",
          },
        ]);

        const ticket = yield* createRecord({
          body: {
            impact: "local_impact",
            priority: "low",
            short_description: "Local impact legacy incident",
          },
          endpointClassId: HELPDESK.incident,
        }).pipe(Effect.provide(recordServices));

        const failure = yield* runUpgrade({ sets: [HELPDESK_V3] }).pipe(
          Effect.flip
        );

        assert.strictEqual(failure._tag, "DataMigrationFailed");
        assert.include(failure.message, ticket.id);
        assert.include(failure.message, "unknown legacy impact local_impact");
        assert.deepStrictEqual(
          yield* values(
            "SELECT state AS value FROM core.platform_migration WHERE id = 18"
          ),
          ["running"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT priority AS value FROM helpdesk.ticket WHERE id = $1::uuid",
            [ticket.id]
          ),
          ["low"]
        );
      }).pipe(
        Effect.provide(helpdeskTestLayer({ version: "v2" })),
        TestClock.withLive
      )
  );

  it.effect(
    "the upgrade partition covers exactly the new set definition IDs",
    () =>
      Effect.gen(function* partitionCoverage() {
        const before = new Set(
          definitionsByCategory(
            yield* readSetDirectory(HELPDESK_SET_DIRECTORIES.v2)
          ).keys()
        );

        const after = definitionsByCategory(
          yield* readSetDirectory(HELPDESK_V3)
        );

        const delta = [...after.keys()]
          .filter((id) => !before.has(id))
          .toSorted();

        const partition = yield* Effect.tryPromise(
          async () =>
            await readFile(
              new URL(
                "../../../examples/helpdesk/upgrade-v3.json",
                import.meta.url
              ),
              "utf-8"
            )
        );

        const parsed = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              additive: Schema.Array(
                Schema.Struct({ category: Schema.String, id: Schema.String })
              ),
              behavior: Schema.Array(
                Schema.Struct({ category: Schema.String, id: Schema.String })
              ),
            })
          )
        )(partition);

        const entries = [...parsed.additive, ...parsed.behavior];

        for (const entry of entries) {
          assert.strictEqual(
            entry.category,
            after.get(entry.id),
            `Category of ${entry.id}`
          );
        }

        const listed = entries.map((entry) => entry.id).toSorted();
        assert.deepStrictEqual(
          listed.filter((id) => !before.has(id)),
          delta
        );
        assert.strictEqual(new Set(listed).size, listed.length);
      })
  );
});

const account = {
  login: "std-helpdesk-cascade",
  name: "Must not replace service",
  password: Redacted.make("disposable-test-password"),
};

const roleRows = values(
  'SELECT id::text AS value FROM core.user_role WHERE "user" = $1::uuid',
  [HELPDESK_CASCADE_USER_ID]
);

const serviceFindings = Effect.gen(function* serviceFindings() {
  return (yield* runDoctor()).findings
    .filter((entry) => entry.check === 18)
    .map((entry) => entry.code)
    .toSorted();
});

describe("helpdesk-service-identity", () => {
  it.effect(
    "a direct v3 set load creates and repairs a missing identity through the pipeline with local fields and outbox delivery",
    () =>
      Effect.gen(function* loadWithoutDataMigration() {
        yield* runUpgrade();
        yield* change([
          addField(
            USER_CLASS_ID,
            "local_required",
            { kind: "text", maxLength: 40 },
            { default: "local-default", required: true }
          ).op,
        ]);

        const subscription = yield* subscribe({
          classId: USER_CLASS_ID,
          identityId: SYSTEM_USER_ID,
          operations: ["create"],
        });

        yield* loadSetDirectory(HELPDESK_V3);
        assert.deepStrictEqual(
          yield* values(
            'SELECT local_required AS value FROM core."user" WHERE id = $1::uuid',
            [HELPDESK_CASCADE_USER_ID]
          ),
          ["local-default"]
        );
        assert.deepStrictEqual(
          yield* values(
            'SELECT count(*)::text AS value FROM core."user" u JOIN core.individual i ON i.id = u.individual WHERE u.id = $1::uuid',
            [HELPDESK_CASCADE_USER_ID]
          ),
          ["1"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT actor_id::text AS value FROM core.change WHERE record_id = $1::uuid AND kind = 'create'",
            [HELPDESK_CASCADE_USER_ID]
          ),
          [SYSTEM_USER_ID]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM core.delivery WHERE record_id = $1::uuid AND subscription_id = $2::uuid",
            [HELPDESK_CASCADE_USER_ID, subscription]
          ),
          ["1"]
        );
        yield* values(
          'DELETE FROM core.user_role WHERE "user" = $1::uuid RETURNING id::text AS value',
          [HELPDESK_CASCADE_USER_ID]
        );
        yield* values(
          'DELETE FROM core."user" WHERE id = $1::uuid RETURNING id::text AS value',
          [HELPDESK_CASCADE_USER_ID]
        );
        assert.deepStrictEqual(yield* serviceFindings, [
          "serviceIdentityMissing",
          "serviceIdentityRoles",
        ]);
        yield* loadSetDirectory(HELPDESK_V3);
        assert.deepStrictEqual(yield* serviceFindings, []);
        assert.deepStrictEqual(
          yield* values(
            "SELECT count(*)::text AS value FROM core.delivery WHERE record_id = $1::uuid AND subscription_id = $2::uuid",
            [HELPDESK_CASCADE_USER_ID, subscription]
          ),
          ["2"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT record_version::text AS value FROM core.change WHERE record_id = $1::uuid ORDER BY record_version",
            [HELPDESK_CASCADE_USER_ID]
          ),
          ["1", "2"]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT cause ->> 'kind' AS value FROM core.change WHERE record_id = $1::uuid ORDER BY record_version",
            [HELPDESK_CASCADE_USER_ID]
          ),
          ["system", "system"]
        );
      }).pipe(Effect.provide(schemaTestLayer()), TestClock.withLive)
  );

  it.effect(
    "refuses password and activity changes, deletion, and reserved role assignment mutations",
    () =>
      Effect.gen(function* protectedWrites() {
        const fixture = yield* HelpdeskFixture;

        for (const body of [
          { password: "disposable-test-password" },
          { active: false },
        ]) {
          const error = yield* updateRecord({
            body,
            endpointClassId: USER_CLASS_ID,
            expectedVersion: null,
            id: HELPDESK_CASCADE_USER_ID,
          }).pipe(Effect.flip);

          assert.strictEqual(error._tag, "NotAllowed");
        }

        const deleted = yield* deleteRecord({
          endpointClassId: USER_CLASS_ID,
          expectedVersion: 1,
          id: HELPDESK_CASCADE_USER_ID,
        }).pipe(Effect.flip);

        assert.strictEqual(deleted._tag, "NotAllowed");

        for (const body of [
          { role: HELPDESK_CASCADE_ROLE_ID, user: fixture.agent.id },
          { role: BUILT_IN_ROLE_IDS.admin, user: HELPDESK_CASCADE_USER_ID },
        ]) {
          const error = yield* createRecord({
            body,
            endpointClassId: USER_ROLE_CLASS_ID,
          }).pipe(Effect.flip);

          assert.strictEqual(error._tag, "NotAllowed");
        }

        const [assignment] = yield* roleRows;
        assert.isDefined(assignment);

        const reassigned = yield* updateRecord({
          body: { user: fixture.agent.id },
          endpointClassId: USER_ROLE_CLASS_ID,
          expectedVersion: null,
          id: assignment ?? "",
        }).pipe(Effect.flip);

        assert.strictEqual(reassigned._tag, "NotAllowed");

        const removed = yield* deleteRecord({
          endpointClassId: USER_ROLE_CLASS_ID,
          expectedVersion: 1,
          id: assignment ?? "",
        }).pipe(Effect.flip);

        assert.strictEqual(removed._tag, "NotAllowed");
        assert.deepStrictEqual(yield* serviceFindings, []);
      }).pipe(
        Effect.provide(recordServices.pipe(Layer.provideMerge(itilLayer))),
        TestClock.withLive
      )
  );

  it.effect(
    "refuses password sign-in, cookie sign-in, forged bearer/cookie sessions, and bootstrap",
    () =>
      Effect.gen(function* serviceSessions() {
        // A database owner bypasses record protections: authentication still refuses the reserved ID.
        const hash = yield* hashPassword(
          new Plaintext("disposable-test-password")
        );

        yield* values(
          'UPDATE core."user" SET password = $2 WHERE id = $1::uuid RETURNING id::text AS value',
          [HELPDESK_CASCADE_USER_ID, hash]
        );
        const http = yield* TestHttpClient;

        for (const path of [
          "/api/v1/auth/sign-in",
          "/api/v1/auth/cookie-sign-in",
        ]) {
          const response = yield* http.request("POST", path, {
            body: {
              login: account.login,
              password: "disposable-test-password",
            },
            headers: { "STD-Client": "web" },
          });

          assert.strictEqual(response.status, 401);
          assert.lengthOf(response.headers.getSetCookie(), 0);
        }

        const token = "a".repeat(43);
        const digest = `\\x${createHash("sha256").update(token).digest("hex")}`;
        yield* values(
          "INSERT INTO core.session (token_hash, user_id, created_at, expires_at) VALUES ($1::bytea, $2::uuid, now(), now() + interval '1 hour') RETURNING user_id::text AS value",
          [digest, HELPDESK_CASCADE_USER_ID]
        );
        assert.strictEqual(
          (yield* http.get("/api/v1/auth/me", { token })).status,
          401
        );
        assert.strictEqual(
          (yield* http.get("/api/v1/auth/me", { cookie: token })).status,
          401
        );
        assert.strictEqual(
          (yield* ensureUser(account, [BUILT_IN_ROLE_IDS.admin]).pipe(
            Effect.flip
          ))._tag,
          "NotAllowed"
        );
        assert.strictEqual(
          (yield* ensureUser({ ...account, login: "human" }, [
            HELPDESK_CASCADE_ROLE_ID,
          ]).pipe(Effect.flip))._tag,
          "NotAllowed"
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "doctor reports corrupt service properties and unchanged v3 reload repairs them with audited saves",
    () =>
      Effect.gen(function* repairService() {
        const fixture = yield* HelpdeskFixture;
        yield* values(
          "UPDATE core.\"user\" SET active = false, password = 'corrupt' WHERE id = $1::uuid RETURNING id::text AS value",
          [HELPDESK_CASCADE_USER_ID]
        );
        yield* values(
          'UPDATE core.user_role SET role = $2::uuid WHERE "user" = $1::uuid RETURNING id::text AS value',
          [HELPDESK_CASCADE_USER_ID, BUILT_IN_ROLE_IDS.admin]
        );
        yield* values(
          'INSERT INTO core.user_role (id, class_id, version, created_at, updated_at, created_by, updated_by, "user", role) VALUES (uuidv7(), $1::uuid, 1, now(), now(), $2::uuid, $2::uuid, $3::uuid, $4::uuid) RETURNING id::text AS value',
          [
            USER_ROLE_CLASS_ID,
            SYSTEM_USER_ID,
            fixture.agent.id,
            HELPDESK_CASCADE_ROLE_ID,
          ]
        );
        assert.deepStrictEqual(yield* serviceFindings, [
          "serviceIdentityInactive",
          "serviceIdentityPassword",
          "serviceIdentityRoles",
          "serviceRoleAssigned",
        ]);
        yield* runUpgrade({ sets: [HELPDESK_V3] });
        assert.deepStrictEqual(yield* serviceFindings, []);
        assert.deepStrictEqual(
          yield* values(
            "SELECT actor_id::text AS value FROM core.change WHERE record_id = $1::uuid AND record_version = 2",
            [HELPDESK_CASCADE_USER_ID]
          ),
          [SYSTEM_USER_ID]
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT cause::text AS value FROM core.change WHERE record_id = $1::uuid AND record_version = 2",
            [HELPDESK_CASCADE_USER_ID]
          ),
          ['{"kind": "system"}']
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
