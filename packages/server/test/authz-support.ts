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
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { deliveryCount, subscribe } from "./outbox-support.ts";

/** The callers of the two-user example, plus the administrator. */
export type Who = "alice" | "bob" | "admin";

/**
 * How the callers present their sessions (decision 0018): a bearer token,
 * the web app's session cookie with `STD-Client: web`, or the cookie
 * without that header, as a cross-site form would send it.
 */
export type Transport = "bearer" | "cookie" | "cookieWithoutHeader";

/** Both ways a real client presents a session. */
export const TRANSPORTS: readonly Transport[] = ["bearer", "cookie"];

/** Session tokens, how they are presented, and the fixture. */
export interface Callers {
  readonly tokens: Readonly<Record<Who, string>>;
  readonly transport: Transport;
  readonly fixture: AcmeData;
}

/**
 * Signs in Alice, Bob and Ada (admin): by `POST /auth/sign-in`, or for a
 * cookie transport by `POST /auth/cookie-sign-in`.
 *
 * @param transport - How the sessions are presented.
 * @returns The callers.
 */
export const signInAllBy = Effect.fn("AuthzSupport.signInAllBy")(
  function* signInAllBy(transport: Transport) {
    const http = yield* TestHttpClient;
    const fixture = yield* AcmeFixture;

    const signIn = (login: string) =>
      transport === "bearer"
        ? http.signIn(login, `${login}-password`)
        : http.cookieSignIn(login, `${login}-password`);

    const tokens: Record<Who, string> = {
      admin: yield* signIn("ada"),
      alice: yield* signIn("alice"),
      bob: yield* signIn("bob"),
    };

    return { fixture, tokens, transport } satisfies Callers;
  }
);

/** Signs in Alice, Bob and Ada (admin) with bearer tokens. */
export const signInAll = signInAllBy("bearer");

/**
 * The request options that present a session the callers' way.
 *
 * @param transport - How sessions are presented.
 * @param token - The session token.
 * @returns `token`, or `cookie` with or without `STD-Client: web`.
 */
export const presenting = (
  transport: Transport,
  token: string
): Pick<TestRequestOptions, "cookie" | "token" | "webClient"> =>
  transport === "bearer"
    ? { token }
    : { cookie: token, webClient: transport === "cookie" };

/**
 * The same callers presenting their sessions as bearer tokens, for setup
 * that is not under test (a cookie sign-in's token is a bearer token too).
 *
 * @param callers - The callers.
 * @returns The callers, by bearer token.
 */
export const asBearer = (callers: Callers): Callers => ({
  ...callers,
  transport: "bearer",
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
 * @param fieldValues - Field values besides `owner`.
 * @returns The record ID.
 */
export const freshAsset = (
  owner: DefinitionId,
  classId: DefinitionId,
  fieldValues: Readonly<Record<string, JsonValue>>
) => seedRecord(owner, classId, { owner, ...fieldValues });

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
