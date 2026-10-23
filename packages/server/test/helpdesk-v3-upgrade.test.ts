/** The offline v2 to v3 upgrade retains records, audit, and local customization. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import type { LayoutElement } from "@std/definitions/definition";
import type { NamedSetFile } from "@std/definitions/set-file";
import {
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_LOGIN,
  HELPDESK_CASCADE_NAME,
  HELPDESK_CASCADE_USER_ID,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
  BUILT_IN_ROLE_IDS,
} from "@std/definitions/well-known";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
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
import { Actor } from "../src/auth/actor.ts";
import { ensureUser } from "../src/auth/bootstrap-admin.ts";
import { hashPassword } from "../src/auth/password.ts";
import { Catalog, makeCatalog } from "../src/catalog/catalog.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { readSetDirectory } from "../src/config/set-files.ts";
import { ensureSetIdentities } from "../src/config/set-identities.ts";
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
import { textOf } from "./api-support.ts";
import { overridesOf } from "./config-support.ts";
import {
  HELPDESK_V3,
  recordServices,
  createTicket,
  patchTicket,
  patchResponse,
  itilLayer,
  clientFor,
} from "./itil-support.ts";
import { subscribe } from "./outbox-support.ts";
import { USERS } from "./records-support.ts";
import {
  addField,
  addRecordRule,
  change,
  freshId,
  currentRevision,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { itemsOf, TICKETS, tmf621As } from "./tmf621-support.ts";

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
      ...categorized("formRules", content.formRules),
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

const TMF621_STATUS_VALUES: readonly string[] = [
  "acknowledged",
  "rejected",
  "pending",
  "held",
  "inProgress",
  "cancelled",
  "closed",
  "resolved",
];

/** The most one TMF621 page returns (`MAX_LIMIT`, Contracts 11.1). */
const TMF621_PAGE = 1000;

const MANDATORY_OUTPUT = [
  "@type",
  "href",
  "description",
  "severity",
  "ticketType",
] as const;

/**
 * Asserts that every incident in the database is readable through TMF621
 * as the admin, with Contracts 11.2's mandatory output.
 *
 * @returns Nothing.
 */
