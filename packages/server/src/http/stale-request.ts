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
 * - R below C: the definition revisions in (R, C] of the endpoint's class,
 *   its ancestors, their fields and overrides are compared with their state
 *   at R. A field change is relevant when the field's name at R or at C is
 *   a name the request uses (in `filter`, `sort` or `fields`); a retired
 *   table always is. Relevant kinds: `fieldAdded`, `fieldRenamed`,
 *   `fieldRetired`, `fieldPurged`, `typeChanged`, `settingsChanged`,
 *   `requiredChanged`, `readOnlyChanged`, `tableRetired`. Labels, display
 *   field and access rules are not relevant.
 * - `changes` lists only fields the caller can name at C; when nothing
 *   relevant is left the request proceeds, and names that resolve to no
 *   readable field get `UnknownField` as usual.
 *
 * Names are taken from the parameters word by word, so an extra word (a
 * keyword, a string's content) can only make more changes relevant, never
 * fewer. [judgment] Fields of reference targets named through paths are
 * not checked yet.
 */
import { SCHEMA_REVISION_HEADER } from "@std/api/api";
import { InvalidSchemaRevision } from "@std/api/errors/invalid-schema-revision";
import { SchemaChanged } from "@std/api/errors/schema-changed";
import type { SchemaChange, SchemaChangeKind } from "@std/api/errors/schemas";
import { sql, textParameter } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import { parseJsonbText } from "@std/values/postgres-text";
import { Effect, Option } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { currentReadScope, resolveTable } from "../records/read-records.ts";
import type { ReadView } from "../records/read-view.ts";
import { readRows } from "../records/sql-run.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import { revisionHeaderValue } from "./schema-revision-header.ts";

const HEADER =
  /^(?<revision>0|[1-9]\d{0,14})\.(?<changeSet>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/u;

const NAME = /[A-Z_a-z]\w*/gu;

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

const namesIn = (texts: readonly (string | undefined)[]): ReadonlySet<string> =>
  new Set(
    texts.flatMap((text) =>
      text === undefined ? [] : (text.match(NAME) ?? [])
    )
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

const unknownChanges = (
  table: string,
  view: ReadView,
  names: ReadonlySet<string>
): SchemaChange[] => {
  const named = view.fields.filter(
    (field) => field.system === undefined && names.has(field.name)
  );

  return named.length === 0
    ? [{ field: null, fieldId: null, kind: "unknown", revision: null, table }]
    : named.map((field) => ({
        field: field.name,
        fieldId: field.id,
        kind: "unknown",
        revision: null,
        table,
      }));
};

const relevantChanges = (
  table: string,
  view: ReadView,
  lineage: ReadonlySet<DefinitionId>,
  names: ReadonlySet<string>,
  history: readonly DefinitionHistory[]
): SchemaChange[] =>
  history.flatMap((entry): SchemaChange[] => {
    const { after, before } = entry;
    const classId = textOf(after, "classId");

    if (entry.kind === "class") {
      return lineage.has(entry.id) &&
        textOf(after, "state") === "retired" &&
        textOf(before, "state") !== "retired"
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
    }

    if (classId === undefined || !lineage.has(classId)) {
      return [];
    }

    const fieldId =
      entry.kind === "field" ? entry.id : textOf(after, "fieldId");

    const field = fieldId === undefined ? undefined : view.byId(fieldId);

    if (field === undefined) {
      return [];
    }

    const named =
      names.has(field.name) ||
      names.has(textOf(before, "name") ?? "") ||
      names.has(textOf(after, "name") ?? "");

    if (!named) {
      return [];
    }

    const kinds =
      entry.kind === "field" ? fieldKinds(entry) : overrideKinds(entry);

    return kinds.map((kind) => ({
      field: field.name,
      fieldId: field.id,
      kind,
      revision: entry.revision,
      table,
    }));
  });

/**
 * Checks a stated revision against the transaction's (Contracts 6.4). Runs
 * inside the request transaction, for the acting user, before the request's
 * names are resolved.
 *
 * @param statedRevision - The request's revision, if it sent one.
 * @param table - The endpoint's table name.
 * @param parameters - The texts that name fields.
 * @returns Nothing, or `SchemaChanged`.
 */
export const checkRequestRevision = Effect.fn("StaleRequest.check")(
  function* checkRequestRevision(
    statedRevision: Option.Option<ConfigState>,
    table: string,
    parameters: readonly (string | undefined)[]
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

    const scope = yield* currentReadScope();
    const classId = yield* resolveTable(scope, table);
    const view = scope.view(classId);
    const names = namesIn(parameters);

    const failure = (changes: SchemaChange[]) =>
      new SchemaChanged({
        changes,
        currentRevision: revisionHeaderValue(current),
        requestRevision: revisionHeaderValue(stated),
      });

    const unreachable =
      stated.revision >= current.revision || !(yield* journalReaches(stated));

    if (unreachable) {
      return yield* failure(unknownChanges(table, view, names));
    }

    const lineage = new Set(
      scope.snapshot.lineage(classId).map((level) => level.id)
    );

    const history = yield* readHistory(stated, current);
    const changes = relevantChanges(table, view, lineage, names, history);

    if (changes.length > 0) {
      return yield* failure(changes);
    }

    return yield* Effect.void;
  }
);
