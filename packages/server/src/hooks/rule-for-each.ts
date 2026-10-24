/**
 * The records a record rule's `forEach` selects (Contracts 4.10): records
 * of its class and its subclasses, read as system (every row, whatever
 * the acting user may see), in stable ID order, with its `where` compiled
 * to SQL; `scope: "record"` paths read the rule's record. Used by the
 * nested-save actions (`rule-actions.ts`) and by `createParts` while
 * settling (`aggregate-rules.ts`), which must not import the save
 * pipeline.
 */
import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
import { compileCondition } from "@std/conditions/sql";
import { identSql, rawSql, sql } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { RuleForEach } from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isString } from "@std/values/field-value";
import { Effect, Option } from "effect";

import { recordRelation } from "../records/relation.ts";
import { loadRecord, loadRoot } from "../records/save-sql.ts";
import { readRows } from "../records/sql-run.ts";
import { imageOf } from "../records/stored-record.ts";
import { checkedRuleCondition } from "./rule-condition.ts";
import type { RuleContext } from "./rule-condition.ts";
import type { ValueRecord } from "./rule-values.ts";

/** The record a rule runs for. */
export interface RuleRecord {
  readonly id: string;
  readonly image: RecordImage;
}

/** One record a `forEach` selected. */
export interface Selected {
  readonly id: string;
  readonly classId: DefinitionId;
  readonly version: number;
}

const FOR_EACH_ALIAS = "r";

const selectedOf = (rows: readonly Record<string, string | null>[]) =>
  rows.flatMap((row): Selected[] =>
    isString(row.id) && isString(row.class_id) && isString(row.version)
      ? [{ classId: row.class_id, id: row.id, version: Number(row.version) }]
      : []
  );

/** What a selection runs for. */
export interface ForEachInput {
  readonly snapshot: ConfigSnapshot;
  /** The rule's class, which `scope: "record"` paths read. */
  readonly ruleClassId: DefinitionId;
  /** The rule's record. */
  readonly record: RuleRecord;
  readonly context: RuleContext;
}

/**
 * The records a `forEach` selects, as system, in ID order.
 *
 * @param input - The rule's class, its record and the context.
 * @param forEach - The class and condition.
 * @returns The records with their concrete class and version.
 */
export const selectForEach = Effect.fn("Rules.selectForEach")(
  function* selectForEach(input: ForEachInput, forEach: RuleForEach) {
    const relation = recordRelation(input.snapshot, forEach.classId);
    let predicate = rawSql("TRUE");

    if (forEach.where !== null) {
      const checked = checkedRuleCondition(
        input.snapshot,
        forEach.classId,
        forEach.where,
        input.ruleClassId
      );

      const resolved = resolveCondition(checked, {
        ...input.context,
        record: { id: input.record.id, values: input.record.image },
      });

      if (!resolved.ok) {
        return yield* Effect.die(
          new RangeError("A forEach condition does not resolve.")
        );
      }

      ({ predicate } = compileCondition(resolved.value, {
        alias: FOR_EACH_ALIAS,
        hooks: {
          column: (source, field) => identSql(source.alias, field.name),
          join: () => {
            throw new RangeError("A forEach condition follows no reference.");
          },
        },
        joinAliasPrefix: `${FOR_EACH_ALIAS}_hop`,
      }));
    }

    const rows = yield* readRows(
      sql`SELECT ${identSql(FOR_EACH_ALIAS, "id")}::text AS "id",
  ${identSql(FOR_EACH_ALIAS, "class_id")}::text AS "class_id",
  ${identSql(FOR_EACH_ALIAS, "version")}::text AS "version"
FROM ${relation} AS ${identSql(FOR_EACH_ALIAS)}
WHERE ${predicate}
ORDER BY ${identSql(FOR_EACH_ALIAS, "id")}`
    );

    return selectedOf(rows);
  }
);

/**
 * The root row of a record: its concrete class and version.
 *
 * @param snapshot - The configuration.
 * @param classId - A class of its hierarchy.
 * @param id - The record ID.
 * @returns The record, or none.
 */
export const rootOf = Effect.fn("Rules.rootOf")(function* rootOf(
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  id: string
) {
  return (yield* loadRoot(snapshot, classId, id, "none")).pipe(
    Option.map((root): Selected => ({ ...root, id }))
  );
});

/**
 * A selected record's image, as system.
 *
 * @param snapshot - The configuration.
 * @param selected - The record.
 * @returns Its ID and image, or null when it is gone.
 */
export const sourceImage = Effect.fn("Rules.sourceImage")(function* sourceImage(
  snapshot: ConfigSnapshot,
  selected: Selected
) {
  const loaded = yield* loadRecord(snapshot, selected.classId, selected.id);

  const found: ValueRecord | null = Option.isSome(loaded)
    ? { id: selected.id, image: imageOf(loaded.value) }
    : null;

  return found;
});
