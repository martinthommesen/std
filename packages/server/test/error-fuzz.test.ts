/**
 * `error-fuzz` (Contracts 3 "Acceptance tests", 3.8; plan Step 1 gate):
 * fuzzed constraint violations on every write path never return Postgres
 * text, constraint names or stored values.
 *
 * A fuzz hierarchy (`site.fuzz_item`, child `site.fuzz_special`) is created
 * through a change set: a case-insensitive unique `code`, a required short
 * `name`, an integer, a decimal, a date, a reference to itself and one to
 * `core.user`; the child adds its own unique `tag`. As table owner the test
 * then adds what the record service does not know about, so raw Postgres
 * errors reach the edge: a CHECK constraint, a NOT NULL on an optional
 * column and a trigger whose error message, detail and hint carry stored
 * values.
 *
 * fast-check drives sequences of creates, updates and deletes through the
 * parent and child endpoints and `core.user` as an admin, and through
 * `acme.asset` and `acme.laptop` as Alice: duplicate unique values in any
 * case, references to live, deleted, random and other-class records,
 * deletes of referenced records, check and NOT NULL violations, wrong JSON
 * types, overlong text, out-of-range numbers, bad decimals and dates, and
 * stale, missing or malformed versions. Every response is checked: a
 * documented status, no Postgres wording or constraint name, no stored
 * value or ID of a record the request did not name, an empty body on 500,
 * and error bodies with nothing but their documented members (a unique
 * conflict says only that the value is taken; `Referenced` says nothing
 * else). Each run must reach every outcome, so the property is not vacuous.
 * A refusal may repeat only what the request sent: no stored value of any
 * record, the target included; a success may also show the saved record's
 * own projection.
 *
 * A deterministic matrix guarantees what the fuzz only samples: every
 * constraint (unique on the parent and the child, required, type, length,
 * the owner's CHECK and NOT NULL, the reference precheck, the FK backstop,
 * a referenced delete) × every operation it applies to × both endpoints
 * gives its intended refusal. The FK backstop deletes the target in
 * another transaction held open until the write waits on its row lock
 * (observed in `pg_stat_activity`), so Postgres's FK check, not the
 * record service's precheck, refuses it: still `InvalidReference`.
 *
 * Everything runs against `/api/v1` and `/api/v2` (Contracts 10): the steps
 * and the matrix are written once in v1 terms, and `send` puts each request
 * in its version's form (v2 collection names, camelCase attributes,
 * `{ "id": ... }` references, merge-patch bodies) while `parsedOf` reads a
 * v2 response (a TMF `Error`, a resource with `revision`) as the v1 shape
 * the checks know. Where v2 differs (a stale `If-Match` is 412, deletes are
 * 204, error bodies carry the TMF members) the checks take the version.
 * Writes to definition tables answer 405 in v2 and are not part of the
 * fuzz, which writes only to record tables.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { isJsonNumber, isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Deferred, Effect, Fiber, Option, Schema } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";
import {
  array,
  asyncProperty,
  boolean,
  check,
  constant,
  constantFrom,
  integer,
  nat,
  oneof,
  record,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import {
  AcmeFixture,
  createFixtureUser,
} from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestHttpClientApi,
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { deliveryCount, subscribe } from "./outbox-support.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import {
  addField,
  addIndex,
  change,
  createClass,
  ensureSite,
  SITE_NAMESPACE_ID,
} from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const ITEM = "site.fuzz_item";
const SPECIAL = "site.fuzz_special";
const USER = "core.user";
const ASSET = "acme.asset";
const LAPTOP = "acme.laptop";

const NAME_MAX_LENGTH = 10;

/** Stored text the trigger puts into its error message, detail and hint. */
const TRIGGER_SECRET = "trigger-secret-detail";

/**
 * Postgres wording, constraint names and the owner's objects (`xq_`), which
 * must never reach a client. Compared in lower case.
 */
const FORBIDDEN = [
  "violates",
  "duplicate key",
  "constraint",
  "key (",
  "detail",
  "relation ",
  "column",
  "syntax",
  "null value",
  "sqlstate",
  "pg_",
  "std_ix_",
  "std_fk_",
  "std_ck_",
  "std_nn_",
  "std_cb_",
  "std_ub_",
  "_not_null",
  "out of range",
  "invalid input",
  "xq_",
  "boom ",
  TRIGGER_SECRET,
];

/** The API versions the fuzz runs against. */
type ApiVersion = "v1" | "v2";

const VERSIONS: readonly ApiVersion[] = ["v1", "v2"];

const V1_STATUSES: ReadonlySet<number> = new Set([
  200, 201, 400, 403, 404, 409, 422, 428, 500,
]);

// v2: a stale If-Match is 412 and a delete is 204.
const V2_STATUSES: ReadonlySet<number> = new Set([
  200, 201, 204, 400, 403, 404, 409, 412, 422, 428, 500,
]);

const statusesOf = (version: ApiVersion): ReadonlySet<number> =>
  version === "v2" ? V2_STATUSES : V1_STATUSES;

/** The members of a v2 error besides its details (Contracts 10.6). */
const V2_BASE_MEMBERS = [
  "@baseType",
  "@schemaLocation",
  "@type",
  "code",
  "message",
  "reason",
  "status",
];

const MERGE_PATCH = "application/merge-patch+json";

/** Attributes whose values are references (`{ "id": ... }` in v2). */
const REFERENCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "dockedTo",
  "owner",
  "parent",
]);

/** v2's system attributes, which a resource shows besides its values. */
const SYSTEM_ATTRIBUTES: ReadonlySet<string> = new Set([
  "@baseType",
  "@schemaLocation",
  "@type",
  "createdBy",
  "creationDate",
  "href",
  "id",
  "lastUpdate",
  "revision",
  "updatedBy",
]);

/** The members each error body may have besides `_tag`. */
const ERROR_MEMBERS = new Map<string, readonly string[]>([
  ["InvalidReference", ["field"]],
  ["InvalidRequest", ["message", "parameter"]],
  ["NotAllowed", []],
  ["NotFound", []],
  ["Referenced", []],
  ["UnknownField", ["field"]],
  ["UnknownTable", ["table"]],
  ["ValidationFailed", ["errors"]],
  ["VersionConflict", ["currentVersion"]],
  ["VersionRequired", []],
]);

/** The members each field error of `ValidationFailed` may have. */
const FIELD_ERROR_MEMBERS = new Map<string, readonly string[]>([
  ["DefinitionRetired", ["field"]],
  ["InvalidValue", ["field", "hint", "message", "reason"]],
  ["ReadOnlyField", ["field"]],
  ["Required", ["field"]],
]);

/** The fields a `notUnique` error may name. */
const UNIQUE_FIELDS = new Set(["code", "tag", "login"]);

const NOT_UNIQUE_MESSAGE = "Another record already has this value.";

/** Outcomes every fuzz run must reach, so the property is not vacuous. */
const REQUIRED_OUTCOMES = [
  "200",
  "201",
  "400 InvalidRequest",
  "400 UnknownField",
  "403 NotAllowed",
  "404 NotFound",
  "409 Referenced",
  "409 VersionConflict",
  "422 InvalidReference",
  "422 ValidationFailed",
  "428 VersionRequired",
  "500",
  "notUnique",
];

/**
 * An outcome as a version labels it: v2 answers a stale If-Match with 412.
 *
 * @param version - The API version.
 * @param outcome - A required outcome (v1 labels).
 * @returns The label in that version.
 */
const outcomeLabel = (version: ApiVersion, outcome: string): string =>
  version === "v2" && outcome === "409 VersionConflict"
    ? "412 VersionConflict"
    : outcome;

// Letters that are not hex digits, so a stored token never appears inside
// a UUID by chance.
const TOKEN_LETTERS = [
  "g",
  "h",
  "j",
  "k",
  "m",
  "n",
  "p",
  "q",
  "r",
  "s",
  "t",
  "v",
  "w",
  "x",
  "y",
  "z",
];

/** The tokens the model tracks as stored values. */
const TOKEN = /^(?:nm|nt|as|sn|kq|tg|fz)[g-z]{4,}$/u;

const LOWER_LETTER = /[a-z]/gu;

const isString = Schema.is(Schema.String);

/**
 * A distinctive token: a prefix and 6 non-hex letters.
 *
 * @param prefix - Two letters.
 * @returns The arbitrary.
 */
const tokenArb = (prefix: string): Arbitrary<string> =>
  array(constantFrom(...TOKEN_LETTERS), { maxLength: 6, minLength: 6 }).map(
    (letters) => `${prefix}${letters.join("")}`
  );

