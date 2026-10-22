/**
 * Helpers for the schema-path suites (Contracts 1.4 to 1.8 over HTTP):
 * the change-set endpoint, generic writes on definition tables, and what
 * a refused change set must leave as it was: the catalog, the committed
 * revision, the change entries and the outbox's delivery rows.
 */
import type { Definition } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import { parseJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { createFixtureUser } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { tableOf } from "../src/catalog/definition-tables.ts";
import { PATCH_FIELD_OPERATIONS } from "../src/http/definition-writes.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { deliveryCount } from "./outbox-support.ts";
import { values } from "./schema-support.ts";
import { patch, remove } from "./writes-support.ts";

/** The change-set endpoint. */
export const CHANGE_SETS = "/api/v1/schema/change-sets";

/**
 * `POST /api/v1/schema/change-sets` with operations.
 *
 * @param token - The session token.
 * @param operations - The operations.
 * @returns The response.
 */
export const postChangeSet = (
  token: string,
  operations: readonly Operation[]
) =>
  Effect.gen(function* post() {
    const http = yield* TestHttpClient;
    const parsed = parseJson(JSON.stringify({ operations }));
    const body: JsonValue = parsed.ok ? parsed.value : null;

    return yield* http.request("POST", CHANGE_SETS, { body, token });
  });

const SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

/** Body fields a generic `PATCH` dispatches to their own operations. */
const DISPATCHED: ReadonlySet<string> = new Set(
  PATCH_FIELD_OPERATIONS.map((entry) => entry.field)
);

/**
 * A fingerprint of every relation, column, constraint, index, trigger and
 * schema outside the system schemas.
 */
export const catalogFingerprint = values(
  `SELECT md5(string_agg(x, ',' ORDER BY x)) AS value FROM (
     SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relfilenode::text AS x
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT a.attrelid::regclass::text || '.' || a.attname || ':' || a.atttypid::text || ':' || a.attnotnull::text || ':' || a.attisdropped::text
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SCHEMAS} AND a.attnum > 0
     UNION ALL SELECT n.nspname || '.' || con.conname || ':' || con.convalidated::text
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT i.indexrelid::regclass::text || ':' || i.indisvalid::text
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT t.tgrelid::regclass::text || '.' || t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal
     UNION ALL SELECT nspname FROM pg_namespace
   ) AS f`
).pipe(Effect.map(([value]) => value ?? ""));

/** What a refused change set must leave as it was. */
export interface CommittedState {
  readonly catalog: string;
  readonly revision: string;
  readonly changeEntries: string;
  readonly deliveries: number;
  /** The definition tables' rows, as one digest. */
  readonly definitions: string;
}

/** A digest of every definition table's rows, as table owner. */
const definitionsDigest = values(
  `SELECT md5(string_agg(t.row, ',' ORDER BY t.row)) AS value FROM (
     SELECT row_to_json(x)::text AS row FROM core."namespace" x
     UNION ALL SELECT row_to_json(x)::text FROM core."class" x
     UNION ALL SELECT row_to_json(x)::text FROM core."field" x
     UNION ALL SELECT row_to_json(x)::text FROM core."field_override" x
     UNION ALL SELECT row_to_json(x)::text FROM core."index" x
     UNION ALL SELECT row_to_json(x)::text FROM core."role" x
     UNION ALL SELECT row_to_json(x)::text FROM core."permission" x
     UNION ALL SELECT row_to_json(x)::text FROM core."role_permission" x
     UNION ALL SELECT row_to_json(x)::text FROM core."access_rule" x
     UNION ALL SELECT row_to_json(x)::text FROM core."subscription" x
     UNION ALL SELECT row_to_json(x)::text FROM core."config_override" x
   ) AS t`
).pipe(Effect.map(([value]) => value ?? ""));

/**
 * The committed state a refusal must not change: the catalog, the
 * revision, the change entries, the delivery rows and the definitions.
 */
export const committedState = Effect.gen(function* readCommittedState() {
  const [revision = ""] = yield* values(
    "SELECT revision::text || '.' || change_set_id::text AS value FROM core.config_state"
  );

  const [changeEntries = ""] = yield* values(
    `SELECT count(*)::text AS value FROM core."change"`
  );

  return {
    catalog: yield* catalogFingerprint,
    changeEntries,
    definitions: yield* definitionsDigest,
    deliveries: yield* deliveryCount,
    revision,
  } satisfies CommittedState;
});

/**
 * The qualified table of a definition kind.
 *
 * @param definition - A definition.
 * @returns `core.<table>`.
 */
export const definitionTable = (definition: Definition): string =>
  `core.${tableOf(definition.kind).table}`;

/** A generic HTTP form of an operation on a stored definition. */
export type GenericForm =
  | {
      readonly method: "PATCH";
      readonly table: string;
      readonly body: Readonly<Record<string, JsonValue>>;
    }
  | { readonly method: "DELETE"; readonly table: string };

/**
 * The column values a generic `PATCH` sends for a property: its column,
 * or for an access rule's target its `target` and `fields` columns.
 *
 * @param definition - The stored definition.
 * @param property - The property.
 * @param value - Its value.
 * @returns The body, or undefined when no column holds the property.
 */
export const columnsOf = (
  definition: Definition,
  property: string,
  value: JsonValue
): Readonly<Record<string, JsonValue>> | undefined => {
  if (definition.kind === "accessRule" && property === "target") {
    const { target } = definition;

    return target.kind === "records"
      ? { fields: null, target: "records" }
      : {
          fields: target.fields === "*" ? null : [...target.fields],
          target: "fields",
        };
  }

  const spec = tableOf(definition.kind).columns.find(
    (candidate) => candidate.property === property
  );

  return spec === undefined ? undefined : { [spec.column]: value };
};

/**
 * The generic form of an operation on a stored definition: `DELETE` for
 * a delete, `PATCH` with `name` for a rename, with `state` for a retire or
 * reactivation, with the property's columns for an update. A purge has no
 * generic form (Contracts 1.6: `PATCH` maps `state` to retire or
 * reactivate only), nor has a reactivation of an active definition or a
 * retire of a retired one (the body equals the stored value and stands
 * for no operation).
 *
 * @param definition - The stored definition.
 * @param operation - An operation on it.
 * @returns The form, or undefined.
 */
export const genericFormOf = (
  definition: Definition,
  operation: Operation
): GenericForm | undefined => {
  const table = definitionTable(definition);

  const patchWith = (
    body: Readonly<Record<string, JsonValue>>
  ): GenericForm => ({
    body,
    method: "PATCH",
    table,
  });

  if (operation.op === "delete") {
    return { method: "DELETE", table };
  }

  if (operation.op === "rename") {
    return patchWith({ name: operation.name });
  }

  if (operation.op === "retire" || operation.op === "reactivate") {
    const state = operation.op === "retire" ? "retired" : "active";

    return definition.state === state ? undefined : patchWith({ state });
  }

  if (operation.op !== "update") {
    return undefined;
  }

  const changes: JsonObject = operation.changes;
  const [property] = Object.keys(changes);

  // A dispatched field (`name`, `state`) stands for its own operation, so
  // an update of it has no generic form; the rename covers `name`.
  const body =
    property === undefined || DISPATCHED.has(property)
      ? undefined
      : columnsOf(definition, property, changes[property] ?? null);

  return body === undefined ? undefined : patchWith(body);
};

/**
 * Sends a generic form with `If-Match` at the definition's version.
 *
 * @param token - The session token.
 * @param definition - The stored definition.
 * @param form - The form.
 * @returns The response.
 */
export const sendGeneric = (
  token: string,
  definition: Definition,
  form: GenericForm
) =>
  form.method === "DELETE"
    ? remove(token, form.table, definition.id, definition.version)
    : patch(token, form.table, definition.id, definition.version, form.body);

/**
 * Creates an active user with roles (by name) and signs them in.
 *
 * @param login - The login (also the name).
 * @param roles - Role names.
 * @returns The session token.
 */
export const userWithRoles = (login: string, roles: readonly string[]) =>
  Effect.gen(function* createAndSignIn() {
    const http = yield* TestHttpClient;
    const catalog = yield* Catalog;
    const { request } = yield* Transactions;

    yield* request(
      Effect.gen(function* createUser() {
        return yield* createFixtureUser(yield* catalog.current, {
          active: true,
          login,
          name: login,
          password: `${login}-password`,
          roles,
        });
      })
    ).pipe(Effect.orDie);

    return yield* http.signIn(login, `${login}-password`);
  });

/**
 * The current version of a definition.
 *
 * @param id - The definition.
 * @returns Its version, 0 when unknown.
 */
export const definitionVersion = (id: string) =>
  Effect.gen(function* readVersion() {
    return (yield* (yield* Catalog).refresh).get(id)?.version ?? 0;
  });
