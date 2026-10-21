/**
 * The rows a change set's main transaction writes (Contracts 1.4 step 5):
 * definition rows, definition revisions (4.4), the dependency index (1.7)
 * and the journal (1.5), which is also the change set's audit record: who
 * requested it, from which source, and every operation with its target's
 * old and new name.
 */
import type { AppliedChangeSet } from "@std/definitions/apply";
import type { Definition } from "@std/definitions/definition";
import { dependenciesOf } from "@std/definitions/dependencies";
import { effectiveJson } from "@std/definitions/effective-json";
import type { DefinitionId } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { stringifyJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { boundValues, tableOf } from "../catalog/definition-tables.ts";
import { decodeRows } from "../sql/rows.ts";
import type { EnforcementUpdate, PlannedStep } from "./plan.ts";

const decodeIds = decodeRows(Schema.Struct({ id: Schema.String }));

/** A definition whose row changed under the change set; never expected under `CONFIG_KEY`. */
export class DefinitionRowConflictError extends Error {
  override readonly name = "DefinitionRowConflictError";
}

const insertDefinition = Effect.fn("Schema.insertDefinition")(
  function* insertDefinition(
    definition: Definition,
    requesterId: DefinitionId
  ) {
    const sql = yield* SqlClient.SqlClient;
    const entry = tableOf(definition.kind);
    const values = boundValues(definition);

    const params: (string | null)[] = [
      definition.id,
      entry.classId,
      String(definition.version),
      requesterId,
      ...values.map((value) => value.text),
    ];

    const placeholders = values.map(
      (value, index) => `$${index + 5}::${value.cast}`
    );

    yield* sql.unsafe(
      `INSERT INTO core."${entry.table}" (id, class_id, version, created_at, created_by, updated_at, updated_by, ${values.map((value) => value.column).join(", ")}) VALUES ($1::uuid, $2::uuid, $3::int8, now(), $4::uuid, now(), $4::uuid, ${placeholders.join(", ")})`,
      params
    );
  }
);

const updateDefinition = Effect.fn("Schema.updateDefinition")(
  function* updateDefinition(
    definition: Definition,
    previousVersion: number,
    requesterId: DefinitionId
  ) {
    const sql = yield* SqlClient.SqlClient;
    const entry = tableOf(definition.kind);
    const values = boundValues(definition);

    const assignments = values.map(
      (value, index) => `${value.column} = $${index + 5}::${value.cast}`
    );

    const rows = yield* sql.unsafe(
      `UPDATE core."${entry.table}" SET version = $3::int8, updated_at = now(), updated_by = $4::uuid, ${assignments.join(", ")} WHERE id = $1::uuid AND version = $2::int8 RETURNING id`,
      [
        definition.id,
        String(previousVersion),
        String(definition.version),
        requesterId,
        ...values.map((value) => value.text),
      ]
    );

    const updated = yield* decodeIds(rows);

    if (updated.length !== 1) {
      return yield* Effect.die(
        new DefinitionRowConflictError(
          `core.${entry.table} row ${definition.id} is not at version ${previousVersion}`
        )
      );
    }

    return yield* Effect.void;
  }
);

/**
 * Writes the definitions a change set creates or changes.
 *
 * @param definitions - The definitions after the change set.
 * @param before - The configuration before it.
 * @param requesterId - The acting user, for the audit columns.
 * @returns An effect in the main transaction.
 */
export const writeDefinitions = Effect.fn("Schema.writeDefinitions")(
  function* writeDefinitions(
    definitions: readonly Definition[],
    before: ConfigSnapshot,
    requesterId: DefinitionId
  ) {
    for (const definition of definitions) {
      const stored = before.get(definition.id);

      yield* stored === undefined
        ? insertDefinition(definition, requesterId)
        : updateDefinition(definition, stored.version, requesterId);
    }
  }
);

/**
 * Records enforcement states that do not change a definition's
 * configuration (no new version, no definition revision).
 *
 * @param updates - The ancestors with a widened subtree check.
 * @returns An effect in the main transaction.
 */
export const writeEnforcementNotes = Effect.fn("Schema.writeEnforcementNotes")(
  function* writeEnforcementNotes(updates: readonly EnforcementUpdate[]) {
    const sql = yield* SqlClient.SqlClient;

    for (const update of updates) {
      yield* sql`
        UPDATE core."class" SET enforcement = 'enforced', enforcement_note = ${update.note}
        WHERE id = ${update.definition.id}::uuid`;
    }
  }
);

/**
 * Sets the enforcement state of definitions (the `complete` step).
 *
 * @param entries - Definitions and their new state.
 * @returns An effect in a config commit.
 */
export const writeEnforcement = Effect.fn("Schema.writeEnforcement")(
  function* writeEnforcement(
    entries: readonly {
      readonly definition: Definition;
      readonly enforcement: "enforced" | "failed";
    }[]
  ) {
    const sql = yield* SqlClient.SqlClient;

    for (const { definition, enforcement } of entries) {
      yield* sql.unsafe(
        `UPDATE core."${tableOf(definition.kind).table}" SET enforcement = $1::text WHERE id = $2::uuid`,
        [enforcement, definition.id]
      );
    }
  }
);

/**
 * Writes one `core.definition_revision` row per changed definition at the
 * change set's revision (Contracts 4.4).
 *
 * @param revision - The revision the main transaction commits.
 * @param definitions - The created or changed definitions.
 * @returns An effect in the main transaction.
 */
export const writeDefinitionRevisions = Effect.fn(
  "Schema.writeDefinitionRevisions"
)(function* writeDefinitionRevisions(
  revision: number,
  definitions: readonly Definition[]
) {
  if (definitions.length === 0) {
    return;
  }

  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(
    `INSERT INTO core.definition_revision (definition_id, revision, kind, effective)
     SELECT (e ->> 'id')::uuid, $1::int8, e ->> 'kind', e -> 'effective'
     FROM jsonb_array_elements($2::jsonb) AS e`,
    [
      String(revision),
      stringifyJson(
        definitions.map((definition) => ({
          effective: effectiveJson(definition),
          id: definition.id,
          kind: definition.kind,
        }))
      ),
    ]
  );
});

/**
 * Replaces the dependency rows of the changed definitions (Contracts 1.7).
 *
 * @param definitions - The created or changed definitions.
 * @returns An effect in the main transaction.
 */
export const writeDependencies = Effect.fn("Schema.writeDependencies")(
  function* writeDependencies(definitions: readonly Definition[]) {
    if (definitions.length === 0) {
      return;
    }

    const sql = yield* SqlClient.SqlClient;

    yield* sql.unsafe(
      `DELETE FROM core.config_dependency
           WHERE from_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
      [stringifyJson(definitions.map((definition) => definition.id))]
    );

    const edges = definitions.flatMap(dependenciesOf);

    if (edges.length > 0) {
      yield* sql.unsafe(
        `INSERT INTO core.config_dependency (from_id, to_id, kind)
             SELECT (e ->> 'fromId')::uuid, (e ->> 'toId')::uuid, e ->> 'kind'
             FROM jsonb_array_elements($1::jsonb) AS e`,
        [
          stringifyJson(
            edges.map((entry) => ({
              fromId: entry.fromId,
              kind: entry.kind,
              toId: entry.toId,
            }))
          ),
        ]
      );
    }
  }
);

const nameOf = (definition: Definition | undefined): JsonValue =>
  definition !== undefined && "name" in definition ? definition.name : null;

const targetOf = (operation: Operation): DefinitionId =>
  "definition" in operation ? operation.definition.id : operation.id;

/**
 * The journal entry of each operation: tag, kind, target, old and new name
 * (Contracts 1.5), so stale-request checks can match names (6.4).
 *
 * @param applied - The applied change set.
 * @returns One JSON object per operation that changed something.
 */
export const journalOperations = (
  applied: AppliedChangeSet
): readonly JsonObject[] =>
  applied.operations.map((operation) => {
    const id = targetOf(operation);
    const before = applied.before.get(id);
    const after = applied.after.get(id);

    return {
      kind: after?.kind ?? null,
      newName: nameOf(after),
      oldName: nameOf(before),
      op: operation.op,
      targetId: id,
      version: before?.version ?? null,
    };
  });

/** What the journal records about a change set's main transaction. */
export interface JournalEntry {
  readonly changeSetId: string;
  readonly requesterId: DefinitionId;
  readonly source: JsonObject;
  readonly operations: readonly JsonObject[];
  readonly revision: number;
  readonly coordinatorPid: number | null;
  readonly steps: readonly PlannedStep[];
}

/**
 * Writes `core.schema_change` and its steps. A change set without steps is
 * `completed` at once; otherwise it is `applying` until `complete`.
 *
 * @param entry - The journal entry.
 * @returns An effect in the main transaction.
 */
export const writeJournal = Effect.fn("Schema.writeJournal")(
  function* writeJournal(entry: JournalEntry) {
    const sql = yield* SqlClient.SqlClient;
    const applying = entry.steps.length > 0;

    yield* sql.unsafe(
      `INSERT INTO core."schema_change" (id, class_id, version, created_at, created_by, updated_at, updated_by,
         requester_id, source, operations, state, first_revision, last_revision, coordinator_pid, committed_at, completed_at)
       VALUES ($1::uuid, $2::uuid, 1, now(), $3::uuid, now(), $3::uuid,
         $3::uuid, $4::jsonb, $5::jsonb, $6::text, $7::int8, $8::int8, $9::int4, clock_timestamp(),
         CASE WHEN $6::text = 'completed' THEN clock_timestamp() END)`,
      [
        entry.changeSetId,
        PLATFORM_CLASS_IDS.schema_change,
        entry.requesterId,
        stringifyJson(entry.source),
        stringifyJson(entry.operations),
        applying ? "applying" : "completed",
        String(entry.revision),
        applying ? null : String(entry.revision),
        entry.coordinatorPid === null ? null : String(entry.coordinatorPid),
      ]
    );

    if (applying) {
      yield* sql.unsafe(
        `INSERT INTO core."schema_change_step" (id, class_id, version, created_at, created_by, updated_at, updated_by,
           change_id, ordinal, kind, target_id, sql, details, state, attempts)
         SELECT uuidv7(), $1::uuid, 1, now(), $2::uuid, now(), $2::uuid,
           $3::uuid, (e ->> 'ordinal')::int4, e ->> 'kind', (e ->> 'targetId')::uuid, e ->> 'sql', e -> 'details', 'pending', 0
         FROM jsonb_array_elements($4::jsonb) AS e`,
        [
          PLATFORM_CLASS_IDS.schema_change_step,
          entry.requesterId,
          entry.changeSetId,
          stringifyJson(
            entry.steps.map((step, index) => ({
              details: step.details,
              kind: step.kind,
              ordinal: index + 1,
              sql: step.sql,
              targetId: step.targetId,
            }))
          ),
        ]
      );
    }
  }
);
