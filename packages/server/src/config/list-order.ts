/** Offline, atomic lifecycle of the deployment's deterministic ICU list order. */
import { generatedName } from "@std/definitions/ids";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { loadSnapshot } from "../catalog/load.ts";
import { createIndex } from "../schema/ddl.ts";
import { quoteIdent, quoteLiteral, tableName } from "../schema/sql-text.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { hygienic } from "../sql/errors.ts";
import { parseConfigState } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { hasLanguageOrder } from "./list-order-key.ts";

/** An unavailable or stale ordering policy; requires an offline upgrade. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class ListOrderRefused extends Schema.TaggedError<
  ListOrderRefused,
  { readonly brand: unique symbol }
>()("ListOrderRefused", { message: Schema.String }) {}

const decodeExists = decodeRows(Schema.Struct({ present: Schema.Boolean }));

const decodePolicy = decodeRows(
  Schema.Struct({
    actual_locale: Schema.NullOr(Schema.String),
    actual_version: Schema.NullOr(Schema.String),
    deterministic: Schema.Boolean,
    epoch: Schema.String,
    locale: Schema.String,
    provider: Schema.String,
    ready: Schema.Boolean,
    recorded_version: Schema.NullOr(Schema.String),
    version: Schema.String,
  })
);

/** Read the stored policy and observed ICU identity without altering either. */
const listOrderFacts = Effect.gen(function* listOrderFacts() {
  const sql = yield* SqlClient.SqlClient;

  const [exists] = yield* readOnly(
    sql`SELECT to_regclass('core.list_order_policy') IS NOT NULL AS present`
  ).pipe(Effect.flatMap(decodeExists));

  if (exists?.present !== true) {
    return yield* new ListOrderRefused({
      message:
        "List ordering is not installed; stop STD servers and run std upgrade.",
    });
  }

  const rows = yield* readOnly(sql`
    SELECT p.epoch::text, p.locale, p.version, p.indexes_ready AS ready,
      COALESCE(c.collprovider::text, '') AS provider,
      COALESCE(c.collisdeterministic, false) AS deterministic,
      c.colllocale AS actual_locale, c.collversion AS recorded_version,
      pg_collation_actual_version(c.oid) AS actual_version
    FROM core.list_order_policy p
    LEFT JOIN pg_collation c ON c.oid = to_regcollation('core.list_order')
    WHERE p.singleton`).pipe(Effect.flatMap(decodePolicy));

  const [policy] = rows;

  if (rows.length !== 1 || policy === undefined) {
    return yield* new ListOrderRefused({
      message:
        "List ordering requires exactly one core.list_order_policy row; restore the policy from backup before starting STD.",
    });
  }

  return policy;
});

/** Refuse startup and list continuation when ICU identity or index readiness has drifted. */
export const checkListOrder = Effect.gen(function* checkListOrder() {
  const policy = yield* listOrderFacts;

  const providerMatches =
    policy.provider === "i" &&
    policy.deterministic &&
    policy.actual_locale === policy.locale;

  const versionMatches =
    policy.version === policy.recorded_version &&
    policy.version === policy.actual_version;

  if (!policy.ready || !providerMatches || !versionMatches) {
    return yield* new ListOrderRefused({
      message: `List order requires deterministic ICU locale=${policy.locale}, version=${policy.version}, indexes_ready=true; observed provider=${policy.provider}, locale=${policy.actual_locale ?? "missing"}, catalog_version=${policy.recorded_version ?? "missing"}, actual_version=${policy.actual_version ?? "missing"}, indexes_ready=${policy.ready}. Stop STD servers and run std upgrade; it rebuilds dependent indexes before recording the new version.`,
    });
  }

  return policy;
});

const decodeLocale = decodeRows(Schema.Struct({ version: Schema.String }));

