/**
 * The helpdesk v1 to v2 upgrade test (plan Step 2 gate and workstream 2D:
 * "the helpdesk v1 to v2 upgrade test passes with local overrides on a
 * choice and a layout"; Contracts 8.2, 8.4, 8.5; decisions 0012, 0017).
 *
 * v1 is installed with `std upgrade`'s code; an admin then overrides, on
 * shipped records:
 *
 * - the status choice `in_progress`'s label ("Working"), which v2 changes
 *   too: a conflict; the local label stays effective;
 * - the status choice `on_hold`'s label ("Waiting on caller"), which v2
 *   ships as the same value: converged, the override dropped;
 * - the status choice `awaiting_approval`'s `hidden`, which v2 leaves
 *   alone: kept;
 * - the incident form layout's element list, which v2 changes: a conflict
 *   on the one `elements` property; the local layout stays effective whole,
 *   without v2's new section and field.
 *
 * v2 also renames `assigned_to` to `assignee`, adds a status, a field and
 * an access rule, changes the incident list layout (not overridden:
 * applied) and relabels the role. The plan reports exactly the expected
 * conflicts, convergence and security changes, and the run applies that
 * plan; rerunning changes nothing, the revision included; `std doctor`
 * exits 0.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { LayoutElement } from "@std/definitions/definition";
import { effectiveLayout } from "@std/definitions/effective-schema";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import {
  HELPDESK,
  HELPDESK_SET_DIRECTORIES,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { planUpgrade, runUpgrade } from "../src/config/upgrade.ts";
import { runCli } from "./cli-support.ts";
import {
  ADMIN,
  conflictsOf,
  insertAdmin,
  overridesOf,
} from "./config-support.ts";
import { definitionVersion } from "./schema-paths-support.ts";
import { currentRevision, schemaTestLayer, values } from "./schema-support.ts";

const { choices, fields, layouts } = HELPDESK;

/** The admin's incident form: no Details section, no internal cost. */
const LOCAL_FORM: readonly LayoutElement[] = [
  { kind: "section", label: "Triage" },
  { fieldId: fields.shortDescription, kind: "field" },
  { fieldId: fields.priority, kind: "field" },
  { fieldId: fields.status, kind: "field" },
  { fieldId: fields.assignee, kind: "field" },
  { fieldId: fields.number, kind: "field" },
];

const edit = (id: string, changes: Record<string, JsonValue>) =>
  Effect.gen(function* editShipped() {
    return yield* editDefinition({
      actorId: ADMIN,
      changes,
      id,
      version: yield* definitionVersion(id),
    });
  });

const choiceState = (id: string) =>
  values(
    "SELECT label || ' ' || hidden::text AS value FROM core.choice WHERE id = $1::uuid",
    [id]
  ).pipe(Effect.map(([value]) => value));

const fieldIds = (elements: readonly LayoutElement[] | undefined) =>
  (elements ?? []).map((element) =>
    element.kind === "field" ? element.fieldId : `#${element.label}`
  );

const layoutOf = (classId: string, type: "form" | "list") =>
  Effect.gen(function* readLayout() {
    const snapshot = yield* (yield* Catalog).refresh;

    return fieldIds(effectiveLayout(snapshot, classId, type)?.elements);
  });