/**
 * A base value in random case, so unique values collide across case.
 *
 * @param bases - Lower-case values.
 * @returns The arbitrary.
 */
const casedArb = (bases: readonly string[]): Arbitrary<string> =>
  record({
    base: constantFrom(...bases),
    upper: array(boolean(), { maxLength: 8, minLength: 8 }),
  }).map(({ base, upper }) =>
    base.replaceAll(LOWER_LETTER, (letter, offset: number) =>
      upper[offset] === true ? letter.toUpperCase() : letter
    )
  );

const CODES = ["kqghmn", "kqrstv", "kqtwxy"];
const TAGS = ["tgmnpq", "tgpvwx"];
const LOGINS = ["fzlogn", "fzlogr"];

/** How a step refers to a record: through the model, or a made-up value. */
type RefChoice =
  | { readonly kind: "live"; readonly index: number }
  | { readonly kind: "deleted"; readonly index: number }
  | { readonly kind: "user"; readonly index: number }
  | { readonly kind: "asset"; readonly index: number }
  | { readonly kind: "random" }
  | { readonly kind: "malformed" }
  | { readonly kind: "number" };

/** A reference in a generated body, resolved against the model when sent. */
class RefValue {
  readonly choice: RefChoice;

  constructor(choice: RefChoice) {
    this.choice = choice;
  }
}

/** A generated field value. */
type ValueChoice = JsonValue | RefValue;

/** A live fuzz record, or an empty reference while there is none. */
const liveRefArb: Arbitrary<RefChoice> = record({
  index: nat(40),
  kind: constant("live" as const),
});

const refArb: Arbitrary<RefChoice> = oneof(
  liveRefArb,
  liveRefArb,
  record({ index: nat(40), kind: constant("deleted" as const) }),
  record({ index: nat(40), kind: constant("user" as const) }),
  record({ index: nat(40), kind: constant("asset" as const) }),
  record({ kind: constant("random" as const) }),
  record({ kind: constant("malformed" as const) }),
  record({ kind: constant("number" as const) })
);

const refValueArb: Arbitrary<ValueChoice> = refArb.map(
  (choice) => new RefValue(choice)
);

const nameArb: Arbitrary<JsonValue> = oneof(
  tokenArb("nm"),
  tokenArb("nm"),
  tokenArb("nm"),
  constant(null),
  constant("   "),
  constant("boom"),
  tokenArb("nmtoolong"),
  integer(),
  constant(["nm"])
);

const codeArb: Arbitrary<JsonValue> = oneof(
  casedArb(CODES),
  casedArb(CODES),
  constant(null),
  constant(""),
  constant(42),
  constant("x".repeat(300)),
  constant("bad\u0000code")
);

const qtyArb: Arbitrary<JsonValue> = oneof(
  integer({ max: 1000, min: 0 }),
  integer({ max: -1, min: -1000 }),
  constant(2 ** 40),
  constant(1.5),
  constant("7"),
  constant(null),
  constant(true)
);

const priceArb: Arbitrary<JsonValue> = oneof(
  constant("12.50"),
  constant("1.005"),
  constant("99999.99"),
  constant("-0"),
  constant(1.5),
  constant("abc"),
  constant(null)
);

const dayArb: Arbitrary<JsonValue> = oneof(
  constant("2026-01-15"),
  constant("2026-02-30"),
  constant("0000-01-01"),
  constant("15/01/2026"),
  constant(20_260_115),
  constant(null)
);

const noteArb: Arbitrary<JsonValue> = oneof(
  tokenArb("nt"),
  tokenArb("nt"),
  constant(null),
  constant(12)
);

const tagArb: Arbitrary<JsonValue> = oneof(
  casedArb(TAGS),
  constant(null),
  constant(false)
);

/** A body that saves unless a unique value is taken; keys left out are absent. */
const validBodyArb: Arbitrary<Readonly<Record<string, ValueChoice>>> = record(
  {
    code: tokenArb("kq"),
    day: constant("2026-01-15"),
    name: tokenArb("nm"),
    note: tokenArb("nt"),
    owner: record({ index: nat(40), kind: constant("user" as const) }).map(
      (choice) => new RefValue(choice)
    ),
    parent: liveRefArb.map((choice) => new RefValue(choice)),
    price: constant("12.50"),
    qty: integer({ max: 1000, min: 0 }),
  },
  { requiredKeys: ["name", "note"] }
);

/**
 * One bad (or merely different) value. `tag` is the child's own field
 * (unknown through the parent), `id` a system field, `nosuchfield` an
 * unknown one; the last three are refused only by the owner's constraints
 * and trigger.
 */
const mutationArb: Arbitrary<readonly [string, ValueChoice]> = oneof(
  codeArb.map((value) => ["code", value] as const),
  dayArb.map((value) => ["day", value] as const),
  nameArb.map((value) => ["name", value] as const),
  noteArb.map((value) => ["note", value] as const),
  refValueArb.map((value) => ["owner", value] as const),
  refValueArb.map((value) => ["parent", value] as const),
  priceArb.map((value) => ["price", value] as const),
  qtyArb.map((value) => ["qty", value] as const),
  tagArb.map((value) => ["tag", value] as const),
  tagArb.map((value) => ["tag", value] as const),
  constant(["id", "0192f000-0000-7000-8000-000000000000"] as const),
  constant(["nosuchfield", "x"] as const),
  constant(["note", null] as const),
  constant(["qty", -5] as const),
  constant(["name", "boom"] as const)
);

/** A mostly valid body with up to three mutations. */
const itemBodyArb: Arbitrary<Readonly<Record<string, ValueChoice>>> = record({
  mutations: array(mutationArb, { maxLength: 3 }),
  valid: validBodyArb,
}).map(({ mutations, valid }) => ({
  ...valid,
  ...Object.fromEntries(mutations),
}));

type VersionChoice = "current" | "stale" | "missing" | "malformed";

/** One generated step. */
type Step =
  | {
      readonly op: "create";
      readonly child: boolean;
      readonly body: Readonly<Record<string, ValueChoice>>;
    }
  | {
      readonly op: "update";
      readonly target: RefChoice;
      readonly viaParent: boolean;
      readonly version: VersionChoice;
      readonly body: Readonly<Record<string, ValueChoice>>;
    }
  | {
      readonly op: "delete";
      readonly target: RefChoice;
      readonly viaParent: boolean;
      readonly version: VersionChoice;
    }
  | {
      readonly op: "createUser";
      readonly login: JsonValue;
      readonly name: JsonValue;
      readonly password: boolean;
    }
  | {
      readonly op: "updateUser";
      readonly target: number;
      readonly login: JsonValue;
      readonly stale: boolean;
    }
  | { readonly op: "deleteUser"; readonly target: number }
  | {
      readonly op: "aliceCreate";
      readonly laptop: boolean;
      readonly name: JsonValue;
      readonly serial: JsonValue;
      readonly purchasedOn: JsonValue;
      readonly dockedTo: RefChoice;
    }
  | {
      readonly op: "aliceUpdate";
      readonly target: number;
      readonly viaParent: boolean;
      readonly stale: boolean;
      readonly name: JsonValue;
      readonly dockedTo: RefChoice;
      readonly purchasedOn: JsonValue;
    };

const versionArb: Arbitrary<VersionChoice> = constantFrom(
  "current",
  "current",
  "current",
  "stale",
  "missing",
  "malformed"
);

const loginArb: Arbitrary<JsonValue> = oneof(
  casedArb(LOGINS),
  casedArb(LOGINS),
  constant(null),
  constant("x".repeat(101)),
  constant(7)
);

