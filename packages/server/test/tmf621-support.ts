/**
 * TMF621 test helpers (decision 0035): requests to the shipped TMF621 API
 * at its pinned base path as the helpdesk's users, over a Step 2 database
 * upgraded to helpdesk v3 (`itilLayer`). Every response is checked against
 * the pinned TMF621 document by the test client (`tmf-oas-contract`).
 */
import { TMF621_BASE_PATH } from "@std/tmf/tmf621";
import { stringifyJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { isJsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { HelpdeskFixture } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { asArray, asObject } from "./api-support.ts";

/** `/tmf-api/troubleTicket/v5/troubleTicket`. */
export const TICKETS = `${TMF621_BASE_PATH}/troubleTicket` as const;

/** `/tmf-api/troubleTicket/v5/troubleTicketSpecification`. */
export const SPECIFICATIONS =
  `${TMF621_BASE_PATH}/troubleTicketSpecification` as const;

/** JSON Patch's media type. */
export const JSON_PATCH = "application/json-patch+json";

/**
 * Each TMF621 status and the incident state it writes (Contracts 11.2):
 * the transition table's write column for incidents and plain tickets.
 */
export const TMF621_INCIDENT_STATES: readonly (readonly [string, string])[] = [
  ["acknowledged", "new"],
  ["inProgress", "in_progress"],
  ["pending", "on_hold"],
  ["held", "on_hold"],
  ["resolved", "resolved"],
  ["closed", "closed"],
  ["cancelled", "canceled"],
  ["rejected", "canceled"],
];

/** The helpdesk users a TMF621 test signs in as. */
export type Tmf621Login = "admin" | "agent" | "agent2" | "manager";

/** The major incident manager `itilLayer` creates. */
const MANAGER = { login: "itil-manager", password: "itil-manager-password" };

/** Requests as one user. */
export interface Tmf621Client {
  readonly get: (path: string) => Effect.Effect<TestResponse>;
  readonly post: (path: string, body: JsonValue) => Effect.Effect<TestResponse>;
  readonly patch: (
    path: string,
    body: JsonValue,
    options?: { readonly contentType?: string; readonly ifMatch?: string }
  ) => Effect.Effect<TestResponse>;
  readonly del: (
    path: string,
    options?: { readonly ifMatch?: string }
  ) => Effect.Effect<TestResponse>;
}

/**
 * The `If-Match` header of a request, when one is given.
 *
 * @param value - The header value, if any.
 * @returns The headers.
 */
const ifMatch = (value: string | undefined): Record<string, string> =>
  value === undefined ? {} : { "if-match": value };

/**
 * Signs in as a helpdesk user and returns its TMF621 client.
 *
 * @param login - The user.
 * @returns The client.
 */
export const tmf621As = Effect.fn("Tmf621.as")(function* tmf621As(
  login: Tmf621Login
) {
  const http = yield* TestHttpClient;
  const fixture = yield* HelpdeskFixture;

  const account =
    login === "manager"
      ? MANAGER
      : { login: fixture[login].login, password: fixture[login].password };

  const token = yield* http.signIn(account.login, account.password);

  const client: Tmf621Client = {
    del: (path, options = {}) =>
      http.request("DELETE", path, {
        headers: ifMatch(options.ifMatch),
        token,
      }),
    get: (path) => http.get(path, { token }),
    patch: (path, body, options = {}) =>
      http.request("PATCH", path, {
        headers: {
          ...ifMatch(options.ifMatch),
          "content-type": options.contentType ?? "application/merge-patch+json",
        },
        rawBody: stringifyJson(body),
        token,
      }),
    post: (path, body) => http.request("POST", path, { body, token }),
  };

  return client;
});

/**
 * A response's JSON object body (empty when it is not one).
 *
 * @param response - The response.
 * @returns The object.
 */
export const bodyOf = (response: TestResponse): JsonObject =>
  asObject(response.json);

/**
 * A response's JSON array body, its objects only (empty when it is no
 * array).
 *
 * @param response - The response.
 * @returns The items.
 */
export const itemsOf = (response: TestResponse): readonly JsonObject[] =>
  asArray(response.json).flatMap((item) => (isJsonObject(item) ? [item] : []));

/**
 * An array attribute's object items (empty when absent).
 *
 * @param resource - The resource.
 * @param name - The attribute.
 * @returns The items.
 */
export const arrayOf = (
  resource: JsonObject,
  name: string
): readonly JsonObject[] =>
  asArray(resource[name]).flatMap((item) => (isJsonObject(item) ? [item] : []));

/**
 * The resource's `ETag` version as an `If-Match` value.
 *
 * @param response - A response with `ETag`.
 * @returns The header value.
 */
export const etagOf = (response: TestResponse): string =>
  response.headers.get("etag") ?? "";

/**
 * A minimal valid create body.
 *
 * @param overrides - Attributes to add or replace.
 * @returns The body.
 */
export const ticketBody = (overrides: JsonObject = {}): JsonObject => ({
  "@type": "TroubleTicket",
  description: "The mail server rejects every login.",
  severity: "Major",
  ticketType: "incident",
  ...overrides,
});
