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

/** Body fields a generic `PATCH` dispatches to their own operations. */
const DISPATCHED: ReadonlySet<string> = new Set(
  PATCH_FIELD_OPERATIONS.map((entry) => entry.field)
);

export { catalogFingerprint, committedState } from "./committed-state.ts";

export type { CommittedState } from "./committed-state.ts";

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
