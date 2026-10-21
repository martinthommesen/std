import { assert, describe, expect, it, layer } from "@effect/vitest";
/**
 * Every DDL statement the engine generates matches the forms of Contracts
 * 1.4 (checked here on a committed SQL snapshot of the core and acme sets
 * and of changes to tables with rows), and volatile defaults, type changes
 * and direct `SET NOT NULL` are refused before any SQL runs. Also
 * `fk-actions` (Contracts 3.10).
 */
import { applyOperations } from "@std/definitions/apply";
import type { AppliedChangeSet } from "@std/definitions/apply";
import type { Owner } from "@std/definitions/definition";
import type { DefinitionInvalid } from "@std/definitions/problems";
import { planSet } from "@std/definitions/set-plan";
import { resolveSet } from "@std/definitions/set-resolve";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import { Effect, Result } from "effect";

import {
  readSetDirectory,
  CORE_SET_DIRECTORY,
} from "../src/config/set-files.ts";
import { guardStatements } from "../src/schema/change-set.ts";
import { checkDdl, maskQuoted, phaseOfForm } from "../src/schema/ddl-forms.ts";
import { ASSUME_POPULATED, planChangeSet } from "../src/schema/plan.ts";
import type { Preflight } from "../src/schema/plan.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import {
  ACME,
  ACME_SET_DIRECTORY,
  addField,
  addIndex,
  addOverride,
  change,
  currentRevision,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const EMPTY: Preflight = { hasRows: () => false };

const orThrow = <A>(result: Result.Result<A, DefinitionInvalid>): A => {
  if (Result.isFailure(result)) {
    throw result.failure;
  }

  return result.success;
};

const loadInMemory = (
  snapshot: ConfigSnapshot,
  directory: string,
  required: ReadonlyMap<string, Owner>
) =>
  readSetDirectory(directory).pipe(
    Effect.map((files) => {
      const resolved = orThrow(resolveSet(files, snapshot, required));
      const operations = orThrow(planSet(resolved, snapshot));

      return orThrow(
        applyOperations(snapshot, operations, {
          changeSetId: snapshot.changeSetId,
          revision: snapshot.revision + 1,
        })
      );
    })
  );

const statementsOf = (applied: AppliedChangeSet, preflight: Preflight) => {
  const plan = planChangeSet(applied, preflight);

  return [
    ...plan.tables.map((statement) => statement.sql),
    ...plan.keys.map((statement) => statement.sql),
    ...plan.steps.flatMap((step) =>
      step.sql === null || step.kind === "validate_override" ? [] : [step.sql]
    ),
  ];
};

const snapshotStatements = Effect.gen(function* planSnapshot() {
  const empty = ConfigSnapshot.empty({
    changeSetId: "00000000-0000-4000-8000-000000000000",
    revision: 0,
  });

  const core = yield* loadInMemory(empty, CORE_SET_DIRECTORY, new Map());
  const acme = yield* loadInMemory(core.after, ACME_SET_DIRECTORY, new Map());

  const serial = addField(
    ACME.laptop,
    "asset_tag",
    { kind: "text", maxLength: 20 },
    {
      default: "none",
      id: "00000000-0000-4000-8000-000000000001",
      required: true,
    }
  );

  const flag = addField(
    ACME.asset,
    "retired_flag",
    { kind: "boolean" },
    {
      id: "00000000-0000-4000-8000-000000000002",
    }
  );

  const buddy = addField(
    ACME.monitor,
    "buddy",
    { kind: "reference", targetClassId: ACME.asset },
    { id: "00000000-0000-4000-8000-000000000003" }
  );

  const tag = addIndex(
    ACME.laptop,
    [ACME.serial],
    true,
    "00000000-0000-4000-8000-000000000004"
  );

  const status = addIndex(
    ACME.asset,
    [ACME.status],
    false,
    "00000000-0000-4000-8000-000000000005"
  );

  const populated = orThrow(
    applyOperations(
      acme.after,
      [
        serial.op,
        flag.op,
        buddy.op,
        tag.op,
        status.op,
        addOverride(ACME.laptop, ACME.name, {
          id: "00000000-0000-4000-8000-000000000006",
          maxLength: 60,
        }).op,
        {
          changes: { default: "2026-01-01" },
          id: ACME.purchasedOn,
          op: "update",
          version: 1,
        },
      ],
      { changeSetId: acme.after.changeSetId, revision: acme.after.revision + 1 }
    )
  );

  return [
    "-- core set on an empty install",
    ...statementsOf(core, EMPTY),
    "-- acme set",
    ...statementsOf(acme, EMPTY),
    "-- fields, indexes and an override on tables with rows",
    ...statementsOf(populated, ASSUME_POPULATED),
  ];
});