const everyIncidentReadableThroughTmf621 = Effect.fn(
  "HelpdeskV3Upgrade.tmf621Readable"
)(function* everyIncidentReadableThroughTmf621() {
  const admin = yield* tmf621As("admin");

  const expected = yield* values(
    "SELECT id::text AS value FROM helpdesk.incident"
  );

  const seen: JsonObject[] = [];
  let offset = 0;
  let exhausted = false;

  while (!exhausted) {
    const page = yield* admin.get(
      `${TICKETS}?ticketType=incident&limit=${TMF621_PAGE}&offset=${offset}`
    );

    assert.strictEqual(page.status, 200, page.text);
    const items = itemsOf(page);

    seen.push(...items);
    offset += TMF621_PAGE;
    exhausted = items.length < TMF621_PAGE;
  }

  assert.isAtLeast(seen.length, 1000);
  assert.deepStrictEqual(
    seen.map((item) => textOf(item.id)).toSorted(),
    expected.toSorted()
  );

  for (const item of seen) {
    for (const name of MANDATORY_OUTPUT) {
      const value = item[name];

      assert.isTrue(
        value !== undefined && isJsonString(value) && value.trim() !== "",
        `${textOf(item.id)} has a non-blank ${name}`
      );
    }

    assert.include(TMF621_STATUS_VALUES, textOf(item.status));
  }
});

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

        // The upgraded incidents are all readable through TMF621 (a fresh
        // HTTP app over the refreshed catalog).
        yield* everyIncidentReadableThroughTmf621().pipe(
          Effect.provide(Layer.fresh(TestHttpClient.layer))
        );
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
    "legacy local system identities allow unrelated changes and v3 loads, are diagnosed, and fail closed at runtime",
    () =>
      Effect.gen(function* legacyIdentities() {
        const fixture = yield* HelpdeskFixture;

        const rule = addRecordRule(HELPDESK.incident, {
          actions: [
            {
              forEach: { classId: HELPDESK.incident, where: null },
              target: "self",
              type: "updateEach",
              values: [
                {
                  fieldId: HELPDESK.fields.status,
                  value: { value: "in_progress" },
                },
              ],
            },
          ],
          phase: "after",
          ruleKind: null,
        });

        yield* change([rule.op]);

        const subscription = yield* subscribe({
          classId: HELPDESK.incident,
          identityId: fixture.agent.id,
        });

        // A pre-upgrade installation could validly store these identities.
        yield* values(
          "UPDATE core.record_rule SET run_as_id = $2::uuid WHERE id = $1::uuid RETURNING id::text AS value",
          [rule.id, SYSTEM_USER_ID]
        );
        yield* values(
          "UPDATE core.subscription SET identity_id = $2::uuid WHERE id = $1::uuid RETURNING id::text AS value",
          [subscription, SYSTEM_USER_ID]
        );
        yield* (yield* Catalog).refresh;
        yield* change([
          addField(HELPDESK.incident, "unrelated", {
            kind: "text",
            maxLength: 40,
          }).op,
        ]);
        yield* loadSetDirectory(HELPDESK_V3);

        const findings = (yield* runDoctor()).findings.filter(
          (entry) => entry.code === "localServiceIdentity"
        );

        assert.sameMembers(
          findings.map((entry) => entry.subject),
          [rule.id, subscription]
        );

        for (const entry of findings) {
          assert.include(entry.message, SYSTEM_USER_ID);
          assert.include(entry.message, "ordinary user");
        }

        const ticket = yield* createTicket();

        const refused = yield* patchResponse(ticket, {
          description: "Legacy rule must not execute",
        });

        assert.strictEqual(refused.status, 403, refused.text);

        for (const entry of findings) {
          assert.strictEqual(entry.severity, "error");
        }

        // Disabled definitions never execute; retirement has the same runtime gate.
        for (const state of ["active", "retired"] as const) {
          yield* values(
            "UPDATE core.record_rule SET active = ($2 = 'retired'), state = $2 WHERE id = $1::uuid RETURNING id::text AS value",
            [rule.id, state]
          );
          yield* values(
            "UPDATE core.subscription SET enabled = ($2 = 'retired'), state = $2 WHERE id = $1::uuid RETURNING id::text AS value",
            [subscription, state]
          );
          yield* (yield* Catalog).refresh;

          const inactiveFindings = (yield* runDoctor()).findings.filter(
            (entry) => entry.code === "localServiceIdentity"
          );

          assert.sameMembers(
            inactiveFindings.map((entry) => entry.subject),
            [rule.id, subscription]
          );

          for (const entry of inactiveFindings) {
            assert.strictEqual(entry.severity, "warning");
          }

          const freshCatalog = Catalog.of(yield* makeCatalog);

          const allowed = yield* patchTicket(ticket, {
            description: `Inactive ${state} rules do not execute`,
          }).pipe(
            Effect.provide(Layer.fresh(TestHttpClient.layer)),
            Effect.provideService(Catalog, freshCatalog)
          );

          assert.strictEqual(
            allowed.description,
            `Inactive ${state} rules do not execute`
          );
        }
      }).pipe(
        Effect.provide(
          TestHttpClient.layer.pipe(
            Layer.provideMerge(helpdeskTestLayer({ version: "v2" }))
          )
        ),
        TestClock.withLive
      )
  );

  it.effect(
    "reserves the service login and ID before v3, including bootstrap and rename",
    () =>
      Effect.gen(function* reserveService() {
        const fixture = yield* HelpdeskFixture;

        for (const login of [HELPDESK_CASCADE_LOGIN, "STD-HELPDESK-CASCADE"]) {
          const created = yield* createRecord({
            body: { active: true, login, name: "Human" },
            endpointClassId: USER_CLASS_ID,
          }).pipe(Effect.flip);

          assert.strictEqual(created._tag, "NotAllowed");

          const renamed = yield* updateRecord({
            body: { login },
            endpointClassId: USER_CLASS_ID,
            expectedVersion: null,
            id: fixture.agent.id,
          }).pipe(Effect.flip);

          assert.strictEqual(renamed._tag, "NotAllowed");
          assert.strictEqual(
            (yield* ensureUser({ ...account, login }, []).pipe(Effect.flip))
              ._tag,
            "NotAllowed"
          );
        }

        const reservedId = yield* createRecord({
          body: { active: true, login: "human-service-id", name: "Human" },
          endpointClassId: USER_CLASS_ID,
          fixedId: HELPDESK_CASCADE_USER_ID,
        }).pipe(Effect.flip);

        assert.strictEqual(reservedId._tag, "NotAllowed");
      }).pipe(
        Effect.provide(
          recordServices.pipe(
            Layer.provideMerge(helpdeskTestLayer({ version: "v2" }))
          )
        ),
        TestClock.withLive
      )
  );

  it.effect(
    "names a pre-existing login collision and recovers after the operator renames it",
    () =>
      Effect.gen(function* collision() {
        const fixture = yield* HelpdeskFixture;
        yield* values(
          'UPDATE core."user" SET login = $2 WHERE id = $1::uuid RETURNING id::text AS value',
          [fixture.agent.id, "STD-HELPDESK-CASCADE"]
        );
        assert.deepStrictEqual(yield* serviceFindings, [
          "serviceIdentityLoginCollision",
        ]);
        const error = yield* loadSetDirectory(HELPDESK_V3).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SetIdentityFailed");

        if (error._tag === "SetIdentityFailed") {
          assert.strictEqual(error.conflictingUserId, fixture.agent.id);
          assert.include(error.message, fixture.agent.id);
          assert.include(error.message, "rename that user's login");
        }

        const diagnostics = (yield* runDoctor()).findings.filter(
          (entry) => entry.code === "serviceIdentityLoginCollision"
        );

        assert.lengthOf(diagnostics, 1);
        assert.include(diagnostics[0]?.message ?? "", fixture.agent.id);
        yield* updateRecord({
          body: { login: "renamed-human" },
          endpointClassId: USER_CLASS_ID,
          expectedVersion: null,
          id: fixture.agent.id,
        });
        yield* loadSetDirectory(HELPDESK_V3);
        assert.deepStrictEqual(yield* serviceFindings, []);
      }).pipe(
        Effect.provide(
          recordServices.pipe(
            Layer.provideMerge(helpdeskTestLayer({ version: "v2" }))
          )
        ),
        TestClock.withLive
      )
  );

  it.effect(
    "an unchanged v3 reload writes no service user, individual or assignment changes",
    () =>
      Effect.gen(function* unchangedIdentity() {
        const entries = values(
          'SELECT row_to_json(c)::text AS value FROM core.change c WHERE record_id = $1::uuid OR record_id IN (SELECT individual FROM core."user" WHERE id = $1::uuid) OR record_id IN (SELECT id FROM core.user_role WHERE "user" = $1::uuid) ORDER BY id',
          [HELPDESK_CASCADE_USER_ID]
        );

        const before = yield* entries;
        assert.isAtLeast(before.length, 3);
        yield* loadSetDirectory(HELPDESK_V3);
        assert.deepStrictEqual(yield* entries, before);
        assert.deepStrictEqual(yield* serviceFindings, []);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "doctor explains a retired role and provisioning waits for its restoration",
    () =>
      Effect.gen(function* inactiveRole() {
        yield* values(
          "UPDATE core.role SET state = 'retired' WHERE id = $1::uuid RETURNING id::text AS value",
          [HELPDESK_CASCADE_ROLE_ID]
        );
        yield* values(
          'UPDATE core."user" SET active = false WHERE id = $1::uuid RETURNING id::text AS value',
          [HELPDESK_CASCADE_USER_ID]
        );
        yield* (yield* Catalog).refresh;

        const findings = (yield* runDoctor()).findings.filter(
          (entry) => entry.check === 18
        );

        assert.deepStrictEqual(
          findings.map((entry) => entry.code),
          ["serviceIdentityRoleInactive"]
        );
        assert.include(findings[0]?.message ?? "", "restore from backup");
        // Raw corruption does not advance the revision; emulate a fresh CLI catalog.
        const freshCatalog = Catalog.of(yield* makeCatalog);
        assert.strictEqual(
          (yield* freshCatalog.refresh).role(HELPDESK_CASCADE_ROLE_ID)?.state,
          "retired"
        );
        yield* ensureSetIdentities().pipe(
          Effect.provideService(Catalog, freshCatalog)
        );
        assert.deepStrictEqual(yield* serviceFindings, [
          "serviceIdentityRoleInactive",
        ]);
        assert.deepStrictEqual(
          yield* values(
            'SELECT active::text AS value FROM core."user" WHERE id = $1::uuid',
            [HELPDESK_CASCADE_USER_ID]
          ),
          ["false"]
        );
        yield* values(
          "UPDATE core.role SET state = 'active' WHERE id = 'f02cabb1-cdc9-5371-81f0-d77cc1cd2ef3'::uuid RETURNING id::text AS value"
        );
        yield* (yield* Catalog).refresh;
        yield* loadSetDirectory(HELPDESK_V3);
        assert.deepStrictEqual(yield* serviceFindings, []);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

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
          identityId: USERS.alice,
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
          { login: "renamed-service" },
          { name: "Renamed service" },
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

        const systemActor = yield* updateRecord({
          body: { password: "disposable-test-password" },
          endpointClassId: USER_CLASS_ID,
          expectedVersion: null,
          id: HELPDESK_CASCADE_USER_ID,
        }).pipe(
          Effect.provideService(
            Actor,
            Actor.of({
              roleIds: [BUILT_IN_ROLE_IDS.admin],
              userId: SYSTEM_USER_ID,
            })
          ),
          Effect.flip
        );

        assert.strictEqual(systemActor._tag, "NotAllowed");

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

        for (const tokenDelivery of ["body", "cookie"]) {
          const response = yield* http.request("POST", "/api/v1/session", {
            body: {
              login: account.login,
              password: "disposable-test-password",
              tokenDelivery,
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
          (yield* http.get("/api/v1/session/current", { token })).status,
          401
        );
        assert.strictEqual(
          (yield* http.get("/api/v1/session/current", { cookie: token }))
            .status,
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
          "UPDATE core.\"user\" SET active = false, password = 'corrupt', login = 'changed-service', name = 'Changed service' WHERE id = $1::uuid RETURNING id::text AS value",
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
          "serviceIdentityNames",
          "serviceIdentityPassword",
          "serviceIdentityRoles",
          "serviceRoleAssigned",
        ]);
        yield* runUpgrade({ sets: [HELPDESK_V3] });
        assert.deepStrictEqual(yield* serviceFindings, []);
        assert.deepStrictEqual(
          yield* values(
            "SELECT login || '/' || name AS value FROM core.\"user\" WHERE id = $1::uuid",
            [HELPDESK_CASCADE_USER_ID]
          ),
          [`${HELPDESK_CASCADE_LOGIN}/${HELPDESK_CASCADE_NAME}`]
        );
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
