/**
 * Helpers for the Step 1 authorization suites (Contracts 3): sessions for
 * the fixture users, fresh records made through the save pipeline, and
 * responses reduced to what a table of expected outcomes compares.
 */
import type { DefinitionId } from "@std/definitions/ids";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture, seedRecord } from "../../testing/src/acme-fixture.ts";
import type { AcmeData } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { deliveryCount, subscribe } from "./outbox-support.ts";

/** The callers of the two-user example, plus the administrator. */
export type Who = "alice" | "bob" | "admin";

/** Session tokens and the fixture. */
export interface Callers {
  readonly tokens: Readonly<Record<Who, string>>;
  readonly fixture: AcmeData;
}

/** Signs in Alice, Bob and Ada (admin). */
export const signInAll = Effect.gen(function* signInAll() {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;

  const tokens: Record<Who, string> = {
    admin: yield* http.signIn("ada", "ada-password"),
    alice: yield* http.signIn("alice", "alice-password"),
    bob: yield* http.signIn("bob", "bob-password"),
  };

  return { fixture, tokens } satisfies Callers;
});

/**
 * The user ID of a caller.
 *
 * @param fixture - The fixture.
 * @param who - The caller.
 * @returns The user ID.
 */
export const userOf = (fixture: AcmeData, who: Who): DefinitionId =>
  fixture[who].id;

/**
 * A fresh asset owned by `owner`, created through the save pipeline with
 * every record allowed, as its owner.
 *
 * @param owner - The owner (and creator).
 * @param classId - The class.
 * @param values - Field values besides `owner`.
 * @returns The record ID.
 */
export const freshAsset = (
  owner: DefinitionId,
  classId: DefinitionId,
  values: Readonly<Record<string, JsonValue>>
) => seedRecord(owner, classId, { owner, ...values });

/**
 * A subscription to every create, update and delete of a class and its
 * descendants, so every committed save there writes a delivery row in its
 * transaction (Contracts 4.6) and a refused one must leave none.
 *
 * @param classId - The class.
 * @param identityId - The subscription's identity.
 * @returns The subscription's ID.
 */
export const subscribeToEverySave = (
  classId: DefinitionId,
  identityId: DefinitionId
) => subscribe({ classId, identityId });

/**
 * How many delivery rows exist, as table owner.
 *
 * @returns The count.
 */
export const deliveries = () => deliveryCount;

/** What a table of expected outcomes compares. */
export interface Observation {
  readonly status: number;
  /** The error's `_tag`. */
  readonly tag?: string;
  /** Record names (`values.name`), in response order. */
  readonly names?: readonly string[];
  /** Anything else the row checks. */
  readonly detail?: JsonValue;
}

/**
 * A JSON value as an object.
 *
 * @param value - Any JSON value, or nothing.
 * @returns The object, or an empty one.
 */
export const objectOf = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

/**
 * A JSON value as an array.
 *
 * @param value - Any JSON value, or nothing.
 * @returns The array, or an empty one.
 */
export const arrayOf = (value: JsonValue | undefined): readonly JsonValue[] =>
  value !== undefined && isJsonArray(value) ? value : [];

/**
 * A JSON value as text: a string as is, anything else as JSON.
 *
 * @param value - Any JSON value, or nothing.
 * @returns The text.
 */
export const textOf = (value: JsonValue | undefined): string =>
  value !== undefined && isJsonString(value)
    ? value
    : JSON.stringify(value ?? null);

const tagOfBody = (json: JsonValue | undefined): string | undefined => {
  const tag = objectOf(json)._tag;

  return tag !== undefined && isJsonString(tag) ? tag : undefined;
};

/**
 * The name of a record in a body: `values.name`, else its ID.
 *
 * @param record - A record object.
 * @returns The name.
 */
export const nameOf = (record: JsonValue): string => {
  const { name } = objectOf(objectOf(record).values);

  return textOf(name ?? objectOf(record).id);
};

/**
 * The names of a list body's records, in order.
 *
 * @param json - A list body.
 * @returns The names.
 */
export const listNames = (json: JsonValue | undefined): string[] =>
  arrayOf(objectOf(json).records).map(nameOf);

/**
 * The record of a single-record body.
 *
 * @param json - A body with `record`.
 * @returns The record object, or an empty one.
 */
export const recordIn = (json: JsonValue | undefined): JsonObject =>
  objectOf(objectOf(json).record);

/**
 * Reduces a response: its status, and its tag when it failed.
 *
 * @param response - The response.
 * @param extra - Names and details of a success.
 * @returns The observation.
 */
export const observe = (
  response: TestResponse,
  extra: Omit<Observation, "status" | "tag"> = {}
): Observation => {
  const tag = tagOfBody(response.json);

  if (response.status >= 400) {
    return tag === undefined
      ? { status: response.status }
      : { status: response.status, tag };
  }

  return { status: response.status, ...extra };
};

/**
 * An error outcome.
 *
 * @param status - The HTTP status.
 * @param tag - The error's tag.
 * @returns The observation.
 */
export const refused = (status: number, tag: string): Observation => ({
  status,
  tag,
});