describe("helpdesk-upgrade", () => {
  it("shows a layout as field IDs and section labels", () => {
    assert.deepStrictEqual(
      fieldIds([
        { kind: "section", label: "Main" },
        { fieldId: fields.number, kind: "field" },
      ]),
      ["#Main", fields.number]
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "helpdesk v1 to v2 with local overrides on choices and a layout: conflicts, convergence, security changes, an idempotent rerun, doctor clean",
      () =>
        Effect.gen(function* helpdeskUpgrade() {
          yield* runUpgrade({ sets: [HELPDESK_SET_DIRECTORIES.v1] });
          yield* insertAdmin;

          // Local overrides on shipped choices and a shipped layout.
          yield* edit(choices.inProgress, { label: "Working" });
          yield* edit(choices.onHold, { label: "Waiting on caller" });
          yield* edit(choices.awaitingApproval, { hidden: true });
          yield* edit(layouts.incidentForm, {
            elements: LOCAL_FORM.map((element) => ({ ...element })),
          });

          assert.deepStrictEqual(yield* overridesOf(choices.inProgress), [
            "label=Working@In progress",
          ]);
          assert.lengthOf(yield* overridesOf(layouts.incidentForm), 1);

          const plan = yield* planUpgrade({
            sets: [HELPDESK_SET_DIRECTORIES.v2],
          });

          const helpdesk = plan.sets.find((set) => set.name === "helpdesk");

          assert.deepStrictEqual(plan.refusals, []);
          assert.strictEqual(helpdesk?.fromVersion, 1);
          assert.strictEqual(helpdesk?.toVersion, 2);

          // Exactly two conflicts: the relabelled choice and the layout,
          // whose element list is one property.
          assert.deepStrictEqual(
            helpdesk?.conflicts
              .map((entry) => `${entry.recordId} ${entry.property}`)
              .toSorted(),
            [
              `${choices.inProgress} label`,
              `${layouts.incidentForm} elements`,
            ].toSorted()
          );

          const choiceConflict = helpdesk?.conflicts.find(
            (entry) => entry.recordId === choices.inProgress
          );

          assert.deepStrictEqual(
            [
              choiceConflict?.oldShipped,
              choiceConflict?.newShipped,
              choiceConflict?.local,
            ],
            ["In progress", "Work in progress", "Working"]
          );
          assert.strictEqual(
            choiceConflict?.name,
            "choice in_progress of helpdesk.ticket.status"
          );

          const layoutConflict = helpdesk?.conflicts.find(
            (entry) => entry.recordId === layouts.incidentForm
          );

          assert.deepStrictEqual(layoutConflict?.local, LOCAL_FORM);
          assert.include(
            JSON.stringify(layoutConflict?.newShipped),
            fields.resolutionNotes
          );
          assert.deepStrictEqual(
            helpdesk?.converged.map((entry) => [
              entry.recordId,
              entry.property,
            ]),
            [[choices.onHold, "label"]]
          );
          // `hidden` on `awaiting_approval`: v2 ships it unchanged, so the
          // override simply stays (checked below), with nothing to report.
          assert.deepStrictEqual(helpdesk?.kept, []);

          // The "open" filters that now exclude `canceled` are ordinary
          // updates of their condition: no override, so no conflict.
          assert.deepStrictEqual(
            helpdesk?.changes
              .filter((entry) => entry.kind === "savedFilter")
              .map(
                (entry) =>
                  `${entry.action} ${entry.id} ${entry.properties.join(",")}`
              )
              .toSorted(),
            [
              `updated ${HELPDESK.savedFilters.criticalOpen} condition`,
              `updated ${HELPDESK.savedFilters.unassigned} condition`,
            ].toSorted()
          );

          // Security changes: the new access rule and the relabelled role,
          // nothing else (the rename, choices and layouts are not security).
          assert.deepStrictEqual(
            plan.security
              .map((entry) => `${entry.change} ${entry.kind} ${entry.id}`)
              .toSorted(),
            [
              `created accessRule ${HELPDESK.rules.customerEmail}`,
              `updated role ${HELPDESK.agentRole}`,
            ].toSorted()
          );

          const report = yield* runUpgrade({
            expectedPlanHash: plan.hash,
            sets: [HELPDESK_SET_DIRECTORIES.v2],
          });

          assert.deepStrictEqual(report.plan, plan, "the run applies the plan");

          // Choices: local label kept with an open conflict; converged
          // override gone with a `converged` entry; hidden kept; the new
          // choice is there.
          assert.strictEqual(
            yield* choiceState(choices.inProgress),
            "Working false"
          );
          assert.deepStrictEqual(yield* conflictsOf(choices.inProgress), [
            "open - label In progress>Work in progress Working",
          ]);
          assert.strictEqual(
            yield* choiceState(choices.onHold),
            "Waiting on caller false"
          );
          assert.deepStrictEqual(yield* overridesOf(choices.onHold), []);
          assert.deepStrictEqual(yield* conflictsOf(choices.onHold), [
            "resolved converged label On hold>Waiting on caller Waiting on caller",
          ]);
          assert.strictEqual(
            yield* choiceState(choices.awaitingApproval),
            "Awaiting approval true"
          );
          assert.deepStrictEqual(yield* overridesOf(choices.awaitingApproval), [
            "hidden=true@false",
          ]);
          assert.strictEqual(
            yield* choiceState(choices.canceled),
            "Canceled false"
          );

          // The overridden layout stays whole: exactly the local list, none
          // of v2's additions; the list layout, not overridden, is v2's.
          assert.deepStrictEqual(
            yield* layoutOf(HELPDESK.incident, "form"),
            fieldIds(LOCAL_FORM)
          );
          assert.deepStrictEqual(yield* layoutOf(HELPDESK.incident, "list"), [
            fields.number,
            fields.shortDescription,
            fields.category,
            fields.impact,
            fields.priority,
            fields.status,
            fields.assignee,
          ]);
          assert.lengthOf(yield* conflictsOf(layouts.incidentForm), 1);

          // The rename went by ID.
          const snapshot = yield* (yield* Catalog).refresh;

          assert.strictEqual(snapshot.field(fields.assignee)?.name, "assignee");
          assert.strictEqual(
            snapshot.field(fields.resolutionNotes)?.state,
            "active"
          );

          // Rerunning changes nothing, the revision included.
          const revision = yield* currentRevision;

          const rerun = yield* runUpgrade({
            sets: [HELPDESK_SET_DIRECTORIES.v2],
          });

          assert.deepStrictEqual(
            rerun.sets.map((set) => [set.name, set.result.state]),
            [
              ["core", "unchanged"],
              ["helpdesk", "unchanged"],
            ]
          );
          assert.deepStrictEqual(rerun.plan.security, []);
          assert.deepStrictEqual(
            rerun.plan.sets.flatMap((set) => set.conflicts),
            []
          );
          assert.strictEqual(yield* currentRevision, revision);

          // `std doctor`, the command, exits 0 (open conflicts are info).
          const database = yield* TestDatabase;
          const doctor = yield* runCli(database.url, ["doctor"]);

          assert.strictEqual(doctor.code, 0, doctor.output);
          assert.include(doctor.output, "openConflict");
        })
    );
  });
});
