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
import type { OwnerRecord } from "../../testing/src/owner-records.ts";
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
  /** The error's `code` (its tag). */
  readonly tag?: string;
  /** Resource names (`name`), in response order. */
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

// A TMF Error's `code` (Contracts 10.6).
const tagOfBody = (json: JsonValue | undefined): string | undefined => {
  const { code } = objectOf(json);

  return code !== undefined && isJsonString(code) ? code : undefined;
};

/**
 * The name of a resource: its `name`, else its ID.
 *
 * @param record - A resource.
 * @returns The name.
 */
export const nameOf = (record: JsonValue): string => {
  const { id, name } = objectOf(record);

  return textOf(name ?? id);
};

/**
 * The names of a list's resources, in order.
 *
 * @param json - A list body (an array of resources).
 * @returns The names.
 */
export const listNames = (json: JsonValue | undefined): string[] =>
  arrayOf(json).map(nameOf);

/**
 * A single-resource body.
 *
 * @param json - The body.
 * @returns The resource, or an empty object.
 */
export const recordIn = (json: JsonValue | undefined): JsonObject =>
  objectOf(json);

/**
 * Reduces a response: its status, and its error code when it failed.
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

/** Cursor-null acceptance workload (Contracts 3.5): 1,000 visible rows. */
export const CURSOR_ROWS = 1000;

const MULTIPLIER = 1_103_515_245;
const INCREMENT = 12_345;
const MODULUS = 2 ** 31;
const DAYS = 28;
const NULL_SHARE = 0.1;
const MAX_COST = 3000;
const LOST_SHARE = 0.5;

/**
 * A deterministic sequence of pseudo-random numbers.
 * @param seed - The start.
 * @returns The next number from 0 to 1.
 */
export const sequence = (seed: number) => {
  let state = seed;

  return (): number => {
    state = (state * MULTIPLIER + INCREMENT) % MODULUS;

    return state / MODULUS;
  };
};

/**
 * Bob's bulk assets: half lost (their purchased_on is hidden from him),
 * some without a date, many with equal dates.
 * @param bob - Bob's user ID.
 * @param random - The number source.
 * @returns The records.
 */
export const bulkRecords = (bob: string, random: () => number): OwnerRecord[] =>
  Array.from({ length: CURSOR_ROWS }, (_, index) => ({
    by: bob,
    values: {
      cost: String(Math.floor(random() * MAX_COST)),
      name: `bulk-${String(index).padStart(4, "0")}`,
      owner: bob,
      purchased_on:
        random() < NULL_SHARE
          ? null
          : `2024-01-${String(1 + Math.floor(random() * DAYS)).padStart(2, "0")}`,
      status: random() < LOST_SHARE ? "lost" : "in_use",
    },
  }));

/** Sorts covering masked cursor keys in both directions. */
export const CURSOR_SORTS = [
  "purchasedOn",
  "-purchasedOn",
  "status,-purchasedOn",
  "-status,purchasedOn,name",
];
