/**
 * Auto-numbers (plan Step 2): a text field with a `numberPrefix` gets its
 * value from the record service on create, `<prefix><n>` with `n` padded to
 * seven digits (`INC0000001`; wider past 9,999,999), like ServiceNow's
 * number maintenance [judgment].
 *
 * Numbers come from `core.number_counter` (migration 0008), one row per
 * field and prefix: the save takes the next value with one
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` in its own transaction,
 * which locks the counter row until the save commits. So numbers are
 * assigned atomically, every class that uses a prefix for a field shares
 * one sequence, and a number is never handed out twice in the field's
 * hierarchy, whichever class owns the prefix and however prefixes change.
 * Gaps are allowed but rare: a save that rolls back also rolls back its
 * counter update, so the next save gets the same number. Concurrent creates
 * of one prefix serialize on the counter row until each commits.
 *
 * Existing rows get numbers from the `backfill` follow-up step
 * (`schema/backfill.ts`), which takes ranges from the same counter.
 */
import { identSql, sql, textParameter } from "@std/conditions/sql-fragment";
import type { EffectiveField } from "@std/definitions/effective-schema";
import { compareIds } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import type { DecodedInput } from "@std/values/field-value";
import { Effect } from "effect";

import { writeRows } from "./sql-run.ts";

/** The digits a number is padded to [judgment]. */
export const NUMBER_DIGITS = 7;

/**
 * The text of an auto-number.
 *
 * @param prefix - The effective prefix of the record's class.
 * @param value - The counter value, as decimal text.
 * @returns `<prefix><value padded to seven digits>`; never truncated.
 */
export const formatNumber = (prefix: string, value: string): string =>
  `${prefix}${value.padStart(NUMBER_DIGITS, "0")}`;

/**
 * Takes the next number of a field and prefix in the current transaction.
 *
 * @param fieldId - The auto-numbered field.
 * @param prefix - The effective prefix.
 * @returns The formatted number.
 */
export const nextNumber = Effect.fn("Records.nextNumber")(function* nextNumber(
  fieldId: DefinitionId,
  prefix: string
) {
  const rows = yield* writeRows(
    sql`INSERT INTO ${identSql("core", "number_counter")} AS counter (field_id, prefix, last_value)
VALUES (${textParameter(fieldId, "uuid")}, ${textParameter(prefix, "text")}, 1)
ON CONFLICT (field_id, prefix) DO UPDATE
SET last_value = counter.last_value + 1
RETURNING counter.last_value::text AS "last"`
  );

  const last = rows[0]?.last;

  if (last === undefined || last === null) {
    // The upsert always returns its row.
    return yield* Effect.die(new Error("The number counter returned no row"));
  }

  return formatNumber(prefix, last);
});

/**
 * Assigns a number to every active auto-numbered field of a create, in
 * field ID order (so concurrent creates take counter rows in one order).
 * Runs after validation, before the insert; values the validation saw
 * (null) are replaced.
 *
 * @param fields - The effective fields of the concrete class.
 * @param values - The final proposed values.
 * @returns The values with numbers assigned.
 */
export const assignNumbers = Effect.fn("Records.assignNumbers")(
  function* assignNumbers(
    fields: ReadonlyMap<DefinitionId, EffectiveField>,
    values: ReadonlyMap<DefinitionId, DecodedInput>
  ) {
    const numbered = new Map(values);

    const autoNumbered = [...fields.values()]
      .filter(
        (field) => field.numberPrefix !== null && field.state === "active"
      )
      .toSorted((left, right) => compareIds(left.field.id, right.field.id));

    for (const field of autoNumbered) {
      if (field.numberPrefix !== null) {
        numbered.set(
          field.field.id,
          yield* nextNumber(field.field.id, field.numberPrefix)
        );
      }
    }

    return numbered;
  }
);
