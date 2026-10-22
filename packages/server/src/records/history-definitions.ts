/**
 * The definitions a history entry's changes are read with (Contracts 4.4,
 * 4.5, decision 0020): per field in an entry's `changes`, its label, type
 * and choice labels as they were at the entry's schema revision R, so the
 * history panel renders old values with the definitions they were written
 * under.
 *
 * - Definitions at R come from `core.definition_revision`, the same lookup
 *   stale requests use (`stale-scope.ts`): per definition, the latest row
 *   at R or earlier, in numeric revision order. The field, the classes of the record's concrete
 *   lineage, the field's overrides and its choices are read in one
 *   statement and assembled into a snapshot of just those definitions, so
 *   the label and type are the effective ones on the record's class
 *   (`effectiveField`), as metadata computed them then.
 * - Choices: the field's live choices at R, hidden ones included (an old
 *   value may be a hidden key), not narrowed by a child's subset, by order
 *   then key.
 * - The type is shown as metadata shows it today (`metaTypeOf`): a
 *   reference or condition field names its table only when the caller
 *   knows that table now, and a reference's allowed-records condition is
 *   left out.
 * - Only fields in the entry's `changes` get a descriptor, keyed the same
 *   way (current name), so nothing is revealed that the entry does not
 *   already reveal. A purged field's changes (admins only) use the
 *   definitions it had at R, which its tombstone keeps.
 */
import { metaTypeOf } from "@std/access/table-metadata";
import {
  arrayParameter,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { Definition } from "@std/definitions/definition";
import { effectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { definitionOf } from "../catalog/definition-revisions.ts";
import type { HistoryEntry } from "./history-query.ts";
import type { ReadScope } from "./read-view.ts";
import { readRows } from "./sql-run.ts";

/** One definition's rows, revision ascending. */
type Revisions = readonly {
  readonly revision: number;
  readonly definition: Definition;
}[];

/**
 * Reads every definition revision up to the latest entry's revision of
 * the given fields, classes, and the fields' overrides and choices.
 *
 * @param definitionIds - The fields and the lineage's classes.
 * @param fieldIds - The fields whose overrides and choices are read too.
 * @param latest - The highest revision any entry needs.
 * @returns Per definition, its revisions in ascending order.
 */
const readRevisions = Effect.fn("History.readRevisions")(
  function* readRevisions(
    definitionIds: readonly DefinitionId[],
    fieldIds: readonly DefinitionId[],
    latest: number
  ) {
    // The order names the bigint columns: a bare "revision" would be the
    // text alias, and "10" sorts before "9".
    const rows = yield* readRows(
      sql`SELECT "definition_id"::text AS "id", "revision"::text AS "revision",
  "effective"::text AS "effective"
FROM "core"."definition_revision"
WHERE "revision" <= ${textParameter(String(latest), "int8")}
  AND ("definition_id" = ANY(${arrayParameter(definitionIds, "uuid")})
    OR ("kind" = ANY('{override,choice}'::text[])
      AND "effective" ->> 'fieldId' = ANY(${arrayParameter(fieldIds, "text")})))
ORDER BY "definition_revision"."definition_id", "definition_revision"."revision"`
    );

    const byId = new Map<
      DefinitionId,
      { revision: number; definition: Definition }[]
    >();

    for (const row of rows) {
      const definition =
        row.effective === null || row.effective === undefined
          ? undefined
          : definitionOf(row.effective);

      if (definition !== undefined) {
        const list = byId.get(definition.id) ?? [];

        list.push({ definition, revision: Number(row.revision) });
        byId.set(definition.id, list);
      }
    }

    const revisions: ReadonlyMap<DefinitionId, Revisions> = byId;

    return revisions;
  }
);

/**
 * The definitions as they were at R: per definition, its latest row at R
 * or earlier; definitions created after R are left out.
 *
 * @param revisions - Every definition's rows, ascending.
 * @param revision - R.
 * @returns A snapshot of those definitions at R.
 */
const snapshotAt = (
  revisions: ReadonlyMap<DefinitionId, Revisions>,
  revision: number
): ConfigSnapshot =>
  ConfigSnapshot.make(
    { changeSetId: "", revision },
    [...revisions.values()].flatMap((rows) => {
      const found = rows.findLast((row) => row.revision <= revision);

      return found === undefined ? [] : [found.definition];
    })
  );

/**
 * The definitions of each entry's changed fields at the entry's revision,
 * keyed like the entry's `changes` (the field's current name).
 *
 * @param scope - The caller's scope (current names and known tables).
 * @param classId - The record's concrete class.
 * @param entries - The entries the caller sees.
 * @returns Per entry, in order, `{ <name>: { label, type, choices } }`.
 */
export const entryDefinitions = Effect.fn("History.entryDefinitions")(
  function* entryDefinitions(
    scope: ReadScope,
    classId: DefinitionId,
    entries: readonly HistoryEntry[]
  ) {
    const fieldIds = [
      ...new Set(entries.flatMap((entry) => Object.keys(entry.fields))),
    ];

    if (fieldIds.length === 0) {
      return entries.map((): JsonObject => ({}));
    }

    const { snapshot } = scope;
    const lineage = snapshot.lineage(classId).map((level) => level.id);

    const revisions = yield* readRevisions(
      [...fieldIds, ...lineage],
      fieldIds,
      Math.max(...entries.map((entry) => entry.schemaRevision))
    );

    const atRevision = new Map<number, ConfigSnapshot>();

    const definitionsAt = (revision: number): ConfigSnapshot => {
      let found = atRevision.get(revision);

      if (found === undefined) {
        found = snapshotAt(revisions, revision);
        atRevision.set(revision, found);
      }

      return found;
    };

    return entries.map((entry): JsonObject => {
      const then = definitionsAt(entry.schemaRevision);
      const described: Record<string, JsonObject> = {};

      for (const fieldId of Object.keys(entry.fields)) {
        // A field with no revision at R (none is expected) is shown as it
        // is now.
        const field =
          then.getKind("field", fieldId) ?? snapshot.getKind("field", fieldId);

        if (field !== undefined) {
          const effective = effectiveField(
            then.class(classId) === undefined ? snapshot : then,
            classId,
            field
          );

          const choices =
            effective.type.kind === "choice"
              ? then.choicesOf(fieldId).map((choice) => ({
                  key: choice.key,
                  label: choice.label,
                }))
              : null;

          described[snapshot.getKind("field", fieldId)?.name ?? fieldId] = {
            choices,
            label: effective.label,
            type: metaTypeOf(snapshot, scope.caller, effective.type),
          };
        }
      }

      return described;
    });
  }
);
