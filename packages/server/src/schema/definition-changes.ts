/**
 * History of definition records (Contracts 1.4, 4.1, 4.2): every definition
 * row a change set creates or changes gets one change entry per committed
 * version, written in the main transaction with the definition rows, by
 * the records' change-entry writer (operation ID, revision, actor, secret
 * rules). Definition rows are never deleted: a delete or purge leaves a
 * tombstone, so it is an update of `state`.
 *
 * The entry's fields are the definition table's columns, keyed by the field
 * IDs the core set describes for that platform table, with their values
 * before and after in canonical JSON. The written entries are returned, so
 * the change set can write the deliveries of config subscriptions on
 * `role` and `accessRule` (`config-deliveries.ts`, Contracts 4.6).
 */
import type { Definition } from "@std/definitions/definition";
import { sameJson } from "@std/definitions/layers";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { definitionColumns, tableOf } from "../catalog/definition-tables.ts";
import { writeChangeEntry } from "../records/change-entry.ts";
import type { ChangeCause, ChangeEntry } from "../records/change-entry.ts";
import { writeChangeImageValues } from "../records/change-image.ts";

/** A definition the change set wrote, with its change entry. */
export interface WrittenDefinitionChange {
  readonly before: Definition | undefined;
  readonly after: Definition;
  readonly entry: ChangeEntry;
}

/**
 * A definition's complete canonical platform image, keyed by field ID.
 * @param snapshot - The current configuration.
 * @param definition - The effective definition.
 * @returns Canonical column values keyed by field ID.
 */
export const definitionImage = (
  snapshot: ConfigSnapshot,
  definition: Definition
): JsonObject => {
  const columns = definitionColumns(definition);

  return Object.fromEntries(
    snapshot
      .fields(tableOf(definition.kind).classId)
      .map((field) => [field.id, columns.get(field.name) ?? null])
  );
};

/**
 * Writes one change entry per definition the change set created or
 * changed, at its new version.
 *
 * @param snapshot - The configuration after the change set.
 * @param changes - Each written definition and its stored predecessor.
 * @param actorId - The requester.
 * @param cause - `api` for requests, `system` for set loads.
 * @param revision - The revision the main transaction commits, at which
 *   the entries' field IDs (the core set's) exist.
 * @returns The written entries, with their definitions.
 */
export const writeDefinitionChanges = Effect.fn(
  "Schema.writeDefinitionChanges"
)(function* writeDefinitionChanges(
  snapshot: ConfigSnapshot,
  changes: readonly {
    readonly before: Definition | undefined;
    readonly after: Definition;
  }[],
  actorId: string,
  cause: ChangeCause,
  revision: number
) {
  const written: WrittenDefinitionChange[] = [];

  for (const { before, after } of changes) {
    const { classId } = tableOf(after.kind);

    // Before the core set describes the platform tables there is nothing
    // to key the entry by.
    if (snapshot.class(classId) !== undefined) {
      const beforeImage =
        before === undefined ? null : definitionImage(snapshot, before);

      const afterImage = definitionImage(snapshot, after);
      const fields: Record<string, JsonValue> = {};

      for (const [id, value] of Object.entries(afterImage)) {
        const old = beforeImage?.[id] ?? null;

        if (beforeImage === null || !sameJson(old, value)) {
          fields[id] = { after: value, before: old };
        }
      }

      const entry = yield* writeChangeEntry(
        {
          actorId,
          cause,
          fields,
          kind: before === undefined ? "create" : "update",
          recordClassId: classId,
          recordId: after.id,
          recordVersion: after.version,
        },
        revision
      );

      yield* writeChangeImageValues(snapshot, entry, beforeImage, afterImage);
      written.push({ after, before, entry });
    }
  }

  return written;
});
