/**
 * Stale requests (Contracts 6.4), read side.
 *
 * A request may send `STD-Schema-Revision: <n>.<change_set_id>`, the
 * revision R its query was built at; the transaction runs at C.
 *
 * - A malformed header: `400 InvalidSchemaRevision`, before anything else.
 * - R above C, R's change set ID differing from C's at the same number, or
 *   a journal that does not record R's change set at R:
 *   `409 SchemaChanged` with kind `unknown`.
 * - R below C: the request's scope is resolved at R (`stale-scope.ts`):
 *   the fields its filter, sort and selection name (the default selection
 *   when `fields` is absent), reference targets' fields on one-hop paths,
 *   and labels' display fields. Definition revisions in (R, C] of those
 *   fields, of overrides of them on the classes they are read on, and of
 *   those classes are compared with their state at R. A field whose old or
 *   new name (from definition revisions and the journal's `oldName` and
 *   `newName`, Contracts 1.5) is a name the request used on a class it
 *   affects is relevant too: renamed into or out of it, or added under it.
 *   Names are class-qualified: a name used on one class never matches a
 *   field of an unrelated class. Relevant kinds:
 *   `fieldAdded`, `fieldRenamed`, `fieldRetired`, `fieldPurged`,
 *   `typeChanged`, `settingsChanged`, `requiredChanged`, `readOnlyChanged`,
 *   `tableRetired`. Labels' texts, display field choice and access rules
 *   are not relevant.
 * - `changes` lists only fields the caller can name at C; when nothing
 *   relevant is left the request proceeds, and names that resolve to no
 *   readable field get `UnknownField` as usual.
 */
import { SCHEMA_REVISION_HEADER } from "@std/api/api";
import { InvalidSchemaRevision } from "@std/api/errors/invalid-schema-revision";
import { SchemaChanged } from "@std/api/errors/schema-changed";
import type { SchemaChange, SchemaChangeKind } from "@std/api/errors/schemas";
import { sql, textParameter } from "@std/conditions/sql-fragment";
import { effectiveFields } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import { parseJsonbText } from "@std/values/postgres-text";
import { Effect, Option, Schema } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { currentReadScope, resolveTable } from "../records/read-records.ts";
import type { ReadScope } from "../records/read-view.ts";
import { isNameable } from "../records/record-access.ts";
import type { WriteAction } from "../records/record-access.ts";
import { readRows } from "../records/sql-run.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import { revisionHeaderValue } from "./schema-revision-header.ts";
import { definitionsAt, staleScope } from "./stale-scope.ts";
import type { ScopeEntry, ScopeParameters, StaleScope } from "./stale-scope.ts";

