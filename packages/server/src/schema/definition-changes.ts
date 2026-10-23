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
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { stringifyJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { tableOf } from "../catalog/definition-tables.ts";
import { writeChangeEntry } from "../records/change-entry.ts";
import type { ChangeCause, ChangeEntry } from "../records/change-entry.ts";
import { writeChangeImageValues } from "../records/change-image.ts";

/** A definition the change set wrote, with its change entry. */
export interface WrittenDefinitionChange {
  readonly before: Definition | undefined;
  readonly after: Definition;
  readonly entry: ChangeEntry;
}

const fieldsValue = (fields: "*" | readonly string[]): JsonValue =>
  fields === "*" ? "*" : [...fields];

/**
 * A definition's row as column values in canonical JSON.
 *
 * @param definition - Any definition.
 * @returns Column name to value.
 */
export const definitionColumns = (
  definition: Definition
): ReadonlyMap<string, JsonValue> => {
  const entry = tableOf(definition.kind);
  const json: JsonObject = definition;
  const { owner } = definition;

  const columns = new Map<string, JsonValue>([
    ["owner_layer", owner.layer],
    ["owner_set_id", owner.layer === "app" ? owner.setId : null],
    ["state", definition.state],
    ["protected", definition.protected],
  ]);

  for (const spec of entry.columns) {
    columns.set(spec.column, json[spec.property] ?? null);
  }

  if (definition.kind === "accessRule") {
    const { target } = definition;

    columns.set("target", target.kind);
    columns.set(
      "fields",
      target.kind === "fields" ? fieldsValue(target.fields) : null
    );
  }

  return columns;
};

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

const fieldsOf = (
  snapshot: ConfigSnapshot,
  before: Definition | undefined,
  after: Definition
): JsonObject => {
  const { classId } = tableOf(after.kind);
  const was = before === undefined ? undefined : definitionColumns(before);
  const now = definitionColumns(after);
  const fields: Record<string, JsonValue> = {};

  for (const field of snapshot.fields(classId)) {
    const old = was?.get(field.name) ?? null;
    const next = now.get(field.name) ?? null;

    if (was === undefined || stringifyJson(old) !== stringifyJson(next)) {
      fields[field.id] = { after: next, before: old };
    }
  }

  return fields;
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
    // Before the core set describes the platform tables there is nothing
    // to key the entry by.
    if (snapshot.class(tableOf(after.kind).classId) !== undefined) {
      const entry = yield* writeChangeEntry(
        {
          actorId,
          cause,
          fields: fieldsOf(snapshot, before, after),
          kind: before === undefined ? "create" : "update",
          recordClassId: tableOf(after.kind).classId,
          recordId: after.id,
          recordVersion: after.version,
        },
        revision
      );

      yield* writeChangeImageValues(
        snapshot,
        entry,
        before === undefined ? null : definitionImage(snapshot, before),
        definitionImage(snapshot, after)
      );
      written.push({ after, before, entry });
    }
  }

  return written;
});