/** Resolve a registered deterministic ICU locale; there is no provider fallback. */
const listOrderLocale = Effect.fn("ListOrder.locale")(function* listOrderLocale(
  locale: string
) {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* readOnly(sql`
    SELECT pg_collation_actual_version(c.oid) AS version
    FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
    WHERE n.nspname = 'pg_catalog' AND c.collprovider = 'i'
      AND c.collisdeterministic AND c.colllocale = ${locale}
    ORDER BY c.oid LIMIT 1`).pipe(Effect.flatMap(decodeLocale));

  if (row === undefined) {
    return yield* new ListOrderRefused({
      message: `ICU list locale=${locale} is unavailable. Select an installed deterministic pg_catalog ICU locale (pg_collation.colllocale); no fallback is allowed.`,
    });
  }

  return {
    deterministic: true as const,
    locale,
    provider: "icu" as const,
    version: row.version,
  };
});

const decodeIndex = decodeRows(
  Schema.Struct({
    definition: Schema.String,
    index: Schema.String,
    schema: Schema.String,
  })
);

const decodeDependents = decodeRows(
  Schema.Struct({ unsupported: Schema.Boolean })
);

const generatedOrderIndexes = Effect.gen(function* generatedOrderIndexes() {
  const sql = yield* SqlClient.SqlClient;

  const [exists] = yield* readOnly(
    sql`SELECT to_regclass('core.config_state') IS NOT NULL AS present`
  ).pipe(Effect.flatMap(decodeExists));

  if (exists?.present !== true) {
    return new Map<string, string>();
  }

  const key = yield* parseConfigState(
    yield* readOnly(
      sql`SELECT revision::text AS revision, change_set_id::text AS change_set_id FROM core.config_state`
    )
  );

  const snapshot = yield* loadSnapshot(key);
  const generated = new Map<string, string>();

  for (const index of snapshot.all("index")) {
    const fields = index.fieldIds.flatMap((id) => {
      const field = snapshot.field(id);

      return field === undefined ? [] : [field];
    });

    if (
      index.state === "purged" ||
      !fields.some((field) => hasLanguageOrder(field.type))
    ) {
      continue;
    }

    const table = snapshot.class(index.classId);

    const namespace =
      table === undefined ? undefined : snapshot.namespace(table.namespaceId);

    if (namespace === undefined) {
      return yield* new ListOrderRefused({
        message: `Index ${index.id} has no owning namespace; run std doctor before upgrading.`,
      });
    }

    const name = `${quoteIdent(namespace.name)}.${quoteIdent(generatedName("ix", index.id))}`;

    const [indexExists] = yield* readOnly(
      sql`SELECT to_regclass(${name}) IS NOT NULL AS present`
    ).pipe(Effect.flatMap(decodeExists));

    if (indexExists?.present === true) {
      generated.set(
        name,
        createIndex(index.id, tableName(snapshot, index.classId), fields, {
          concurrently: false,
          unique: index.unique,
        }).sql
      );
    }
  }

  return generated;
});

/**
 * The reviewed target and the policy identity it replaces, covered by the plan hash.
 * @param locale - A registered ICU locale; absent keeps the installed default.
 * @returns The proposed transition and affected generated indexes.
 */
export const planListOrder = Effect.fn("ListOrder.plan")(
  function* planListOrder(locale: string | undefined) {
    const sql = yield* SqlClient.SqlClient;

    const [exists] = yield* readOnly(
      sql`SELECT to_regclass('core.list_order_policy') IS NOT NULL AS present`
    ).pipe(Effect.flatMap(decodeExists));

    const previous = exists?.present === true ? yield* listOrderFacts : null;

    if (
      previous !== null &&
      (previous.provider !== "i" ||
        !previous.deterministic ||
        previous.actual_locale !== previous.locale)
    ) {
      return yield* new ListOrderRefused({
        message:
          "core.list_order was changed outside std upgrade; restore the recorded deterministic ICU collation before planning an upgrade.",
      });
    }

    const target = yield* listOrderLocale(
      locale ?? previous?.locale ?? "en-GB"
    );

    const versionChanged =
      previous?.version !== target.version ||
      previous?.recorded_version !== target.version ||
      previous?.actual_version !== target.version;

    return {
      indexes: [...(yield* generatedOrderIndexes).keys()],
      previous,
      rebuild:
        previous === null ||
        !previous.ready ||
        previous.locale !== target.locale ||
        versionChanged,
      target,
    };
  },
  (effect) => hygienic(effect)
);