const HEADER =
  /^(?<revision>0|[1-9]\d{0,14})\.(?<changeSet>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/u;

/**
 * Reads the request's `STD-Schema-Revision` header.
 *
 * @param request - The HTTP request.
 * @returns The stated revision, none when absent, or
 *   `InvalidSchemaRevision` when malformed.
 */
export const parseRequestRevision = Effect.fn("StaleRequest.parseHeader")(
  function* parseRequestRevision(request: HttpServerRequest) {
    const header = request.headers[SCHEMA_REVISION_HEADER];

    if (header === undefined) {
      return Option.none<ConfigState>();
    }

    const groups = HEADER.exec(header.trim().toLowerCase())?.groups;

    if (groups?.changeSet === undefined) {
      return yield* new InvalidSchemaRevision();
    }

    return Option.some<ConfigState>({
      changeSetId: groups.changeSet,
      revision: Number(groups.revision),
    });
  }
);

interface DefinitionHistory {
  readonly id: DefinitionId;
  readonly kind: string;
  readonly revision: number;
  readonly before: JsonObject | undefined;
  readonly after: JsonObject;
}

const objectOf = (text: string | null | undefined): JsonObject | undefined => {
  if (text === null || text === undefined) {
    return undefined;
  }

  const parsed = parseJsonbText(text);

  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined;
};

const textOf = (
  json: JsonObject | undefined,
  key: string
): string | undefined => {
  const value = json?.[key];

  return value !== undefined && isJsonString(value) ? value : undefined;
};

const same = (left: JsonValue | undefined, right: JsonValue | undefined) =>
  JSON.stringify(left) === JSON.stringify(right);

const typeKind = (json: JsonObject | undefined): string | undefined => {
  const type = json?.type;

  return type !== undefined && type !== null && isJsonObject(type)
    ? textOf(type, "kind")
    : undefined;
};

const fieldKinds = (entry: DefinitionHistory): SchemaChangeKind[] => {
  const { before, after } = entry;

  if (before === undefined) {
    return ["fieldAdded"];
  }

  const kinds: SchemaChangeKind[] = [];
  const state = textOf(after, "state");

  if (state !== textOf(before, "state")) {
    if (state === "retired") {
      kinds.push("fieldRetired");
    } else if (state === "purged") {
      kinds.push("fieldPurged");
    }
  }

  if (textOf(after, "name") !== textOf(before, "name")) {
    kinds.push("fieldRenamed");
  }

  if (typeKind(after) === typeKind(before)) {
    if (!same(after.type, before.type)) {
      kinds.push("settingsChanged");
    }
  } else {
    kinds.push("typeChanged");
  }

  if (!same(after.required, before.required)) {
    kinds.push("requiredChanged");
  }

  if (!same(after.readOnly, before.readOnly)) {
    kinds.push("readOnlyChanged");
  }

  return kinds;
};

const overrideKinds = (entry: DefinitionHistory): SchemaChangeKind[] => {
  const { before, after } = entry;
  const kinds: SchemaChangeKind[] = [];

  if (!same(after.required, before?.required ?? null)) {
    kinds.push("requiredChanged");
  }

  if (!same(after.readOnly, before?.readOnly ?? null)) {
    kinds.push("readOnlyChanged");
  }

  const bounds = ["maxLength", "min", "max"].some(
    (key) => !same(after[key], before?.[key] ?? null)
  );

  if (bounds) {
    kinds.push("settingsChanged");
  }

  return kinds;
};

/**
 * The fields of E's lineage that are required at C without a default
 * (overrides included): a create that leaves them out fails, so their
 * becoming required, or being added, since R is relevant (6.4).
 *
 * @param readScope - The caller's scope at C.
 * @param classId - The endpoint's class.
 * @returns Scope entries limited to `fieldAdded` and `requiredChanged`.
 */
const requiredWithoutDefault = (
  readScope: ReadScope,
  classId: DefinitionId
): readonly ScopeEntry[] =>
  effectiveFields(readScope.snapshot, classId).flatMap((field) =>
    field.required && field.default === null && field.field.state === "active"
      ? [
          {
            classId,
            fieldId: field.field.id,
            kinds: ["fieldAdded", "requiredChanged"],
          },
        ]
      : []
  );

/**
 * One entry per class and field: a field both in the request and required
 * without a default is listed once, with every kind relevant to either
 * (an entry without `kinds` takes all kinds).
 *
 * @param entries - The scope's entries.
 * @returns The entries without duplicates, in first-seen order.
 */
const mergeEntries = (
  entries: readonly ScopeEntry[]
): readonly ScopeEntry[] => {
  const merged = new Map<string, ScopeEntry>();

  for (const entry of entries) {
    const key = `${entry.classId}/${entry.fieldId}`;
    const seen = merged.get(key);

    if (seen === undefined) {
      merged.set(key, entry);
    } else if (seen.kinds === undefined || entry.kinds === undefined) {
      merged.set(key, { classId: entry.classId, fieldId: entry.fieldId });
    } else {
      merged.set(key, {
        ...seen,
        kinds: [...new Set([...seen.kinds, ...entry.kinds])],
      });
    }
  }

  return [...merged.values()];
};

const readHistory = Effect.fn("StaleRequest.readHistory")(function* readHistory(
  stated: ConfigState,
  current: ConfigState
) {
  const rows = yield* readRows(
    sql`WITH "changed" AS (
  SELECT DISTINCT "definition_id" FROM "core"."definition_revision"
  WHERE "revision" > ${textParameter(String(stated.revision), "int8")}
    AND "revision" <= ${textParameter(String(current.revision), "int8")}
    AND "kind" = ANY('{field,override,class}'::text[]))
SELECT "c"."definition_id"::text AS "id", "a"."kind" AS "kind", "a"."revision"::text AS "revision",
  "a"."effective"::text AS "after",
  (SELECT "b"."effective"::text FROM "core"."definition_revision" AS "b"
    WHERE "b"."definition_id" = "c"."definition_id"
      AND "b"."revision" <= ${textParameter(String(stated.revision), "int8")}
    ORDER BY "b"."revision" DESC LIMIT 1) AS "before"
FROM "changed" AS "c"
JOIN LATERAL (
  SELECT "x"."kind", "x"."revision", "x"."effective" FROM "core"."definition_revision" AS "x"
  WHERE "x"."definition_id" = "c"."definition_id"
    AND "x"."revision" <= ${textParameter(String(current.revision), "int8")}
  ORDER BY "x"."revision" DESC LIMIT 1) AS "a" ON true`
  );

  return rows.flatMap((row): DefinitionHistory[] => {
    const after = objectOf(row.after);

    return after === undefined || row.id === null || row.id === undefined
      ? []
      : [
          {
            after,
            before: objectOf(row.before),
            id: row.id,
            kind: row.kind ?? "",
            revision: Number(row.revision),
          },
        ];
  });
});

/** One field operation of the journal (Contracts 1.5). */
interface JournalOperation {
  readonly targetId: DefinitionId;
  readonly oldName: string | null;
  readonly newName: string | null;
  readonly revision: number;
}

const JournalOperationsSchema = Schema.Array(
  Schema.Struct({
    kind: Schema.NullOr(Schema.String),
    newName: Schema.NullOr(Schema.String),
    oldName: Schema.NullOr(Schema.String),
    targetId: Schema.String,
  })
);

const decodeOperations = Schema.decodeUnknownOption(
  Schema.fromJsonString(JournalOperationsSchema)
);

/**
 * The field operations the journal records in (R, C], with their names.
 *
 * @param stated - R.
 * @param current - C.
 * @returns The operations on fields, in revision order.
 */
const readJournal = Effect.fn("StaleRequest.readJournal")(function* readJournal(
  stated: ConfigState,
  current: ConfigState
) {
  const rows = yield* readRows(
    sql`SELECT "first_revision"::text AS "revision", "operations"::text AS "operations"
FROM "core"."schema_change"
WHERE "first_revision" > ${textParameter(String(stated.revision), "int8")}
  AND "first_revision" <= ${textParameter(String(current.revision), "int8")}
ORDER BY "first_revision"`
  );

  return rows.flatMap((row): JournalOperation[] =>
    Option.match(decodeOperations(row.operations ?? ""), {
      onNone: () => [],
      onSome: (operations) =>
        operations.flatMap((operation) =>
          operation.kind === "field"
            ? [
                {
                  newName: operation.newName,
                  oldName: operation.oldName,
                  revision: Number(row.revision),
                  targetId: operation.targetId,
                },
              ]
            : []
        ),
    })
  );
});

const journalReaches = Effect.fn("StaleRequest.journalReaches")(
  function* journalReaches(stated: ConfigState) {
    const rows = yield* readRows(
      sql`SELECT "id"::text AS "id" FROM "core"."schema_change"
WHERE "id" = ${textParameter(stated.changeSetId, "uuid")}
  AND "first_revision" <= ${textParameter(String(stated.revision), "int8")}
  AND coalesce("last_revision", "first_revision") >= ${textParameter(String(stated.revision), "int8")}`
    );

    return rows.length > 0;
  }
);

/**
 * Whether the caller can name a field on a class at C: readable for reads;
 * readable or writable for writes (Contracts 3.4).
 */
type Nameable = (classId: DefinitionId, fieldId: DefinitionId) => boolean;

/** What a write adds to the stale check. */
export interface WriteCheck {
  readonly action: WriteAction;
}

const readNameable =
  (readScope: ReadScope): Nameable =>
  (classId, fieldId) =>
    readScope.view(classId).byId(fieldId) !== undefined;

const writeNameable =
  (readScope: ReadScope, action: WriteAction): Nameable =>
  (classId, fieldId) =>
    isNameable(readScope, classId, action, fieldId);

const visibleEntries = (
  readScope: ReadScope,
  scope: StaleScope,
  nameable: Nameable
): {
  readonly entry: ScopeEntry;
  readonly name: string;
  readonly table: string;
}[] =>
  scope.entries.flatMap((entry) => {
    const field = readScope.snapshot.field(entry.fieldId);
    const table = readScope.snapshot.qualifiedNameOf(entry.classId);

    return field === undefined ||
      table === undefined ||
      !nameable(entry.classId, entry.fieldId)
      ? []
      : [{ entry, name: field.name, table }];
  });

const unknownChanges = (
  table: string,
  readScope: ReadScope,
  scope: StaleScope,
  nameable: Nameable
): SchemaChange[] => {
  const named = visibleEntries(readScope, scope, nameable);

  return named.length === 0
    ? [{ field: null, fieldId: null, kind: "unknown", revision: null, table }]
    : named.map(({ entry, name, table: entryTable }) => ({
        field: name,
        fieldId: entry.fieldId,
        kind: "unknown",
        revision: null,
        table: entryTable,
      }));
};

/**
 * Whether a definition on `classId` affects records read on `readOn`: it
 * is on the class, an ancestor or a descendant.
 *
 * @param readScope - The caller's scope at C.
 * @param classId - The definition's class.
 * @param readOn - The class the field is read on.
 * @returns True when it applies.
 */
const affects = (
  readScope: ReadScope,
  classId: DefinitionId,
  readOn: DefinitionId
): boolean =>
  readScope.snapshot.lineage(readOn).some((level) => level.id === classId) ||
  readScope.snapshot.subtreeIds(readOn).includes(classId);

const classChanges = (
  readScope: ReadScope,
  scope: StaleScope,
  entry: DefinitionHistory
): SchemaChange[] => {
  const retired =
    textOf(entry.after, "state") === "retired" &&
    textOf(entry.before, "state") !== "retired";

  return [...scope.classes].flatMap((classId): SchemaChange[] => {
    const table = readScope.snapshot.qualifiedNameOf(classId);

    const inLineage = readScope.snapshot
      .lineage(classId)
      .some((level) => level.id === entry.id);

    return retired && inLineage && table !== undefined
      ? [
          {
            field: null,
            fieldId: null,
            kind: "tableRetired",
            revision: entry.revision,
            table,
          },
        ]
      : [];
  });
};

/**
 * The classes on which a field of `fieldClass`, named any of `names` before
 * or after a change, takes a name the request used (Contracts 1.5, 6.4).
 *
 * @param readScope - The caller's scope at C.
 * @param scope - The request's scope at R.
 * @param fieldClass - The class that declares the field.
 * @param names - The field's old and new names.
 * @returns The classes the request read the name on.
 */
const nameMatches = (
  readScope: ReadScope,
  scope: StaleScope,
  fieldClass: DefinitionId,
  names: readonly (string | undefined | null)[]
): DefinitionId[] => {
  const wanted = new Set(names);

  return [
    ...new Set(
      scope.names.flatMap((scoped) =>
        wanted.has(scoped.name) &&
        affects(readScope, fieldClass, scoped.classId)
          ? [scoped.classId]
          : []
      )
    ),
  ];
};

/**
 * The scope entries a field or override definition change touches: the
 * field read on a class it affects, or a field whose old or new name the
 * request used there.
 *
 * @param readScope - The caller's scope at C.
 * @param scope - The request's scope at R.
 * @param entry - The definition's history in (R, C].
 * @returns The touched entries.
 */
const touched = (
  readScope: ReadScope,
  scope: StaleScope,
  entry: DefinitionHistory
): readonly ScopeEntry[] => {
  const classId = textOf(entry.after, "classId");

  const fieldId =
    entry.kind === "field" ? entry.id : textOf(entry.after, "fieldId");

  if (classId === undefined || fieldId === undefined) {
    return [];
  }

  const direct = scope.entries.filter(
    (scoped) =>
      scoped.fieldId === fieldId && affects(readScope, classId, scoped.classId)
  );

  // A field whose name at R or at C is a name the request used on a class
  // it affects (renamed into or out of the name, or added under it).
  const names =
    entry.kind === "field"
      ? [textOf(entry.before, "name"), textOf(entry.after, "name")]
      : [];

  const byName = nameMatches(readScope, scope, classId, names).map(
    (readOn) => ({ classId: readOn, fieldId })
  );

  return [...direct, ...byName];
};

/**
 * Changes the journal records by name (Contracts 1.5): an operation on a
 * field whose old or new name the request used on a class it affects is
 * `fieldRenamed` when the names differ and `fieldAdded` when it had none.
 *
 * @param readScope - The caller's scope at C.
 * @param scope - The request's scope at R.
 * @param operations - The journal's operations in (R, C].
 * @param nameable - Whether the caller can name a field at C.
 * @returns The changes, for fields the caller can name at C.
 */
const journalChanges = (
  readScope: ReadScope,
  scope: StaleScope,
  operations: readonly JournalOperation[],
  nameable: Nameable
): SchemaChange[] =>
  operations.flatMap((operation): SchemaChange[] => {
    const field = readScope.snapshot.field(operation.targetId);

    const renamed =
      operation.oldName !== null && operation.oldName !== operation.newName;

    const kind = operation.oldName === null ? "fieldAdded" : "fieldRenamed";

    if (field === undefined || (!renamed && operation.oldName !== null)) {
      return [];
    }

    const readOns = nameMatches(readScope, scope, field.classId, [
      operation.oldName,
      operation.newName,
    ]);

    return visibleEntries(
      readScope,
      {
        ...scope,
        entries: readOns.map((classId) => ({ classId, fieldId: field.id })),
      },
      nameable
    ).map(({ entry, name, table }) => ({
      field: name,
      fieldId: entry.fieldId,
      kind,
      revision: operation.revision,
      table,
    }));
  });

const relevantChanges = (
  readScope: ReadScope,
  scope: StaleScope,
  history: readonly DefinitionHistory[],
  operations: readonly JournalOperation[],
  nameable: Nameable
): SchemaChange[] => {
  const changes = new Map<string, SchemaChange>();

  for (const change of journalChanges(readScope, scope, operations, nameable)) {
    changes.set(
      `${change.table}/${change.fieldId ?? ""}/${change.kind}`,
      change
    );
  }

  for (const entry of history) {
    const found =
      entry.kind === "class"
        ? classChanges(readScope, scope, entry)
        : visibleEntries(
            readScope,
            { ...scope, entries: touched(readScope, scope, entry) },
            nameable
          ).flatMap(({ entry: scoped, name, table }) =>
            (entry.kind === "field"
              ? fieldKinds(entry)
              : overrideKinds(entry)
            ).flatMap((kind): SchemaChange[] =>
              scoped.kinds === undefined || scoped.kinds.includes(kind)
                ? [
                    {
                      field: name,
                      fieldId: scoped.fieldId,
                      kind,
                      revision: entry.revision,
                      table,
                    },
                  ]
                : []
            )
          );

    for (const change of found) {
      changes.set(
        `${change.table}/${change.fieldId ?? ""}/${change.kind}`,
        change
      );
    }
  }

  return [...changes.values()];
};

/**
 * Whether this database has the stated revision (Contracts 6.4): the same
 * state as the transaction's, or an older revision whose change set the
 * journal records at that number. A number above the current one, another
 * change set at that number, or a journal that no longer reaches it means
 * the client's revision does not describe this database. Decided without
 * looking up anything the request names.
 *
 * @param statedRevision - The request's revision, if it sent one.
 * @returns True when absent or known.
 */
export const isRevisionKnown = Effect.fn("StaleRequest.isKnown")(
  function* isRevisionKnown(statedRevision: Option.Option<ConfigState>) {
    if (Option.isNone(statedRevision)) {
      return true;
    }

    const stated = statedRevision.value;
    const current = yield* RequestRevision;

    const unchanged =
      stated.revision === current.revision &&
      stated.changeSetId === current.changeSetId;

    return (
      unchanged ||
      (stated.revision < current.revision && (yield* journalReaches(stated)))
    );
  }
);

/**
 * The refusal of a revision this database does not have: every field in
 * the request's scope counts as changed, kind `unknown` (Contracts 6.4).
 *
 * @param stated - The request's revision.
 * @param changes - The `unknown` entries of the scope, without duplicates.
 * @returns `SchemaChanged`.
 */
export const unknownRevision = Effect.fn("StaleRequest.unknownRevision")(
  function* unknownRevision(
    stated: ConfigState,
    changes: readonly SchemaChange[]
  ) {
    const current = yield* RequestRevision;

    return yield* new SchemaChanged({
      changes: [...changes],
      currentRevision: revisionHeaderValue(current),
      requestRevision: revisionHeaderValue(stated),
    });
  }
);

/**
 * Checks a stated revision against the transaction's (Contracts 6.4). Runs
 * inside the request transaction, for the acting user, before the request's
 * names are resolved at C.
 *
 * @param statedRevision - The request's revision, if it sent one.
 * @param table - The endpoint's table name.
 * @param parameters - The request's filter, sort, fields and labels; for
 *   a write, the body's field names as `fields`.
 * @param write - For a write: the action, which makes fields the caller
 *   can write nameable (3.4) and, for a create, adds the endpoint's fields
 *   that became required without a default.
 * @returns Nothing, or `SchemaChanged`.
 */
export const checkRequestRevision = Effect.fn("StaleRequest.check")(
  function* checkRequestRevision(
    statedRevision: Option.Option<ConfigState>,
    table: string,
    parameters: ScopeParameters,
    write?: WriteCheck
  ) {
    if (Option.isNone(statedRevision)) {
      return yield* Effect.void;
    }

    const stated = statedRevision.value;
    const current = yield* RequestRevision;

    if (
      stated.revision === current.revision &&
      stated.changeSetId === current.changeSetId
    ) {
      return yield* Effect.void;
    }

    const readScope = yield* currentReadScope();
    const classId = yield* resolveTable(readScope, table);

    const nameable =
      write === undefined
        ? readNameable(readScope)
        : writeNameable(readScope, write.action);

    const withRequired = (scope: StaleScope): StaleScope => ({
      ...scope,
      entries: mergeEntries([
        ...scope.entries,
        ...(write?.action === "create"
          ? requiredWithoutDefault(readScope, classId)
          : []),
      ]),
    });

    const failure = (changes: SchemaChange[]) =>
      new SchemaChanged({
        changes,
        currentRevision: revisionHeaderValue(current),
        requestRevision: revisionHeaderValue(stated),
      });

    const unreachable =
      stated.revision >= current.revision || !(yield* journalReaches(stated));

    if (unreachable) {
      const atC = yield* definitionsAt(current.revision);

      return yield* failure(
        unknownChanges(
          table,
          readScope,
          withRequired(staleScope(atC, classId, parameters)),
          nameable
        )
      );
    }

    const atR = yield* definitionsAt(stated.revision);
    const scope = withRequired(staleScope(atR, classId, parameters));
    const history = yield* readHistory(stated, current);
    const operations = yield* readJournal(stated, current);

    const changes = relevantChanges(
      readScope,
      scope,
      history,
      operations,
      nameable
    );

    if (changes.length > 0) {
      return yield* failure(changes);
    }

    return yield* Effect.void;
  }
);

/**
 * Checks a stated revision for a request that names no table or field
 * (sign-in, `auth/me`; Contracts 6.4): nothing in its scope can have
 * changed, so only a revision this database never had at that number (R
 * above C, or a different change set at R) refuses it, with
 * `409 SchemaChanged` and no changes listed: the client reloads.
 *
 * @param statedRevision - The request's revision, if it sent one.
 * @returns Nothing, or `SchemaChanged`.
 */
export const checkUnscopedRevision = Effect.fn("StaleRequest.checkUnscoped")(
  function* checkUnscopedRevision(statedRevision: Option.Option<ConfigState>) {
    if (Option.isNone(statedRevision)) {
      return yield* Effect.void;
    }

    const stated = statedRevision.value;
    const current = yield* RequestRevision;

    if (
      stated.revision === current.revision &&
      stated.changeSetId === current.changeSetId
    ) {
      return yield* Effect.void;
    }

    const unreachable =
      stated.revision >= current.revision || !(yield* journalReaches(stated));

    if (unreachable) {
      return yield* new SchemaChanged({
        changes: [],
        currentRevision: revisionHeaderValue(current),
        requestRevision: revisionHeaderValue(stated),
      });
    }

    return yield* Effect.void;
  }
);