const stepArb: Arbitrary<Step> = oneof(
  {
    arbitrary: record({
      body: itemBodyArb,
      child: boolean(),
      op: constant("create" as const),
    }),
    weight: 6,
  },
  {
    arbitrary: record({
      body: itemBodyArb,
      op: constant("update" as const),
      target: refArb,
      version: versionArb,
      viaParent: boolean(),
    }),
    weight: 4,
  },
  {
    arbitrary: record({
      op: constant("delete" as const),
      target: oneof(
        { arbitrary: liveRefArb, weight: 3 },
        { arbitrary: refArb, weight: 1 }
      ),
      version: versionArb,
      viaParent: boolean(),
    }),
    weight: 3,
  },
  {
    arbitrary: record({
      login: loginArb,
      name: nameArb,
      op: constant("createUser" as const),
      password: oneof(constant(false), constant(false), constant(true)),
    }),
    weight: 1,
  },
  {
    arbitrary: record({
      login: loginArb,
      op: constant("updateUser" as const),
      stale: boolean(),
      target: nat(10),
    }),
    weight: 1,
  },
  {
    arbitrary: record({
      op: constant("deleteUser" as const),
      target: nat(10),
    }),
    weight: 1,
  },
  {
    arbitrary: record({
      dockedTo: refArb,
      laptop: boolean(),
      name: oneof(tokenArb("as"), constant(null), constant("y".repeat(200))),
      op: constant("aliceCreate" as const),
      purchasedOn: dayArb,
      serial: oneof(tokenArb("sn"), constant(null), constant("z".repeat(70))),
    }),
    weight: 1,
  },
  {
    arbitrary: record({
      dockedTo: refArb,
      name: oneof(tokenArb("as"), constant(null), constant(3)),
      op: constant("aliceUpdate" as const),
      purchasedOn: dayArb,
      stale: boolean(),
      target: nat(10),
      viaParent: boolean(),
    }),
    weight: 1,
  }
);

/** What a tracked record is: a fuzz record, a user or an acme asset. */
type TrackedKind = "item" | "special" | "user" | "asset";

/** A record the run knows about. */
interface Tracked {
  readonly id: string;
  readonly kind: TrackedKind;
  /** The endpoint of its concrete class. */
  readonly concrete: string;
  version: number;
  deleted: boolean;
  /** Stored tokens this record holds, in lower case. */
  readonly secrets: Set<string>;
}

/** Every record created so far, who acts, and what was seen. */
interface Model {
  readonly records: Tracked[];
  /** IDs any response may show: the users acting in the test. */
  readonly actors: ReadonlySet<string>;
  /** How often each outcome (`<status> <tag>`, `notUnique`) was seen. */
  readonly outcomes: Map<string, number>;
}

const pick = <A>(items: readonly A[], index: number): A | undefined =>
  items.length === 0 ? undefined : items[index % items.length];

const itemsOf = (model: Model, deleted: boolean) =>
  model.records.filter(
    (tracked) =>
      (tracked.kind === "item" || tracked.kind === "special") &&
      tracked.deleted === deleted
  );

const ofKind = (model: Model, kind: TrackedKind) =>
  model.records.filter((tracked) => tracked.kind === kind);

/** A resolved reference: the value to send and the record it names. */
interface Resolved {
  readonly value: JsonValue;
  readonly tracked?: Tracked;
}

const byIndex = (candidates: readonly Tracked[], index: number): Resolved => {
  const tracked = pick(candidates, index);

  // With nothing to pick, an empty reference.
  return tracked === undefined
    ? { value: null }
    : { tracked, value: tracked.id };
};

const resolveRef = (model: Model, choice: RefChoice): Resolved => {
  switch (choice.kind) {
    case "live": {
      return byIndex(itemsOf(model, false), choice.index);
    }

    case "deleted": {
      return byIndex(itemsOf(model, true), choice.index);
    }

    case "user": {
      return byIndex(ofKind(model, "user"), choice.index);
    }

    case "asset": {
      return byIndex(ofKind(model, "asset"), choice.index);
    }

    case "random": {
      return { value: randomUUID() };
    }

    case "malformed": {
      return { value: "not-a-uuid" };
    }

    case "number": {
      return { value: 12_345 };
    }

    default: {
      return choice satisfies never;
    }
  }
};

const bodyOf = (
  model: Model,
  generated: Readonly<Record<string, ValueChoice>>
): JsonObject =>
  Object.fromEntries(
    Object.entries(generated).map(([key, value]) => [
      key,
      value instanceof RefValue ? resolveRef(model, value.choice).value : value,
    ])
  );

const versionHeader = (tracked: Tracked | null, version: VersionChoice) => {
  const current = tracked?.version ?? 1;

  switch (version) {
    case "missing": {
      return {};
    }

    case "malformed": {
      return { "if-match": "W/1" };
    }

    case "stale": {
      return { "if-match": `"${current + 1}"` };
    }

    case "current": {
      return { "if-match": `"${current}"` };
    }

    default: {
      return version satisfies never;
    }
  }
};

/** A field error as a response body lists it. */
const FieldErrorBodySchema = Schema.Struct({
  _tag: Schema.String,
  field: Schema.String,
  message: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});

/** What the checks read from a response body. */
const ResponseBodySchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(FieldErrorBodySchema)),
  record: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
      version: Schema.Int,
    })
  ),
});

type ResponseBody = typeof ResponseBodySchema.Type;

const decodeBody = Schema.decodeUnknownOption(ResponseBodySchema);

/** Members with a value, as an object.
 * @param entries - Name and value pairs.
 * @returns The object. */
const presentMembers = (
  entries: readonly (readonly [string, JsonValue | undefined])[]
): JsonObject =>
  Object.fromEntries(
    entries.filter(
      (entry): entry is readonly [string, JsonValue] => entry[1] !== undefined
    )
  );

/**
 * A v2 body in the v1 shape the checks read: a TMF `Error` becomes
 * `{ _tag, errors }`, a resource `{ record: { id, values, version } }`.
 * A v1 body is returned as is.
 *
 * @param json - A response's JSON.
 * @returns The body in v1 terms.
 */
const normalizedOf = (json: JsonValue | undefined): JsonValue | undefined => {
  if (json === undefined || !isJsonObject(json)) {
    return json;
  }

  if (json["@baseType"] === "Error") {
    const { code, fieldErrors } = json;

    return presentMembers([
      ["_tag", isString(code) ? code : undefined],
      ["errors", Array.isArray(fieldErrors) ? fieldErrors : undefined],
    ]);
  }

  const { id, revision } = json;

  if (isString(id) && revision !== undefined && isJsonNumber(revision)) {
    return {
      record: {
        id,
        values: presentMembers(
          Object.keys(json)
            .filter((key) => !SYSTEM_ATTRIBUTES.has(key))
            .map((key) => [key, json[key]] as const)
        ),
        version: revision,
      },
    };
  }

  return json;
};

/**
 * The parts of a response body the checks read.
 *
 * @param response - A response.
 * @returns The decoded body; no members when it does not decode.
 */
const parsedOf = (response: TestResponse): ResponseBody =>
  Option.getOrElse(decodeBody(normalizedOf(response.json)), () => ({}));

/** What the checks need to know about one request. */
interface Sent {
  readonly path: string;
  readonly body: JsonValue | undefined;
  /** The record the request targets, if the model knows it. */
  readonly target: Tracked | null;
  /** The API version (default `v1`). */
  readonly version?: ApiVersion;
}

const textsOf = (value: JsonValue | undefined): string[] => {
  if (value === undefined) {
    return [];
  }

  if (isString(value)) {
    return [value.toLowerCase()];
  }

  if (Array.isArray(value)) {
    return value.flatMap(textsOf);
  }

  if (isJsonObject(value)) {
    return Object.values(value).flatMap(textsOf);
  }

  return [];
};

const secretsOf = (body: JsonObject): Set<string> =>
  new Set(textsOf(body).filter((value) => TOKEN.test(value)));

/**
 * The outcomes of a response, for the coverage check.
 *
 * @param response - A response.
 * @returns `<status> <tag>` and, for a unique conflict, `notUnique`.
 */
const outcomesOf = (response: TestResponse): readonly string[] => {
  const body = parsedOf(response);

  const notUnique = (body.errors ?? []).some(
    (error) => error.reason === "notUnique"
  );

  return [
    `${response.status} ${body._tag ?? ""}`.trim(),
    ...(notUnique ? ["notUnique"] : []),
  ];
};

/**
 * Checks that a JSON object has only the allowed members.
 *
 * @param value - The object (anything else fails).
 * @param tag - Its `_tag`.
 * @param allowed - The members besides `_tag`.
 * @param base - The members every such object may have.
 */
const assertMembers = (
  value: JsonValue | undefined,
  tag: string,
  allowed: readonly string[] | undefined,
  base: readonly string[] = ["_tag"]
): void => {
  assert.isDefined(allowed, `undocumented ${tag}`);
  const object = value !== undefined && isJsonObject(value) ? value : undefined;

  assert.isDefined(object, `${tag} is not an object`);

  for (const key of Object.keys(object ?? {})) {
    assert.include([...base, ...(allowed ?? [])], key, `${tag}.${key}`);
  }
};

/**
 * Checks an error body: documented members only, `notUnique` only on
 * unique fields with the fixed message, `Referenced` with nothing else.
 *
 * @param response - A response.
 */
