/**
 * Helpers for the schema-path suites (Contracts 1.4 to 1.8 over HTTP):
 * `applyChangeSet`, generic writes on definition tables (in API names),
 * and what
 * a refused change set must leave as it was: the catalog, the committed
 * revision, the change entries and the outbox's delivery rows.
 */
import type { Definition } from "@std/definitions/definition";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { Operation } from "@std/definitions/operation";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { createFixtureUser } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { tableOf } from "../src/catalog/definition-tables.ts";
import {
  PATCH_FIELD_OPERATIONS,
  READ_ONLY_COLUMNS,
} from "../src/http/definition-writes.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { patch, remove } from "./writes-support.ts";

/** The change-set task resource. */
export const CHANGE_SETS = "/api/v1/applyChangeSet";

/**
 * `POST /api/v1/applyChangeSet` with operations.
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

    return yield* http.request("POST", CHANGE_SETS, {
      body: { operations },
      token,
    });
  });

/** Body fields a generic `PATCH` dispatches to their own operations. */
const DISPATCHED: ReadonlySet<string> = new Set(
  PATCH_FIELD_OPERATIONS.map((entry) => entry.field)
);

/**
 * The qualified table of a definition kind.
 *
 * @param definition - A definition.
 * @returns `core.<table>`.
 */
export const definitionTable = (definition: Pick<Definition, "kind">): string =>
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
  definition:
    | Definition
    | Extract<Operation, { definition: unknown }>["definition"],
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
 * Maps a column-keyed body to API names (Contracts 10.2).
 * @param body - The column values.
 * @returns The same values under their API names.
 */
export const inApiNames = (
  body: Readonly<Record<string, JsonValue>>
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(body).map(([column, value]) => [
      apiAttributeNameOf(column),
      value,
    ])
  );

/**
 * A create draft as its definition table's writable column values.
 * @param operation - A create operation.
 * @returns The column body, or an empty body for other operations.
 */
export const createBodyOf = (operation: Operation) => {
  if (!("definition" in operation)) {
    return {};
  }

  const { definition } = operation;
  const draft: JsonObject = definition;
  const body: Record<string, JsonValue> = {};

  for (const spec of tableOf(definition.kind).columns) {
    const value = draft[spec.property];

    if (!READ_ONLY_COLUMNS.has(spec.column) && value !== undefined) {
      body[spec.column] = value;
    }
  }

  if (definition.kind === "accessRule") {
    Object.assign(body, columnsOf(definition, "target", draft.target ?? null));
  }

  return body;
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
    : patch(
        token,
        form.table,
        definition.id,
        definition.version,
        inApiNames(form.body)
      );

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
