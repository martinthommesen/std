import { readFile } from "node:fs/promises";

/** The offline v2 to v3 upgrade retains records, audit, and local customization. */
import { assert, describe, it } from "@effect/vitest";
import type { LayoutElement } from "@std/definitions/definition";
import type { NamedSetFile } from "@std/definitions/set-file";
import type { JsonValue } from "@std/values/json-value";
import { Schema, Effect } from "effect";
import { TestClock } from "effect/testing";

import {
  HELPDESK,
  HelpdeskFixture,
  HELPDESK_SET_DIRECTORIES,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
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
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import { overridesOf } from "./config-support.ts";
import {
  HELPDESK_V3,
  recordServices,
  createTicket,
  patchTicket,
  itilLayer,
  clientFor,
} from "./itil-support.ts";
import { currentRevision, schemaTestLayer, values } from "./schema-support.ts";
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

const definitionIds = (files: readonly NamedSetFile[]): string[] =>
  files.flatMap(({ content }) => {
    const roots = [
      ...(content.set === undefined ? [] : [content.set]),
      ...(content.namespaces ?? []),
      ...(content.roles ?? []),
      ...(content.permissions ?? []),
      ...(content.grants ?? []),
      ...(content.accessRules ?? []),
      ...(content.recordRules ?? []),
      ...(content.subscriptions ?? []),
      ...(content.tables ?? []),
    ];

    const nested = (content.tables ?? []).flatMap((table) => [
      ...(table.fields ?? []),
      ...(table.indexes ?? []),
      ...(table.overrides ?? []),
      ...(table.layouts ?? []),
      ...(table.savedFilters ?? []),
      ...(table.fields ?? []).flatMap((field) => field.choices ?? []),
    ]);

    return [...roots, ...nested].map((entry) => entry.id);
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
    "the upgrade partition covers exactly the new set definition IDs",
    () =>
      Effect.gen(function* partitionCoverage() {
        const before = new Set(
          definitionIds(yield* readSetDirectory(HELPDESK_SET_DIRECTORIES.v2))
        );

        const after = new Set(
          definitionIds(yield* readSetDirectory(HELPDESK_V3))
        );

        const delta = [...after].filter((id) => !before.has(id)).toSorted();

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

        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              additive: Schema.Array(Schema.Struct({ id: Schema.String })),
              behavior: Schema.Array(Schema.Struct({ id: Schema.String })),
            })
          )
        )(partition);

        const listed = [...parsed.additive, ...parsed.behavior]
          .flatMap((entry) => (before.has(entry.id) ? [] : [entry.id]))
          .toSorted();

        assert.deepStrictEqual(listed, delta);
        assert.strictEqual(new Set(listed).size, listed.length);
      })
  );
});