const checkErrorMembers = (response: TestResponse): void => {
  const body = parsedOf(response);
  const tag = body._tag;

  if (tag === undefined) {
    return;
  }

  const json = response.json ?? null;
  const isV2 = isJsonObject(json) && json["@baseType"] === "Error";

  if (isV2) {
    // v2: the TMF members, and `fieldErrors` for `ValidationFailed`.
    assertMembers(
      response.json,
      tag,
      tag === "ValidationFailed" ? ["fieldErrors"] : ERROR_MEMBERS.get(tag),
      V2_BASE_MEMBERS
    );
  } else {
    assertMembers(response.json, tag, ERROR_MEMBERS.get(tag));
  }

  const errorsMember = isV2 ? "fieldErrors" : "errors";
  const raw = isJsonObject(json) ? json[errorsMember] : undefined;

  const rawErrors: readonly JsonValue[] = Array.isArray(raw) ? raw : [];

  for (const [index, error] of (body.errors ?? []).entries()) {
    assertMembers(
      rawErrors[index],
      error._tag,
      FIELD_ERROR_MEMBERS.get(error._tag)
    );

    if (error.reason === "notUnique") {
      assert.isTrue(UNIQUE_FIELDS.has(error.field), `notUnique ${error.field}`);
      assert.strictEqual(error.message, NOT_UNIQUE_MESSAGE);
    }
  }

  if (tag === "Referenced" && !isV2) {
    assert.strictEqual(response.text, '{"_tag":"Referenced"}');
  }
};

/**
 * Checks one response against everything Contracts 3.8 forbids.
 *
 * @param model - Every record so far.
 * @param sent - The request.
 * @param response - Its response.
 */
const checkResponse = (
  model: Model,
  sent: Sent,
  response: TestResponse
): void => {
  const where = `${sent.path} ${JSON.stringify(sent.body ?? null)} -> ${response.status} ${response.text}`;
  const text = response.text.toLowerCase();

  assert.isTrue(
    statusesOf(sent.version ?? "v1").has(response.status),
    `status: ${where}`
  );

  if (response.status === 500) {
    assert.strictEqual(response.text, "", `a 500 with a body: ${where}`);
  }

  for (const phrase of FORBIDDEN) {
    assert.notInclude(text, phrase, `Postgres text: ${where}`);
  }

  const requestText =
    `${sent.path} ${JSON.stringify(sent.body ?? null)}`.toLowerCase();

  const saved = parsedOf(response).record;
  const succeeded = response.status < 400;

  // Values a response may repeat: what the request sent and, on success
  // only, the saved record's own projection. A refusal shows no stored
  // value, not even the target record's.
  const allowed = new Set([
    ...textsOf(sent.body),
    ...(succeeded ? textsOf(saved?.values) : []),
  ]);

  // IDs a response may show: the actors, what the request named, and the
  // saved record with its own references.
  const shown = new Set([
    ...model.actors,
    ...(saved === undefined ? [] : [saved.id]),
    ...textsOf(saved?.values),
  ]);

  for (const tracked of model.records) {
    if (!(shown.has(tracked.id) || requestText.includes(tracked.id))) {
      assert.notInclude(text, tracked.id, `foreign ID: ${where}`);
    }

    for (const secret of tracked.secrets) {
      if (!(allowed.has(secret) || requestText.includes(secret))) {
        assert.notInclude(text, secret, `stored value: ${where}`);
      }
    }
  }

  checkErrorMembers(response);
};

/** Everything a step needs to send requests. */
interface FuzzContext {
  readonly http: TestHttpClientApi;
  readonly admin: string;
  readonly alice: string;
  readonly model: Model;
  readonly version: ApiVersion;
}

/** One request of a step. */
interface StepRequest {
  readonly method: string;
  readonly path: string;
  readonly token: string;
  readonly body?: JsonObject;
  readonly headers?: Readonly<Record<string, string>>;
  readonly target: Tracked | null;
}

const optionsOf = (request: StepRequest): TestRequestOptions =>
  request.body === undefined
    ? { headers: request.headers ?? {}, token: request.token }
    : {
        body: request.body,
        headers: request.headers ?? {},
        token: request.token,
      };

const V1_RECORD_PATH =
  /^\/api\/v1\/tables\/(?<namespace>[a-z_]+)\.(?<table>[a-z_]+)\/records(?:\/(?<id>.*))?$/u;

const WORD_BREAK = /_(?<letter>[a-z])/gu;

/**
 * An underscore name in lowerCamelCase.
 *
 * @param name - `purchased_on`.
 * @returns `purchasedOn`.
 */
const camelOf = (name: string): string =>
  name.replaceAll(WORD_BREAK, (_match, letter: string) => letter.toUpperCase());

/**
 * A v1 path in v2 terms: `/api/v1/tables/site.fuzz_item/records/<id>`
 * becomes `/api/v2/siteFuzzItem/<id>`.
 *
 * @param path - A v1 record or list path.
 * @returns The v2 path.
 */
const v2PathOf = (path: string): string => {
  const { id, namespace, table } = V1_RECORD_PATH.exec(path)?.groups ?? {};

  if (namespace === undefined || table === undefined) {
    throw new Error(`not a v1 record path: ${path}`);
  }

  const collection = camelOf(`${namespace}_${table}`);

  return id === undefined
    ? `/api/v2/${collection}`
    : `/api/v2/${collection}/${id}`;
};

/**
 * A v1 body in v2 terms: camelCase attributes and references as
 * `{ "id": ... }` (other values, such as a number, stay as they are).
 *
 * @param body - A v1 body.
 * @returns The v2 body.
 */
const v2BodyOf = (body: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(body).map(([key, value]): [string, JsonValue] => {
      const name = camelOf(key);

      return [
        name,
        REFERENCE_ATTRIBUTES.has(name) && isString(value)
          ? { id: value }
          : value,
      ];
    })
  );

const v2OptionsOf = (request: StepRequest): TestRequestOptions => {
  const patch = request.method === "PATCH";

  const headers = patch
    ? { ...request.headers, "content-type": MERGE_PATCH }
    : { ...request.headers };

  if (request.body === undefined) {
    return { headers, token: request.token };
  }

  const body = v2BodyOf(request.body);

  return patch
    ? { headers, rawBody: JSON.stringify(body), token: request.token }
    : { body, headers, token: request.token };
};

const send = Effect.fn("ErrorFuzz.send")(function* send(
  context: FuzzContext,
  request: StepRequest
) {
  const { version } = context;

  const path = version === "v2" ? v2PathOf(request.path) : request.path;

  const response = yield* context.http.request(
    request.method,
    path,
    version === "v2" ? v2OptionsOf(request) : optionsOf(request)
  );

  checkResponse(
    context.model,
    { body: request.body, path, target: request.target, version },
    response
  );

  for (const outcome of outcomesOf(response)) {
    context.model.outcomes.set(
      outcome,
      (context.model.outcomes.get(outcome) ?? 0) + 1
    );
  }

  return response;
});

const track = (
  model: Model,
  response: TestResponse,
  added: { readonly kind: TrackedKind; readonly concrete: string },
  body: JsonObject
): void => {
  const saved = parsedOf(response).record;

  if (response.status === 201 && saved !== undefined) {
    model.records.push({
      concrete: added.concrete,
      deleted: false,
      id: saved.id,
      kind: added.kind,
      secrets: secretsOf(body),
      version: saved.version,
    });
  }
};

const noteUpdate = (
  target: Tracked | null,
  response: TestResponse,
  body: JsonObject
): void => {
  const saved = parsedOf(response).record;

  if (target !== null && response.status === 200 && saved !== undefined) {
    target.version = saved.version;

    for (const secret of secretsOf(body)) {
      target.secrets.add(secret);
    }
  }
};

type ItemStep = Extract<Step, { readonly op: "create" | "update" | "delete" }>;

const runItemStep = Effect.fn("ErrorFuzz.itemStep")(function* runItemStep(
  context: FuzzContext,
  step: ItemStep
) {
  const { model } = context;

  if (step.op === "create") {
    const table = step.child ? SPECIAL : ITEM;
    const body = bodyOf(model, step.body);

    const response = yield* send(context, {
      body,
      method: "POST",
      path: listPath(table),
      target: null,
      token: context.admin,
    });

    track(
      model,
      response,
      { concrete: table, kind: step.child ? "special" : "item" },
      body
    );

    return;
  }

  const resolved = resolveRef(model, step.target);
  const target = resolved.tracked ?? null;
  const id = isString(resolved.value) ? resolved.value : "12345";
  const table = step.viaParent || target?.kind !== "special" ? ITEM : SPECIAL;

  if (step.op === "update") {
    const body = bodyOf(model, step.body);

    const response = yield* send(context, {
      body,
      headers: versionHeader(target, step.version),
      method: "PATCH",
      path: recordPath(table, id),
      target,
      token: context.admin,
    });

    noteUpdate(target, response, body);

    return;
  }

  const response = yield* send(context, {
    headers: versionHeader(target, step.version),
    method: "DELETE",
    path: recordPath(table, id),
    target,
    token: context.admin,
  });

  // v1 answers a delete with the record (200), v2 with 204.
  if (response.status < 300 && target !== null) {
    target.deleted = true;
  }
});