describe("ddl-forms", () => {
  it.effect("every generated statement is one of the Contracts 1.4 forms", () =>
    Effect.gen(function* everyStatementAllowed() {
      const statements = yield* snapshotStatements;
      const ddl = statements.filter((text) => !text.startsWith("--"));

      for (const statement of ddl) {
        const checked = checkDdl(statement);

        assert.isTrue(checked.ok, statement);
      }

      const forms = new Set(
        ddl.flatMap((statement) => {
          const checked = checkDdl(statement);

          return checked.ok ? [checked.form] : [];
        })
      );

      assert.includeMembers(
        [...forms],
        [
          "createSchema",
          "createTable",
          "createTrigger",
          "createIndex",
          "addColumn",
          "addForeignKey",
          "addCheck",
          "setDefault",
          "validateConstraint",
          "createIndexConcurrently",
        ]
      );
      assert.strictEqual(phaseOfForm("createIndexConcurrently"), "followUp");
      assert.isFalse(ddl.some((statement) => statement.includes("SELECT *")));
    })
  );

  it("matches the committed SQL snapshot", async () => {
    const statements = await Effect.runPromise(snapshotStatements);

    const text = statements
      .map((statement) =>
        statement.startsWith("--") ? statement : `${statement};`
      )
      .join("\n\n");

    await expect(`${text}\n`).toMatchFileSnapshot(
      "./__snapshots__/ddl-forms.sql"
    );
  });

  it("refuses volatile defaults, type changes and direct SET NOT NULL", () => {
    const table = '"acme"."asset"';

    const refusals = [
      [
        `ALTER TABLE ${table} ADD COLUMN "seen" timestamptz(3) DEFAULT now()`,
        "volatileDefault",
      ],
      [
        `ALTER TABLE ${table} ADD COLUMN "token" uuid DEFAULT gen_random_uuid()`,
        "volatileDefault",
      ],
      [
        `ALTER TABLE ${table} ALTER COLUMN "name" TYPE varchar(10)`,
        "typeChange",
      ],
      [`ALTER TABLE ${table} ALTER COLUMN "name" SET NOT NULL`, "setNotNull"],
      [
        `ALTER TABLE ${table} ADD COLUMN "n" integer GENERATED ALWAYS AS IDENTITY`,
        "unknownForm",
      ],
      [`ALTER TABLE ${table} DROP COLUMN "name" CASCADE`, "unknownForm"],
      [
        `CREATE TABLE ${table} (\n  id uuid REFERENCES "core"."user" (id) ON DELETE SET NULL\n)`,
        "unknownForm",
      ],
    ] as const;

    for (const [statement, reason] of refusals) {
      assert.deepStrictEqual(
        checkDdl(statement),
        { ok: false, reason },
        statement
      );
    }

    // SQL keywords inside literals and quoted identifiers are data.
    const literals = [
      [
        `ALTER TABLE ${table} ADD COLUMN "motto" text DEFAULT 'SET NOT NULL'::text`,
        "addColumn",
      ],
      [
        `ALTER TABLE ${table} ADD COLUMN "note" text DEFAULT 'ALTER COLUMN x TYPE int, now()'::text`,
        "addColumn",
      ],
      [
        `ALTER TABLE ${table} ADD COLUMN "quote" text DEFAULT 'it''s DEFAULT now()'::text`,
        "addColumn",
      ],
      [
        `ALTER TABLE ${table} ALTER COLUMN "SET NOT NULL" SET DEFAULT 'x'::text`,
        "setDefault",
      ],
      [`ALTER TABLE ${table} ALTER COLUMN "type" DROP DEFAULT`, "dropDefault"],
    ] as const;

    for (const [statement, form] of literals) {
      assert.deepStrictEqual(
        checkDdl(statement),
        { form, ok: true },
        statement
      );
    }

    assert.deepStrictEqual(
      checkDdl(
        `ALTER TABLE ${table} ADD COLUMN "motto" text DEFAULT 'x'::text || now()`
      ),
      { ok: false, reason: "volatileDefault" }
    );
    assert.strictEqual(maskQuoted(`a 'b''c' "d" e`), `a '____' "_" e`);

    assert.deepStrictEqual(
      checkDdl(
        `ALTER TABLE ${table} ADD COLUMN "flag" boolean CONSTRAINT std_nn_00000000000040008000000000000001 NOT NULL DEFAULT false`
      ),
      { form: "addColumn", ok: true }
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("refusals happen before any SQL runs", () =>
      Effect.gen(function* refuseBeforeSql() {
        yield* loadCoreAndAcme;
        const log = yield* StatementLog;
        const revision = yield* currentRevision;

        yield* log.clear;

        const guarded = yield* Effect.flip(
          guardStatements([
            `ALTER TABLE "acme"."asset" ALTER COLUMN "name" SET NOT NULL`,
          ])
        );

        assert.strictEqual(guarded.reason, "setNotNull");
        assert.lengthOf(yield* log.texts, 0);

        const typeChange = yield* Effect.flip(
          change([
            {
              changes: { type: { kind: "integer" } },
              id: ACME.status,
              op: "update",
              version: 1,
            },
          ])
        );

        assert.strictEqual(typeChange._tag, "DefinitionInvalid");

        const texts = yield* log.texts;

        assert.isFalse(
          texts.some(
            (text) =>
              text.startsWith("ALTER") ||
              text.includes("pg_advisory_xact_lock(")
          )
        );
        assert.strictEqual(yield* currentRevision, revision);
      })
    );

    dbTest.effect(
      "fk-actions: every FK is NO ACTION, level FKs cascade deletes",
      () =>
        Effect.gen(function* fkActions() {
          const rows = yield* values(
            `SELECT c.conname || ' ' || c.confdeltype::text || c.confupdtype::text AS value
           FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.contype = 'f' AND n.nspname IN ('core', 'acme')
           ORDER BY c.conname`
          );

          assert.isAbove(rows.length, 10);

          for (const row of rows) {
            const [name, actions] = row.split(" ");

            assert.strictEqual(
              actions,
              name?.startsWith("std_lv_") === true ? "ca" : "aa",
              row
            );
          }
        })
    );
  });
});
