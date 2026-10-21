/**
 * `error-fuzz` (Contracts 3 "Acceptance tests", 3.8; plan Step 1 gate):
 * fuzzed constraint violations on every write path never return Postgres
 * text, constraint names or stored values.
 *
 * A fuzz hierarchy (`acme.fuzz_item`, child `acme.fuzz_special`) is created
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
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Option, Schema } from "effect";
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
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import {
  ACME,
  addField,
  addIndex,
  change,
  createClass,
} from "./schema-support.ts";

const ITEM = "acme.fuzz_item";
const SPECIAL = "acme.fuzz_special";
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

const STATUSES = new Set([200, 201, 400, 403, 404, 409, 422, 428, 500]);

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

/**
 * The parts of a response body the checks read.
 *
 * @param response - A response.
 * @returns The decoded body; no members when it does not decode.
 */
const parsedOf = (response: TestResponse): ResponseBody =>
  Option.getOrElse(decodeBody(response.json), () => ({}));

/** What the checks need to know about one request. */
interface Sent {
  readonly path: string;
  readonly body: JsonValue | undefined;
  /** The record the request targets, if the model knows it. */
  readonly target: Tracked | null;
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
 */
const assertMembers = (
  value: JsonValue | undefined,
  tag: string,
  allowed: readonly string[] | undefined
): void => {
  assert.isDefined(allowed, `undocumented ${tag}`);
  const object = value !== undefined && isJsonObject(value) ? value : undefined;

  assert.isDefined(object, `${tag} is not an object`);

  for (const key of Object.keys(object ?? {})) {
    assert.include(["_tag", ...(allowed ?? [])], key, `${tag}.${key}`);
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

  assertMembers(response.json, tag, ERROR_MEMBERS.get(tag));

  const json = response.json ?? null;
  const raw = isJsonObject(json) ? json.errors : undefined;
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

  if (tag === "Referenced") {
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

  assert.isTrue(STATUSES.has(response.status), `status: ${where}`);

  if (response.status === 500) {
    assert.strictEqual(response.text, "", `a 500 with a body: ${where}`);
  }

  for (const phrase of FORBIDDEN) {
    assert.notInclude(text, phrase, `Postgres text: ${where}`);
  }

  const requestText =
    `${sent.path} ${JSON.stringify(sent.body ?? null)}`.toLowerCase();

  const sentTexts = new Set(textsOf(sent.body));
  const saved = parsedOf(response).record;

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

    const mine = tracked.id === saved?.id || tracked === sent.target;

    for (const secret of mine ? [] : tracked.secrets) {
      if (!(sentTexts.has(secret) || requestText.includes(secret))) {
        assert.notInclude(text, secret, `foreign value: ${where}`);
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

const send = Effect.fn("ErrorFuzz.send")(function* send(
  context: FuzzContext,
  request: StepRequest
) {
  const response = yield* context.http.request(
    request.method,
    request.path,
    optionsOf(request)
  );

  checkResponse(
    context.model,
    { body: request.body, path: request.path, target: request.target },
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

  if (response.status === 200 && target !== null) {
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
  const item = createClass("fuzz_item", { namespaceId: ACME.namespace });

  const special = createClass("fuzz_special", {
    namespaceId: ACME.namespace,
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
    `ALTER TABLE acme.fuzz_item ADD CONSTRAINT xq_qty_nonneg CHECK (qty >= 0)`
  );
  yield* sql.unsafe(
    `ALTER TABLE acme.fuzz_item ALTER COLUMN note SET NOT NULL`
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
    `CREATE TRIGGER xq_boom_trigger BEFORE INSERT OR UPDATE ON acme.fuzz_item
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

/** Signs in the admin and Alice; the model starts with the acme records. */
const setUp = Effect.gen(function* setUp() {
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

  return { admin, alice, http, model } satisfies FuzzContext;
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

describe("error-fuzz", () => {
  it("draws unique values that collide across case", () => {
    assert.isTrue(TOKEN.test("kqghmn"));
    assert.isFalse(TOKEN.test("0192f000"));
    assert.strictEqual("kqghmn".replaceAll(LOWER_LETTER, "x"), "xxxxxx");
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: TIMEOUT })(
    (dbTest) => {
      dbTest.effect(
        "creates the fuzz tables, the owner's constraints and an admin",
        () => prepare
      );

      dbTest.effect(
        "a unique conflict reveals only that the value is taken",
        () =>
          Effect.gen(function* uniqueConflict() {
            const context = yield* setUp;

            const first = yield* send(context, {
              body: { code: "kqvvvv", name: "nmfirst", note: "ntfirst" },
              method: "POST",
              path: listPath(ITEM),
              target: null,
              token: context.admin,
            });

            assert.strictEqual(first.status, 201, first.text);

            const firstId = parsedOf(first).record?.id ?? "";

            const again = yield* send(context, {
              body: { code: "KQVVVV", name: "nmsecond", note: "ntsecond" },
              method: "POST",
              path: listPath(SPECIAL),
              target: null,
              token: context.admin,
            });

            assert.strictEqual(again.status, 422, again.text);
            assert.deepStrictEqual(again.json, {
              _tag: "ValidationFailed",
              errors: [
                {
                  _tag: "InvalidValue",
                  field: "code",
                  message: NOT_UNIQUE_MESSAGE,
                  reason: "notUnique",
                },
              ],
            });
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

            assert.strictEqual(refused.status, 409);
            assert.strictEqual(refused.text, '{"_tag":"Referenced"}');

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
        "fuzzed constraint violations never return Postgres text or values",
        () =>
          Effect.gen(function* fuzz() {
            const context = yield* setUp;
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

            for (const outcome of REQUIRED_OUTCOMES) {
              assert.isTrue(
                seen.has(outcome),
                `never reached ${outcome}: ${JSON.stringify([...seen])}`
              );
            }
          }),
        TIMEOUT
      );
    }
  );
});