type UserStep = Extract<
  Step,
  { readonly op: "createUser" | "updateUser" | "deleteUser" }
>;

const runUserStep = Effect.fn("ErrorFuzz.userStep")(function* runUserStep(
  context: FuzzContext,
  step: UserStep
) {
  const { model } = context;

  if (step.op === "createUser") {
    const body: JsonObject = Object.fromEntries([
      ["active", true],
      ["login", step.login],
      ["name", step.name],
      ...(step.password ? [["password", "fuzz-password"] as const] : []),
    ]);

    const response = yield* send(context, {
      body,
      method: "POST",
      path: listPath(USER),
      target: null,
      token: context.admin,
    });

    track(model, response, { concrete: USER, kind: "user" }, body);

    return;
  }

  const target = pick(ofKind(model, "user"), step.target);

  if (target === undefined) {
    return;
  }

  if (step.op === "updateUser") {
    const body: JsonObject = { login: step.login };

    const response = yield* send(context, {
      body,
      headers: versionHeader(target, step.stale ? "stale" : "current"),
      method: "PATCH",
      path: recordPath(USER, target.id),
      target,
      token: context.admin,
    });

    noteUpdate(target, response, body);

    return;
  }

  const response = yield* send(context, {
    headers: versionHeader(target, "current"),
    method: "DELETE",
    path: recordPath(USER, target.id),
    target,
    token: context.admin,
  });

  // Users are deactivated, never deleted: the built-in deny (3.2, 3.10).
  assert.strictEqual(response.status, 403, response.text);
});

type AliceCreate = Extract<Step, { readonly op: "aliceCreate" }>;

type AliceUpdate = Extract<Step, { readonly op: "aliceUpdate" }>;

const runAliceCreate = Effect.fn("ErrorFuzz.aliceCreate")(
  function* runAliceCreate(context: FuzzContext, step: AliceCreate) {
    const { model } = context;
    const table = step.laptop ? LAPTOP : ASSET;

    const body: JsonObject = Object.fromEntries([
      ["docked_to", resolveRef(model, step.dockedTo).value],
      ["name", step.name],
      ["purchased_on", step.purchasedOn],
      ...(step.laptop ? [["serial", step.serial] as const] : []),
    ]);

    const response = yield* send(context, {
      body,
      method: "POST",
      path: listPath(table),
      target: null,
      token: context.alice,
    });

    track(model, response, { concrete: table, kind: "asset" }, body);
  }
);

const runAliceUpdate = Effect.fn("ErrorFuzz.aliceUpdate")(
  function* runAliceUpdate(context: FuzzContext, step: AliceUpdate) {
    const { model } = context;
    const target = pick(ofKind(model, "asset"), step.target);

    if (target === undefined) {
      return;
    }

    const body: JsonObject = {
      docked_to: resolveRef(model, step.dockedTo).value,
      name: step.name,
      purchased_on: step.purchasedOn,
    };

    const response = yield* send(context, {
      body,
      headers: versionHeader(target, step.stale ? "stale" : "current"),
      method: "PATCH",
      path: recordPath(step.viaParent ? ASSET : target.concrete, target.id),
      target,
      token: context.alice,
    });

    noteUpdate(target, response, body);
  }
);

const runStep = (context: FuzzContext, step: Step) => {
  switch (step.op) {
    case "create":
    case "update":
    case "delete": {
      return runItemStep(context, step);
    }

    case "createUser":
    case "updateUser":
    case "deleteUser": {
      return runUserStep(context, step);
    }

    case "aliceCreate": {
      return runAliceCreate(context, step);
    }

    case "aliceUpdate": {
      return runAliceUpdate(context, step);
    }

    default: {
      return step satisfies never;
    }
  }
};

const runSequence = Effect.fn("ErrorFuzz.sequence")(function* runSequence(
  context: FuzzContext,
  steps: readonly Step[]
) {
  for (const step of steps) {
    yield* runStep(context, step);
  }

  return true;
});

/** Creates the fuzz hierarchy through one change set. */
const createFuzzTables = Effect.gen(function* createFuzzTables() {
  // A local namespace: app namespaces are reserved for their sets (1.8).
  yield* ensureSite;

  const item = createClass("fuzz_item", { namespaceId: SITE_NAMESPACE_ID });

  const special = createClass("fuzz_special", {
    namespaceId: SITE_NAMESPACE_ID,
    parentId: item.id,
  });

  const code = addField(item.id, "code", { kind: "text", maxLength: 20 });

  const name = addField(
    item.id,
    "name",
    { kind: "text", maxLength: NAME_MAX_LENGTH },
    { required: true }
  );

  const tag = addField(special.id, "tag", { kind: "text", maxLength: 12 });

  const plainFields = [
    addField(item.id, "qty", { kind: "integer" }),
    addField(item.id, "price", { kind: "decimal", precision: 6, scale: 2 }),
    addField(item.id, "day", { kind: "date" }),
    addField(item.id, "note", { kind: "text" }),
    addField(item.id, "parent", {
      kind: "reference",
      targetClassId: item.id,
    }),
    addField(item.id, "owner", {
      kind: "reference",
      targetClassId: USER_CLASS_ID,
    }),
  ];

  yield* change([
    item.op,
    special.op,
    code.op,
    name.op,
    tag.op,
    ...plainFields.map((field) => field.op),
    addIndex(item.id, [code.id], true).op,
    addIndex(special.id, [tag.id], true).op,
  ]);
});

/**
 * What the record service does not know about, added as table owner: a
 * CHECK constraint, a NOT NULL on an optional column and a trigger whose
 * error repeats stored values in its message, detail and hint.
 */
const addOwnerConstraints = Effect.gen(function* addOwnerConstraints() {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(
    `ALTER TABLE site.fuzz_item ADD CONSTRAINT xq_qty_nonneg CHECK (qty >= 0)`
  );
  yield* sql.unsafe(
    `ALTER TABLE site.fuzz_item ALTER COLUMN note SET NOT NULL`
  );
  yield* sql.unsafe(
    `CREATE FUNCTION acme.xq_boom() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name = 'boom' THEN
    RAISE EXCEPTION 'boom % ${TRIGGER_SECRET}', NEW.code
      USING DETAIL = 'detail ' || coalesce(NEW.code, '') || ' ${TRIGGER_SECRET}',
            HINT = '${TRIGGER_SECRET}';
  END IF;
  RETURN NEW;
END $$`
  );
  yield* sql.unsafe(
    `CREATE TRIGGER xq_boom_trigger BEFORE INSERT OR UPDATE ON site.fuzz_item
       FOR EACH ROW EXECUTE FUNCTION acme.xq_boom()`
  );
});

const ADMIN_LOGIN = "fuzz-admin";

// oxlint-disable-next-line sonarjs/no-hardcoded-passwords -- a test user's password
const ADMIN_PASSWORD = "fuzz-admin-password";

/** Creates the tables, the owner's constraints and an admin. */
const prepare = Effect.gen(function* prepare() {
  const { request } = yield* Transactions;
  const catalog = yield* Catalog;

  yield* createFuzzTables;
  yield* addOwnerConstraints;

  yield* request(
    Effect.gen(function* createAdmin() {
      return yield* createFixtureUser(yield* catalog.current, {
        active: true,
        login: ADMIN_LOGIN,
        name: "Fuzz Admin",
        password: ADMIN_PASSWORD,
        roles: ["admin"],
      });
    })
  ).pipe(Effect.orDie);
});

/**
 * Signs in the admin and Alice; the model starts with the acme records.
 *
 * @param version - The API version the context sends to.
 * @returns The context.
 */
