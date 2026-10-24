/** Dead deliveries queried through the API's shared read grammar and masks. */
import {
  arrayParameter,
  identSql,
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { isLive } from "@std/definitions/definition";
import type { FieldType } from "@std/values/field-type";
import { Effect, Option } from "effect";
import { constUndefined } from "effect/Function";

import type { ListQuery } from "../http/api/query.ts";
import {
  cursorPredicate,
  finishPage,
  keyExpression,
  orderBy,
} from "../records/read-cursor.ts";
import type { CompiledKey } from "../records/read-cursor.ts";
import { apiNameIndex } from "../records/read-field.ts";
import type { ReadField } from "../records/read-field.ts";
import { compileFilterExpr } from "../records/read-query.ts";
import type { Page } from "../records/read-records.ts";
import { currentReadScope } from "../records/read-records.ts";
import type { ReadScope, ReadView } from "../records/read-view.ts";
import { recordRelation } from "../records/relation.ts";
import { readRows } from "../records/sql-run.ts";
import { DeliveryHandlers } from "./delivery-effects.ts";
import { subscriptionState } from "./served.ts";

const CLASS_ID = "00000000-0000-4000-8000-535444dead00";
const TEXT: FieldType = { caseSensitive: true, kind: "longText" };

const TYPES = {
  attempts: { kind: "integer" },
  change_id: { kind: "uuid" },
  dead_letter_policy: TEXT,
  finished_at: { kind: "dateTime" },
  id: { kind: "bigInteger" },
  last_error: TEXT,
  record_id: { kind: "uuid" },
  record_version: { kind: "bigInteger" },
  status: TEXT,
  subscription_id: { kind: "uuid" },
  subscription_state: TEXT,
} satisfies Readonly<Record<string, FieldType>>;

/** A fixed resource's read view; every query sees the same masked relation. */
export const deadDeliveryScope = Effect.fn("Outbox.deadDeliveryScope")(
  function* deadDeliveryScope() {
    const base = yield* currentReadScope();

    const fields: ReadField[] = Object.entries(TYPES).map(
      ([name, type], index) => ({
        classId: CLASS_ID,
        id: `00000000-0000-4000-8001-535444dead${String(index).padStart(2, "0")}`,
        name,
        retired: false,
        type,
      })
    );

    const classField: ReadField = {
      classId: CLASS_ID,
      id: "00000000-0000-4000-8001-535444deadff",
      name: "class",
      retired: false,
      system: "class",
      type: TEXT,
    };

    const byName = new Map(
      [...fields, classField].map((field) => [field.name, field])
    );

    const byId = new Map(
      [...fields, classField].map((field) => [field.id, field])
    );

    const byApiName = apiNameIndex(fields);

    const value = (alias: string, field: ReadField) =>
      field === classField
        ? sql`${textParameter("DeadDelivery", "text")}`
        : identSql(alias, field.name);

    const view: ReadView = {
      anyVisible: true,
      byApiName: (name) => byApiName.get(name),
      byId: (id) => byId.get(id),
      byName: (name) => byName.get(name),
      classId: CLASS_ID,
      classIds: [CLASS_ID],
      fields,
      isAlways: () => true,
      membership: () => rawSql("TRUE"),
      output: value,
      readable: () => rawSql("TRUE"),
      schema: {
        byId: constUndefined,
        byName: constUndefined,
        classId: CLASS_ID,
        classIds: [CLASS_ID],
        fields: [],
        rows: {
          groups: [{ classIds: [CLASS_ID], decision: { kind: "always" } }],
        },
      },
      value,
      visibility: () => rawSql("TRUE"),
      visibilityBranches: () => [rawSql("TRUE")],
    };

    const scope: ReadScope = {
      caller: base.caller,
      context: base.context,
      snapshot: base.snapshot,
      view: (id, exact) => (id === CLASS_ID ? view : base.view(id, exact)),
    };

    return { scope, view };
  }
);

/**
 * Readable record identities are selected in a batch per concrete class,
 * using ordinary record visibility. The masked columns feed projection,
 * filters, counts, sort keys and cursors alike.
 */
const deadRelation = Effect.fn("Outbox.deadRelation")(function* deadRelation(
  scope: ReadScope
) {
  const classes = yield* readRows(
    rawSql(`SELECT DISTINCT c.record_class_id::text AS class_id, d.subscription_id::text AS subscription_id
    FROM core.delivery d JOIN core.change c ON c.id = d.change_id WHERE d.status = 'dead'`)
  );

  const visible: SqlFragment[] = [];

  const classIds = new Set(
    classes.flatMap((row) =>
      row.class_id === null || row.class_id === undefined ? [] : [row.class_id]
    )
  );

  for (const classId of classIds) {
    const cls = scope.snapshot.class(classId);

    if (cls === undefined || !isLive(cls)) {
      continue;
    }

    const view = scope.view(classId, true);

    if (view.anyVisible) {
      visible.push(sql`SELECT ${identSql("v", "id")}, ${identSql("v", "class_id")}
      FROM ${recordRelation(scope.snapshot, classId)} AS "v"
      WHERE ${view.visibility("v")} AND "v"."id" IN (SELECT record_id FROM core.delivery WHERE status = 'dead')`);
    }
  }

  const identities =
    visible.length === 0
      ? rawSql("SELECT NULL::uuid AS id, NULL::uuid AS class_id WHERE FALSE")
      : joinSql(visible, " UNION ALL ");

  const handlers = yield* DeliveryHandlers;

  const subscriptionIds = new Set(
    classes.flatMap((row) =>
      row.subscription_id === null || row.subscription_id === undefined
        ? []
        : [row.subscription_id]
    )
  );

  const current = [...subscriptionIds].flatMap((id) => {
    const subscription = scope.snapshot.getKind("subscription", id);

    return subscription === undefined ? [] : [subscription];
  });

  const subscriptionRows = sql`SELECT id, state, policy FROM unnest(
    ${arrayParameter(
      current.map(({ id }) => id),
      "uuid"
    )},
    ${arrayParameter(
      current.map((subscription) =>
        subscriptionState(scope.snapshot, handlers, subscription)
      ),
      "text"
    )},
    ${arrayParameter(
      current.map(({ deadLetter }) => deadLetter),
      "text"
    )}
  ) AS subscription_state(id, state, policy)`;

  return sql`(SELECT d.id, d.subscription_id, d.change_id,
    CASE WHEN v.id IS NOT NULL THEN d.record_id END AS record_id,
    CASE WHEN v.id IS NOT NULL THEN d.record_version END AS record_version,
    (v.id IS NULL) AS restricted, d.attempts, d.last_error, d.finished_at, d.status,
    COALESCE(s.state, 'deleted') AS subscription_state, s.policy AS dead_letter_policy
    FROM core.delivery d JOIN core.change c ON c.id = d.change_id
    LEFT JOIN (${identities}) v ON v.id = d.record_id AND v.class_id = c.record_class_id
    LEFT JOIN (${subscriptionRows}) s ON s.id = d.subscription_id
    WHERE d.status = 'dead')`;
});

/** One page of masked dead deliveries, using shared filters and cursors. */
export const readDeadPage = Effect.fn("Outbox.readDeadPage")(
  function* readDeadPage(scope: ReadScope, view: ReadView, query: ListQuery) {
    const relation = yield* deadRelation(scope);
    const filters = [];

    if (Option.isSome(query.tmf)) {
      filters.push(
        yield* compileFilterExpr(scope, view, query.tmf.value, new Map(), {
          aliasPrefix: "t",
          exactText: true,
        })
      );
    }

    if (Option.isSome(query.condition)) {
      filters.push(
        yield* compileFilterExpr(
          scope,
          view,
          query.condition.value.expr,
          query.condition.value.spans
        )
      );
    }

    const where =
      filters.length === 0
        ? rawSql("TRUE")
        : joinSql(
            filters.map((filter) => filter.predicate),
            " AND "
          );

    const joins = joinSql(
      filters.map((filter) => filter.joins),
      " "
    );

    const reversed =
      query.cursors.before !== undefined && query.cursors.after === undefined;

    const keys: CompiledKey[] = query.sortKeys.map((key) => ({
      expression: keyExpression(key.field.type, view.value("r", key.field)),
      key,
    }));

    const flipped = keys.map((key) => ({
      ...key,
      key: { ...key.key, descending: !key.key.descending },
    }));

    const positions = [where];

    if (query.cursors.after !== undefined) {
      positions.push(
        cursorPredicate(
          keys,
          query.cursors.after,
          identSql("r", "id"),
          false,
          "int8"
        )
      );
    }

    if (query.cursors.before !== undefined) {
      positions.push(
        cursorPredicate(
          flipped,
          query.cursors.before,
          identSql("r", "id"),
          true,
          "int8"
        )
      );
    }

    const selected = new Set(query.selection.map((item) => item.field.id));

    const columns = [
      ...view.fields.flatMap((field) =>
        field.name === "id" || selected.has(field.id)
          ? [sql`${view.value("r", field)}::text AS ${identSql(field.name)}`]
          : []
      ),
      rawSql('"r"."restricted"::text AS restricted'),
      ...keys.map(
        (key, index) =>
          sql`${key.expression}::text AS ${identSql(["k", String(index)].join(""))}`
      ),
    ];

    const rows =
      yield* readRows(sql`SELECT ${joinSql(columns, ", ")} FROM ${relation} AS "r" ${joins}
    WHERE ${joinSql(positions, " AND ")} ORDER BY ${orderBy(reversed ? flipped : keys, identSql("r", "id"), reversed)}
    LIMIT ${textParameter(String(query.limit + 1), "int8")} OFFSET ${textParameter(String(query.offset), "int8")}`);

    const {
      rows: pageRows,
      firstCursor,
      hasMore,
      nextCursor,
    } = finishPage(rows, query.limit, reversed, query.sortKeys);

    const [total] = query.withCount
      ? yield* readRows(
          sql`SELECT count(*)::text AS total FROM ${relation} AS "r" ${joins} WHERE ${where}`
        )
      : [];

    const page: Page = {
      firstCursor,
      hasMore,
      nextCursor,
      records: [],
    };

    return {
      page: query.withCount
        ? { ...page, count: Number(total?.total ?? "0") }
        : page,
      rows: pageRows,
    };
  }
);