/**
 * Install or change order while the caller holds SCHEMA_KEY and all servers are stopped.
 * Each rebuild and the policy epoch commit together; a failure rolls everything back.
 * @param connection - The offline upgrade's locked dedicated connection.
 * @param locale - The requested locale, or the installed one.
 * @returns The installed provider, locale and version.
 */
export const applyListOrder = Effect.fn("ListOrder.upgrade")(
  function* applyListOrder(connection: DedicatedConnection, locale?: string) {
    return yield* connection.transactions.maintenance(
      Effect.gen(function* rebuildListOrder() {
        const sql = yield* SqlClient.SqlClient;
        const policy = yield* listOrderFacts;
        const selected = yield* listOrderLocale(locale ?? policy.locale);

        if (
          policy.provider !== "i" ||
          !policy.deterministic ||
          policy.actual_locale !== policy.locale
        ) {
          return yield* new ListOrderRefused({
            message:
              "core.list_order was changed outside std upgrade; restore the recorded deterministic ICU collation before upgrading.",
          });
        }

        const versionMatches =
          selected.version === policy.version &&
          policy.actual_version === policy.version &&
          policy.recorded_version === policy.version;

        if (
          policy.ready &&
          selected.locale === policy.locale &&
          versionMatches
        ) {
          return selected;
        }

        const [dependencies] = yield* readOnly(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.refclassid = 'pg_collation'::regclass AND d.refobjid = 'core.list_order'::regcollation
          AND NOT (d.classid = 'pg_class'::regclass AND EXISTS (
            SELECT 1 FROM pg_index i WHERE i.indexrelid = d.objid))
      ) AS unsupported`).pipe(Effect.flatMap(decodeDependents));

        if (dependencies?.unsupported === true) {
          return yield* new ListOrderRefused({
            message:
              "core.list_order has non-index dependent objects; remove their use of this STD-owned collation before upgrading. No objects were changed.",
          });
        }

        const dependent = yield* readOnly(sql`
      SELECT n.nspname AS schema, c.relname AS index,
        pg_get_indexdef(c.oid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.refclassid = 'pg_collation'::regclass
        AND d.refobjid = 'core.list_order'::regcollation)
      ORDER BY n.nspname, c.relname`).pipe(Effect.flatMap(decodeIndex));

        const generated = yield* generatedOrderIndexes;

        const indexes = new Map(
          dependent.map((index) => [
            `${quoteIdent(index.schema)}.${quoteIdent(index.index)}`,
            index.definition,
          ])
        );

        for (const [name, definition] of generated) {
          indexes.set(name, definition);
        }

        for (const name of indexes.keys()) {
          yield* sql.unsafe(`DROP INDEX ${name}`).unprepared;
        }

        yield* sql.unsafe("DROP COLLATION core.list_order").unprepared;
        yield* sql.unsafe(
          `CREATE COLLATION core.list_order (provider = icu, locale = ${quoteLiteral(selected.locale)}, deterministic = true)`
        ).unprepared;

        for (const definition of indexes.values()) {
          yield* sql.unsafe(definition).unprepared;
        }

        yield* sql`UPDATE core.list_order_policy SET epoch = uuidv7(), locale = ${selected.locale}, version = ${selected.version}, indexes_ready = true WHERE singleton`;

        yield* checkListOrder;

        return selected;
      }),
      {
        // Offline upgrade already excludes servers and holds SCHEMA_KEY. Rebuilding
        // all dependent indexes must finish before the policy commits (PG18 collation.html).
        // Contracts 1.4: the schema-DDL lock budget.
        lockTimeout: "2s",
        statementTimeout: "0ms",
      }
    );
  },
  hygienic
);