const setUpFor = Effect.fn("ErrorFuzz.setUp")(function* setUpFor(
  version: ApiVersion
) {
  const fixture = yield* AcmeFixture;
  const http = yield* TestHttpClient;
  const sql = yield* SqlClient.SqlClient;
  const admin = yield* http.signIn(ADMIN_LOGIN, ADMIN_PASSWORD);
  const alice = yield* http.signIn("alice", "alice-password");

  const adminIds = (yield* sql.unsafe<{ readonly id: string }>(
    `SELECT id::text AS id FROM core."user" WHERE login = $1`,
    [ADMIN_LOGIN]
  )).map((row) => row.id);

  const acmeRecords = Object.values(fixture.records).map((id): Tracked => ({
    concrete: ASSET,
    deleted: false,
    id,
    kind: "asset",
    secrets: new Set(),
    version: 1,
  }));

  const model: Model = {
    actors: new Set([fixture.alice.id, fixture.bob.id, ...adminIds]),
    outcomes: new Map(),
    records: acmeRecords,
  };

  return { admin, alice, http, model, version } satisfies FuzzContext;
});

const RUNS = 50;
const MIN_STEPS = 5;
const MAX_STEPS = 20;
const TIMEOUT = 300_000;

type Services =
  | TestHttpClient
  | AcmeFixture
  | Transactions
  | Catalog
  | SqlClient.SqlClient
  | Scope.Scope;

/**
 * Runs the property: random step sequences, every response checked.
 *
 * @param context - The sessions and the model.
 * @param run - Runs an effect with the test's services.
 * @returns fast-check's result.
 */
const checkSequences = async (
  context: FuzzContext,
  run: (effect: Effect.Effect<boolean, unknown, Services>) => Promise<boolean>
) =>
  await check(
    asyncProperty(
      array(stepArb, { maxLength: MAX_STEPS, minLength: MIN_STEPS }),
      async (steps) => await run(runSequence(context, steps))
    ),
    { endOnFailure: true, numRuns: RUNS }
  );

/** A constraint the matrix provokes, by name. */
type Constraint =
  | "unique"
  | "uniqueChild"
  | "required"
  | "type"
  | "length"
  | "ownerCheck"
  | "ownerNotNull"
  | "reference"
  | "referenceBackstop"
  | "referenced";

/** One cell of the matrix: a constraint, an operation, an endpoint. */
interface Cell {
  readonly constraint: Constraint;
  readonly op: "create" | "update" | "delete";
  readonly endpoint: typeof ITEM | typeof SPECIAL;
}

/** What each constraint must give, whatever the operation and endpoint. */
const INTENDED: Readonly<Record<Constraint, string>> = {
  length: "422 ValidationFailed InvalidValue:name:tooLong",
  ownerCheck: "500",
  ownerNotNull: "500",
  reference: "422 InvalidReference parent",
  referenceBackstop: "422 InvalidReference parent",
  referenced: "409 Referenced",
  required: "422 ValidationFailed Required:name",
  type: "422 ValidationFailed InvalidValue:qty:wrongJsonType",
  unique: "422 ValidationFailed InvalidValue:code:notUnique",
  uniqueChild: "422 ValidationFailed InvalidValue:tag:notUnique",
};

const ENDPOINTS = [ITEM, SPECIAL] as const;

const WRITE_CONSTRAINTS: readonly Constraint[] = [
  "unique",
  "required",
  "type",
  "length",
  "ownerCheck",
  "ownerNotNull",
  "reference",
  "referenceBackstop",
];

/** Every cell that applies: writes on both endpoints, the child's own
 * unique field on its endpoint (the parent cannot name it), deletes of a
 * referenced record on both. */
const MATRIX: readonly Cell[] = [
  ...ENDPOINTS.flatMap((endpoint) =>
    (["create", "update"] as const).flatMap((op) =>
      WRITE_CONSTRAINTS.map((constraint) => ({ constraint, endpoint, op }))
    )
  ),
  { constraint: "uniqueChild", endpoint: SPECIAL, op: "create" },
  { constraint: "uniqueChild", endpoint: SPECIAL, op: "update" },
  ...ENDPOINTS.map((endpoint): Cell => ({
    constraint: "referenced",
    endpoint,
    op: "delete",
  })),
];

const cellKey = (cell: Cell): string =>
  `${cell.constraint} ${cell.op} ${cell.endpoint}`;

/**
 * A response as the matrix compares it: status, tag and, for field
 * errors, `<error>:<field>[:<reason>]`; for `InvalidReference` the field.
 *
 * @param response - A response.
 * @returns The outcome text.
 */
const outcomeText = (response: TestResponse): string => {
  const body = parsedOf(response);

  const details =
    body._tag === "ValidationFailed"
      ? (body.errors ?? []).map((error) =>
          [error._tag, error.field, error.reason]
            .filter((part) => part !== undefined)
            .join(":")
        )
      : [];

  const json = response.json ?? null;
  const reference = isJsonObject(json) ? json.field : undefined;
  const field = body._tag === "InvalidReference" ? textsOf(reference) : [];

  return [String(response.status), body._tag, ...details, ...field]
    .filter((part) => part !== undefined)
    .join(" ");
};

let tokenCount = 0;

/**
 * A fresh stored token: a prefix and letters that are not hex digits.
 *
 * @param prefix - Two letters naming the field.
 * @returns The token.
 */
const freshToken = (prefix: string): string => {
  tokenCount += 1;

  const letters = String(tokenCount)
    .padStart(6, "0")
    .split("")
    .map((digit) => TOKEN_LETTERS[Number(digit)] ?? "z");

  return `${prefix}${letters.join("")}`;
};

/**
 * A valid body for an endpoint, with fresh stored tokens.
 *
 * @param endpoint - The endpoint (and class).
 * @returns The values.
 */
const validBody = (endpoint: Cell["endpoint"]): JsonObject => {
  const body = {
    code: freshToken("kq"),
    name: freshToken("nm").slice(0, NAME_MAX_LENGTH),
    note: freshToken("nt"),
    qty: 1,
  } satisfies JsonObject;

  return endpoint === SPECIAL ? { ...body, tag: freshToken("tg") } : body;
};

/**
 * Creates a valid record through an endpoint, tracked in the model.
 *
 * @param context - Sessions and model.
 * @param endpoint - The endpoint (and class).
 * @param extra - More values.
 * @returns The record's ID and body.
 */
const freshRecord = Effect.fn("ErrorMatrix.freshRecord")(function* freshRecord(
  context: FuzzContext,
  endpoint: Cell["endpoint"],
  extra: JsonObject = {}
) {
  const body = { ...validBody(endpoint), ...extra };

  const response = yield* send(context, {
    body,
    method: "POST",
    path: listPath(endpoint),
    target: null,
    token: context.admin,
  });

  assert.strictEqual(response.status, 201, response.text);

  track(
    context.model,
    response,
    { concrete: endpoint, kind: endpoint === ITEM ? "item" : "special" },
    body
  );

  return { body, id: parsedOf(response).record?.id ?? "" };
});

/** Some backend of this database waits for a lock. */
const someoneWaitsOnALock = Effect.gen(function* someoneWaits() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql.unsafe<{ readonly waiting: string }>(
    `SELECT count(*)::text AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
  );

  return Number(rows[0]?.waiting ?? "0") > 0;
});

/**
 * A unique value another fresh record already holds, in upper case.
 *
 * @param context - Sessions and model.
 * @param endpoint - Where the other record is created.
 * @param field - The unique field.
 * @returns The values.
 */
const takenValue = (
  context: FuzzContext,
  endpoint: Cell["endpoint"],
  field: "code" | "tag"
) =>
  freshRecord(context, endpoint).pipe(
    Effect.map((other): JsonObject => ({
      [field]: textsOf(other.body[field]).join("").toUpperCase(),
    }))
  );

/**
 * The values a write sends to provoke each constraint (the reference
 * backstop's target is set up by `takeCell`).
 *
 * @param context - Sessions and model.
 * @returns Per constraint, the values.
 */
const provoking = (
  context: FuzzContext
): Readonly<
  Record<Constraint, Effect.Effect<JsonObject, unknown, Services>>
> => ({
  length: Effect.sync(() => ({
    name: freshToken("nm").padEnd(NAME_MAX_LENGTH + 1, "x"),
  })),
  ownerCheck: Effect.succeed({ qty: -1 }),
  ownerNotNull: Effect.succeed({ note: null }),
  reference: Effect.sync(() => ({ parent: randomUUID() })),
  referenceBackstop: Effect.sync(() => ({ parent: randomUUID() })),
  referenced: Effect.succeed({}),
  required: Effect.succeed({ name: null }),
  type: Effect.succeed({ qty: "many" }),
  unique: takenValue(context, ITEM, "code"),
  uniqueChild: takenValue(context, SPECIAL, "tag"),
});

/**
 * Takes one cell: provokes its constraint through its endpoint and
 * operation, checks the response like every fuzz response, and returns
 * the outcome.
 *
 * @param context - Sessions and model.
 * @param cell - The cell.
 * @returns The outcome text.
 */
/**
 * The outcome of a write, with the delivery rows it left: none for a
 * refusal (Contracts 4.6: deliveries are written in the save transaction).
 *
 * @param sending - The write.
 * @returns The outcome text, plus `+<n> deliveries` when any were left.
 */
const withDeliveries = Effect.fn("ErrorMatrix.withDeliveries")(
  function* withDeliveries(
    sending: Effect.Effect<TestResponse, unknown, Services>
  ) {
    const before = yield* deliveryCount;
    const text = outcomeText(yield* sending);
    const left = (yield* deliveryCount) - before;

    return left === 0 ? text : `${text} +${left} deliveries`;
  }
);

/** Whether a matrix has subscribed to the fuzz class yet. */
const matrixState = { subscribed: false };

const takeCell = Effect.fn("ErrorMatrix.cell")(function* takeCell(
  context: FuzzContext,
  cell: Cell
) {
  const { request } = yield* Transactions;

  if (cell.op === "delete") {
    const target = yield* freshRecord(context, cell.endpoint);

    yield* freshRecord(context, ITEM, { parent: target.id });

    return yield* withDeliveries(
      send(context, {
        headers: { "if-match": '"1"' },
        method: "DELETE",
        path: recordPath(cell.endpoint, target.id),
        target: null,
        token: context.admin,
      })
    );
  }

  const subject =
    cell.op === "update" ? yield* freshRecord(context, cell.endpoint) : null;

  const write = (values: JsonObject) => {
    const body =
      subject === null ? { ...validBody(cell.endpoint), ...values } : values;

    return send(context, {
      body,
      headers: subject === null ? {} : { "if-match": '"1"' },
      method: subject === null ? "POST" : "PATCH",
      path:
        subject === null
          ? listPath(cell.endpoint)
          : recordPath(cell.endpoint, subject.id),
      target: null,
      token: context.admin,
    });
  };

  if (cell.constraint !== "referenceBackstop") {
    const values = yield* provoking(context)[cell.constraint];

    return yield* withDeliveries(write(values));
  }

  // The FK backstop: the reference target is visible when the record
  // service checks it, and gone when Postgres checks the FK. Another
  // transaction deletes it and holds the delete open until this write
  // waits on its row lock (observed in pg_stat_activity), then commits.
  const target = yield* freshRecord(context, ITEM);
  const deleted = yield* Deferred.make<boolean>();
  const release = yield* Deferred.make<boolean>();

  const deleter = yield* request(
    Effect.gen(function* deleteTarget() {
      const sql = yield* SqlClient.SqlClient;

      yield* sql.unsafe(`DELETE FROM site.fuzz_item WHERE id = $1::uuid`, [
        target.id,
      ]);
      yield* Deferred.succeed(deleted, true);
      yield* Deferred.await(release);
    })
  ).pipe(Effect.forkChild);

  yield* Deferred.await(deleted);

  const writing = yield* withDeliveries(write({ parent: target.id })).pipe(
    Effect.forkChild
  );

  yield* waitUntil(someoneWaitsOnALock);
  yield* Deferred.succeed(release, true);
  yield* Fiber.join(deleter);

  return yield* Fiber.join(writing);
});

/**
 * A synthetic response, for checking the oracle itself.
 *
 * @param status - The status.
 * @param json - The body.
 * @returns The response.
 */
const syntheticResponse = (status: number, json: JsonObject): TestResponse => ({
  headers: new Headers(),
  json,
  status,
  text: JSON.stringify(json),
});

/** A targeted case: a request that reaches one required outcome. */
type TargetedCase = (
  context: FuzzContext
) => Effect.Effect<TestResponse, unknown, Services>;

/**
 * Sends a write as the admin, checked and counted like every fuzz request.
 *
 * @param context - Sessions and model.
 * @param method - The method.
 * @param path - The path.
 * @param options - Body and headers.
 * @returns The response.
 */
const adminSends = (
  context: FuzzContext,
  method: string,
  path: string,
  options: {
    readonly body?: JsonObject;
    readonly headers?: Readonly<Record<string, string>>;
  } = {}
) =>
  send(context, {
    ...options,
    method,
    path,
    target: null,
    token: context.admin,
  });

/**
 * A fresh item, then a PATCH of it through the parent endpoint.
 *
 * @param context - Sessions and model.
 * @param body - The PATCH body.
 * @param headers - The PATCH headers.
 * @returns The response.
 */
const patchFresh = (
  context: FuzzContext,
  body: JsonObject,
  headers: Readonly<Record<string, string>>
) =>
  freshRecord(context, ITEM).pipe(
    Effect.flatMap((fresh) =>
      adminSends(context, "PATCH", recordPath(ITEM, fresh.id), {
        body,
        headers,
      })
    )
  );

/**
 * One targeted case per required outcome. The random phase usually reaches
 * every outcome, but how often depends on what fast-check draws: a unique
 * conflict needs a body that passes validation, the owner's CHECK, NOT NULL
 * and trigger, and a code already taken by a live record in some case, so
 * some seeds never reach `notUnique`. After the random phase, each outcome
 * it missed gets its case through the same request path and checks, as the
 * conditions differential test's targeted phase does, so the coverage gate
 * depends on neither luck nor speed.
 */
const TARGETED_CASES: ReadonlyMap<string, TargetedCase> = new Map<
  string,
  TargetedCase
>([
  [
    "201",
    (context) =>
      adminSends(context, "POST", listPath(ITEM), { body: validBody(ITEM) }),
  ],
  [
    "200",
    (context) =>
      patchFresh(context, { name: "nmpatched" }, { "if-match": '"1"' }),
  ],
  [
    "400 InvalidRequest",
    (context) =>
      patchFresh(context, { name: "nmbadmatch" }, { "if-match": "one" }),
  ],
  [
    "400 UnknownField",
    (context) =>
      adminSends(context, "POST", listPath(ITEM), {
        body: { ...validBody(ITEM), nosuchfield: 1 },
      }),
  ],
  [
    "403 NotAllowed",
    (context) =>
      adminSends(context, "POST", listPath(USER), {
        body: { login: freshToken("fz"), name: "nmuser" },
      }).pipe(
        Effect.flatMap((created) =>
          adminSends(
            context,
            "DELETE",
            recordPath(USER, parsedOf(created).record?.id ?? ""),
            { headers: { "if-match": '"1"' } }
          )
        )
      ),
  ],
  [
    "404 NotFound",
    (context) =>
      adminSends(context, "PATCH", recordPath(ITEM, randomUUID()), {
        body: { name: "nmnobody" },
        headers: { "if-match": '"1"' },
      }),
  ],
  [
    "409 Referenced",
    (context) =>
      Effect.gen(function* referenced() {
        const target = yield* freshRecord(context, ITEM);

        yield* freshRecord(context, ITEM, { parent: target.id });

        return yield* adminSends(
          context,
          "DELETE",
          recordPath(ITEM, target.id),
          {
            headers: { "if-match": '"1"' },
          }
        );
      }),
  ],
  [
    "409 VersionConflict",
    (context) =>
      patchFresh(context, { name: "nmstale" }, { "if-match": '"7"' }),
  ],
  [
    "422 InvalidReference",
    (context) =>
      adminSends(context, "POST", listPath(ITEM), {
        body: { ...validBody(ITEM), parent: randomUUID() },
      }),
  ],
  [
    "422 ValidationFailed",
    (context) =>
      adminSends(context, "POST", listPath(ITEM), {
        body: { ...validBody(ITEM), name: null },
      }),
  ],
  [
    "428 VersionRequired",
    (context) => patchFresh(context, { name: "nmnoversion" }, {}),
  ],
  [
    "500",
    (context) =>
      adminSends(context, "POST", listPath(ITEM), {
        body: { ...validBody(ITEM), qty: -1 },
      }),
  ],
  [
    "notUnique",
    (context) =>
      Effect.gen(function* notUnique() {
        const taken = yield* freshRecord(context, ITEM);

        return yield* adminSends(context, "POST", listPath(SPECIAL), {
          body: {
            ...validBody(SPECIAL),
            code: textsOf(taken.body.code).join("").toUpperCase(),
          },
        });
      }),
  ],
]);

describe("error-fuzz", () => {
  it("draws unique values that collide across case", () => {
    assert.isTrue(TOKEN.test("kqghmn"));
    assert.isFalse(TOKEN.test("0192f000"));
    assert.strictEqual("kqghmn".replaceAll(LOWER_LETTER, "x"), "xxxxxx");
  });

  it("the oracle rejects a stored value of the target in a refusal", () => {
    const target: Tracked = {
      concrete: ITEM,
      deleted: false,
      id: "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f",
      kind: "item",
      secrets: new Set(["nmoldvalue", "ntkeptnote"]),
      version: 2,
    };

    const model: Model = {
      actors: new Set(),
      outcomes: new Map(),
      records: [target],
    };

    const sent: Sent = {
      body: { name: "nmnewvalue" },
      path: recordPath(ITEM, target.id),
      target,
    };

    // A synthetic leak: a refusal repeating the target's old name.
    assert.throws(() => {
      checkResponse(
        model,
        sent,
        syntheticResponse(422, {
          _tag: "ValidationFailed",
          errors: [
            {
              _tag: "InvalidValue",
              field: "name",
              message: "was nmoldvalue",
              reason: "tooLong",
            },
          ],
        })
      );
    }, /stored value/u);

    // The same value in a saved record's projection is the record itself.
    assert.doesNotThrow(() => {
      checkResponse(
        model,
        sent,
        syntheticResponse(200, {
          record: {
            class: ITEM,
            id: target.id,
            values: { name: "nmnewvalue", note: "ntkeptnote" },
            version: 3,
          },
          schemaRevision: 1,
        })
      );
    });

    // A refusal may repeat only what the request sent.
    assert.doesNotThrow(() => {
      checkResponse(
        model,
        sent,
        syntheticResponse(422, {
          _tag: "ValidationFailed",
          errors: [
            {
              _tag: "InvalidValue",
              field: "name",
              message: "The value is too long.",
              reason: "tooLong",
            },
          ],
        })
      );
    });
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: TIMEOUT })(
    (dbTest) => {
      dbTest.effect(
        "creates the fuzz tables, the owner's constraints and an admin",
        () => prepare
      );

      for (const version of VERSIONS) {
        const titled = (title: string): string =>
          version === "v1" ? title : `${title} in /api/v2`;

        // Each version's unique-conflict test uses its own code, so the
        // records of the other version's run do not take it.
        const uniqueCode = version === "v1" ? "kqvvvv" : "kqwwww";

        dbTest.effect(
          titled("a unique conflict reveals only that the value is taken"),
          () =>
            Effect.gen(function* uniqueConflict() {
              const context = yield* setUpFor(version);

              const first = yield* send(context, {
                body: { code: uniqueCode, name: "nmfirst", note: "ntfirst" },
                method: "POST",
                path: listPath(ITEM),
                target: null,
                token: context.admin,
              });

              assert.strictEqual(first.status, 201, first.text);

              const firstId = parsedOf(first).record?.id ?? "";

              const again = yield* send(context, {
                body: {
                  code: uniqueCode.toUpperCase(),
                  name: "nmsecond",
                  note: "ntsecond",
                },
                method: "POST",
                path: listPath(SPECIAL),
                target: null,
                token: context.admin,
              });

              assert.strictEqual(again.status, 422, again.text);

              const notUnique = {
                _tag: "InvalidValue",
                field: "code",
                message: NOT_UNIQUE_MESSAGE,
                reason: "notUnique",
              };

              assert.strictEqual(parsedOf(again)._tag, "ValidationFailed");
              assert.deepStrictEqual(parsedOf(again).errors, [notUnique]);

              if (version === "v1") {
                assert.deepStrictEqual(again.json, {
                  _tag: "ValidationFailed",
                  errors: [notUnique],
                });
              }

              assert.notInclude(again.text, firstId);
              assert.notInclude(again.text, "nmfirst");

              // A delete refused by a reference says nothing else.
              const child = yield* send(context, {
                body: { name: "nmchild", note: "ntchild", parent: firstId },
                method: "POST",
                path: listPath(ITEM),
                target: null,
                token: context.admin,
              });

              assert.strictEqual(child.status, 201, child.text);

              const refused = yield* send(context, {
                headers: { "if-match": '"1"' },
                method: "DELETE",
                path: recordPath(ITEM, firstId),
                target: null,
                token: context.admin,
              });

              assert.strictEqual(refused.status, 409, refused.text);
              assert.strictEqual(parsedOf(refused)._tag, "Referenced");

              if (version === "v1") {
                assert.strictEqual(refused.text, '{"_tag":"Referenced"}');
              }

              // The owner's constraints and trigger: an empty 500.
              for (const body of [
                { code: "kqcheck", name: "nmneg", note: "nt", qty: -1 },
                { code: "kqnull", name: "nmnull", note: null },
                { code: "kqboom", name: "boom", note: "nt" },
              ]) {
                const response = yield* send(context, {
                  body,
                  method: "POST",
                  path: listPath(ITEM),
                  target: null,
                  token: context.admin,
                });

                assert.strictEqual(response.status, 500, JSON.stringify(body));
                assert.strictEqual(response.text, "");
              }
            })
        );

        dbTest.effect(
          titled(
            "every constraint on every write path gives its intended refusal"
          ),
          () =>
            Effect.gen(function* matrix() {
              const context = yield* setUpFor(version);
              const seen = new Map<string, string>();
              const snapshot = yield* (yield* Catalog).refresh;

              // Every committed save of the fuzz hierarchy writes a delivery
              // row; a refused one must leave none. One subscription serves
              // both versions' matrices.
              if (!matrixState.subscribed) {
                matrixState.subscribed = true;
                yield* subscribe({
                  classId: snapshot.classByName(ITEM)?.id ?? "",
                  identityId: (yield* AcmeFixture).alice.id,
                });
              }

              // The subscription is live: a valid create leaves one row.
              assert.strictEqual(
                yield* withDeliveries(
                  freshRecord(context, SPECIAL).pipe(
                    Effect.as(syntheticResponse(201, { _tag: "Created" }))
                  )
                ),
                "201 Created +1 deliveries"
              );

              for (const cell of MATRIX) {
                seen.set(cellKey(cell), yield* takeCell(context, cell));
              }

              assert.deepStrictEqual(
                Object.fromEntries(seen),
                Object.fromEntries(
                  MATRIX.map((cell) => [
                    cellKey(cell),
                    INTENDED[cell.constraint],
                  ])
                )
              );
              assert.lengthOf(MATRIX, 36);
            }),
          TIMEOUT
        );

        dbTest.effect(
          titled("every targeted case reaches its outcome"),
          () =>
            Effect.gen(function* targetedCases() {
              const context = yield* setUpFor(version);

              assert.sameMembers(
                [...TARGETED_CASES.keys()],
                [...REQUIRED_OUTCOMES]
              );

              for (const [outcome, targeted] of TARGETED_CASES) {
                const response = yield* targeted(context);

                assert.include(
                  outcomesOf(response),
                  outcomeLabel(version, outcome),
                  response.text
                );
              }
            }),
          TIMEOUT
        );

        dbTest.effect(
          titled(
            "fuzzed constraint violations never return Postgres text or values"
          ),
          () =>
            Effect.gen(function* fuzz() {
              const context = yield* setUpFor(version);
              const services = yield* Effect.context<Services>();
              const run = Effect.runPromiseWith(services);

              const result = yield* Effect.promise(
                async () => await checkSequences(context, run)
              );

              assert.isFalse(
                result.failed,
                `counterexample ${JSON.stringify(result.counterexample)} (seed ${result.seed}): ${String(result.errorInstance)}`
              );

              const seen = context.model.outcomes;

              // The targeted phase: a case for every outcome the random
              // phase missed, through the same requests and checks.
              const missed = REQUIRED_OUTCOMES.filter(
                (outcome) => !seen.has(outcomeLabel(version, outcome))
              );

              for (const outcome of missed) {
                const targeted = TARGETED_CASES.get(outcome);

                assert.isDefined(targeted, `no targeted case for ${outcome}`);

                if (targeted !== undefined) {
                  yield* targeted(context);
                }
              }

              for (const outcome of REQUIRED_OUTCOMES) {
                assert.isTrue(
                  seen.has(outcomeLabel(version, outcome)),
                  `never reached ${outcome}: ${JSON.stringify([...seen])}`
                );
              }

              yield* Effect.logInfo(
                `error-fuzz ${version}: ${RUNS} runs; outcomes the targeted phase reached: ${missed.join(", ") || "none"}`
              );
            }),
          TIMEOUT
        );
      }
    }
  );
});
