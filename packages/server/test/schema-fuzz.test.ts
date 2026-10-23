/**
 * `schema-fuzz` (plan Step 1 gate, gate row 1.9; Contracts 1.1, 1.4 to
 * 1.8, 3.8): fuzzed definition writes through the change-set endpoint
 * (`POST /api/v1/applyChangeSet`) and through generic writes on
 * definition tables (`POST`, `PATCH`, `DELETE` on `coreField`,
 * `coreClass`, `coreIndex`, `coreRole`, `coreAccessRule`) never return
 * Postgres text, constraint names or stored values, and a refused change
 * set commits nothing.
 *
 * A `site` hierarchy (`site.fz_base`, child `site.fz_child`) with rows is
 * the target: duplicates and nulls make `ExistingDataViolates` reachable,
 * a retired field makes purges reachable, a local role named by a local
 * access rule makes `DependencyConflict` reachable, a deleted role leaves a
 * tombstone and a role hidden from admins by a core deny rule is an
 * occupant the caller cannot see (`idInUse`, Contracts 1.1).
 *
 * fast-check draws sequences of steps: creates of fields, indexes, roles
 * and access rules with valid, taken, invalid or overlong names and
 * fresh, tombstone, visible or hidden IDs; deletes, retires,
 * reactivations, purges, renames, relabels and `required` changes of
 * roles, fields and classes, local, protected or missing, with current,
 * stale, missing or malformed versions; generic bodies with unknown or
 * read-only columns and malformed JSON; as an admin, an admin holding
 * `schema.purge`, Alice and Bob. Every response is checked:
 *
 * - a documented status; a 500 has an empty body; a 503 has `Retry-After`;
 * - no Postgres wording, constraint name or SQLSTATE text (3.8);
 * - no stored row value, ever; a record ID only as one of the sample IDs
 *   of `ExistingDataViolates`, which Contracts 1.4 returns on purpose
 *   ("refused with count and samples");
 * - no ID or name of the hidden role unless the request named it (3.6:
 *   hidden is like missing; 1.1: the occupied-ID refusal names only the
 *   caller's own ID);
 * - for Alice and Bob, who cannot read definition tables, no ID or name
 *   of a site definition the request did not name;
 * - error bodies with only their documented members;
 * - a refusal leaves the revision, the journal and `core.change` as they
 *   were.
 *
 * Admins read every definition, so a refusal naming a visible definition
 * (a `DependencyConflict` dependent, a problem message naming a class) is
 * not a leak (Contracts 1.7: the refusal lists "each blocking dependent by
 * ID, kind and name").
 *
 * Every refusal kind the random phase misses gets a targeted step through
 * the same request path and checks, and another test runs every targeted
 * step, so the coverage gate depends neither on luck nor on speed.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Definition, DefinitionKind } from "@std/definitions/definition";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { Operation } from "@std/definitions/operation";
import { setOrigin } from "@std/definitions/requester";
import {
  BUILT_IN_ROLE_IDS,
  PLATFORM_CLASS_IDS,
  USER_CLASS_ID,
} from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import type { SqlClient } from "effect/sql";
import {
  array,
  asyncProperty,
  boolean,
  check,
  constantFrom,
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
import { tableOf } from "../src/catalog/definition-tables.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { arrayOf, objectOf, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import { CHANGE_SETS } from "./schema-paths-support.ts";
import {
  addAccessRule,
  addField,
  addIndex,
  addRole,
  change,
  createClass,
  ensureSite,
  freshId,
  insertRecords,
  values,
} from "./schema-support.ts";

/** Who sends a request. */
type Caller = "ada" | "pam" | "alice" | "bob";

/** Phrases only Postgres or STD's SQL layer would write. */
const FORBIDDEN = [
  " violates ",
  "duplicate key",
  "key (",
  "detail:",
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
  "invalid input syntax",
  'relation "',
  'column "',
  "syntax error",
  "null value in",
  "deadlock",
  "could not ",
  "postgres",
  "select ",
  "insert into",
  "alter table",
];

const STATUSES = new Set([
  200, 201, 204, 400, 403, 404, 405, 409, 412, 415, 422, 428, 500, 501, 503,
]);

/** The members of every TMF Error besides its details (Contracts 10.6). */
const TMF_MEMBERS = [
  "@baseType",
  "@schemaLocation",
  "@type",
  "code",
  "message",
  "reason",
  "referenceError",
  "status",
] as const;

/** The members each error body may have besides the TMF ones. */
const ERROR_MEMBERS = new Map<string, readonly string[]>([
  ["DefinitionInvalid", ["problems"]],
  ["DefinitionProtected", ["definitionId", "operation", "reason"]],
  ["DependencyConflict", ["definitionId", "dependents", "operation"]],
  ["ExistingDataViolates", ["count", "definitionId", "sampleIds"]],
  ["InvalidRequest", ["message", "parameter"]],
  ["InvalidSchemaRevision", []],
  ["NotAllowed", []],
  ["NotFound", []],
  ["PermissionRequired", ["permission", "permissionId"]],
  ["PurgeRefused", ["count", "definitionId", "reason"]],
  ["SchemaBusy", ["changeSetId", "retryAfterSeconds"]],
  ["SchemaChanged", ["changes", "currentRevision", "requestRevision"]],
  ["SchemaLockTimeout", ["attempts"]],
  ["SchemaNeedsAttention", ["changeSetId"]],
  ["Unauthenticated", []],
  ["UnknownField", ["field"]],
  ["UnknownTable", ["table"]],
  ["UseRetireOrPurge", ["definitionId", "kind"]],
  ["ValidationFailed", ["fieldErrors"]],
  ["VersionConflict", ["currentVersion"]],
  ["VersionRequired", []],
]);

/** The members of nested parts of error bodies. */
const PROBLEM_MEMBERS = ["code", "definitionId", "message"];
const DEPENDENT_MEMBERS = ["dependency", "id", "kind", "name"];

const FIELD_ERROR_MEMBERS = new Map<string, readonly string[]>([
  ["DefinitionRetired", ["field"]],
  ["InvalidValue", ["field", "hint", "message", "reason"]],
  ["ReadOnlyField", ["field"]],
  ["Required", ["field"]],
]);

// Letters that are not hex digits, so a stored token never appears inside
// a UUID by chance.
const TOKEN_LETTERS = "ghjkmnpqrstvwxyz";

let tokenCount = 0;

/**
 * A fresh token: a prefix and letters that are not hex digits.
 *
 * @param prefix - Two letters naming its use.
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

/** What the setup created, by role in the fuzz. */
interface World {
  readonly baseId: string;
  readonly childId: string;
  /** A retired child class whose records keep rows in the base. */
  readonly retiredChildId: string;
  readonly fields: {
    readonly code: string;
    readonly title: string;
    readonly qty: string;
    readonly oldf: string;
    readonly tag: string;
  };
  readonly ruledRole: string;
  readonly freeRole: string;
  readonly hiddenRole: string;
  readonly hiddenRoleName: string;
  readonly ruledRoleName: string;
  readonly tombRole: string;
  readonly changeEntry: string;
  /** IDs of the seeded records. */
  readonly recordIds: ReadonlySet<string>;
  /** Values stored in the seeded rows; never in a response. */
  readonly rowTokens: ReadonlySet<string>;
  /** IDs and names of site definitions; Alice and Bob never see them. */
  readonly siteDefinitions: Set<string>;
}

/** Sessions, the world and what was seen. */
interface FuzzContext {
  readonly http: TestHttpClientApi;
  readonly tokens: Readonly<Record<Caller, string>>;
  readonly world: World;
  /** How often each outcome was seen. */
  readonly outcomes: Map<string, number>;
}

/** One request. */
interface FuzzRequest {
  readonly caller: Caller;
  readonly method: string;
  readonly path: string;
  readonly body?: JsonValue;
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const ROW_TOKENS = {
  dupTitle: "rvdupmkqw",
  oldValue: "rvoldnpgt",
} as const;

/**
 * The outcomes of a response, for the coverage gate: `<status> <tag>`,
 * plus `DefinitionInvalid:<code>` per problem and `ValidationFailed:<tag>`
 * per field error.
 *
 * @param response - A response.
 * @returns The outcomes.
 */
const outcomesOf = (response: TestResponse): string[] => {
  const body = objectOf(response.json);
  const tag = body.code === undefined ? undefined : textOf(body.code);

  const head =
    tag === undefined ? `${response.status}` : `${response.status} ${tag}`;

  const problems = arrayOf(body.problems).map(
    (problem) => `DefinitionInvalid:${textOf(objectOf(problem).code)}`
  );

  const errors = arrayOf(body.fieldErrors).map(
    (error) => `ValidationFailed:${textOf(objectOf(error)._tag)}`
  );

  const reasons =
    tag === "PurgeRefused" ? [`PurgeRefused:${textOf(body.reason)}`] : [];

  return [head, ...problems, ...errors, ...reasons];
};

/**
 * Checks a JSON object has only the allowed members.
 *
 * @param value - The object.
 * @param what - What it is, for messages.
 * @param allowed - The allowed members.
 * @param base - Members every such object may have.
 */
const assertMembers = (
  value: JsonValue | undefined,
  what: string,
  allowed: readonly string[] | undefined,
  base: readonly string[] = TMF_MEMBERS
): void => {
  assert.isDefined(allowed, `undocumented ${what}`);
  assert.isTrue(
    value !== undefined && isJsonObject(value),
    `${what} is not an object`
  );

  for (const key of Object.keys(objectOf(value))) {
    assert.include([...base, ...(allowed ?? [])], key, `${what}.${key}`);
  }
};

/**
 * Checks an error body's members, and its nested parts'.
 *
 * @param response - A response.
 */
const checkMembers = (response: TestResponse): void => {
  const body = objectOf(response.json);

  if (body.code === undefined) {
    return;
  }

  const tag = textOf(body.code);

  assertMembers(response.json, tag, ERROR_MEMBERS.get(tag));

  for (const problem of arrayOf(body.problems)) {
    assertMembers(problem, `${tag}.problems[]`, PROBLEM_MEMBERS, []);
  }

  for (const dependent of arrayOf(body.dependents)) {
    assertMembers(dependent, `${tag}.dependents[]`, DEPENDENT_MEMBERS, []);
  }

  for (const error of arrayOf(body.fieldErrors)) {
    const errorTag = textOf(objectOf(error)._tag);

    assertMembers(
      error,
      `${tag}.fieldErrors[]`,
      FIELD_ERROR_MEMBERS.get(errorTag),
      ["_tag"]
    );
  }
};

/**
 * Checks one response against everything Contracts 3.8 forbids.
 *
 * @param world - The world.
 * @param request - The request.
 * @param response - Its response.
 */
const checkResponse = (
  world: World,
  request: FuzzRequest,
  response: TestResponse
): void => {
  const sent = `${request.path} ${request.rawBody ?? JSON.stringify(request.body ?? null)}`;
  const where = `${request.caller} ${request.method} ${sent} -> ${response.status} ${response.text}`;
  const text = response.text.toLowerCase();
  const requestText = sent.toLowerCase();
  const body = objectOf(response.json);

  assert.isTrue(STATUSES.has(response.status), `status: ${where}`);

  if (response.status === 500) {
    assert.strictEqual(response.text, "", `a 500 with a body: ${where}`);
  }

  if (response.status === 503) {
    assert.isNotNull(
      response.headers.get("retry-after"),
      `Retry-After: ${where}`
    );
  }

  for (const phrase of FORBIDDEN) {
    assert.notInclude(text, phrase, `Postgres text: ${where}`);
  }

  for (const token of world.rowTokens) {
    assert.notInclude(text, token, `stored value: ${where}`);
  }

  // Record IDs only as ExistingDataViolates samples (Contracts 1.4).
  const samples = new Set(arrayOf(body.sampleIds).map(textOf));

  for (const id of world.recordIds) {
    if (!(samples.has(id) || requestText.includes(id))) {
      assert.notInclude(text, id, `record ID: ${where}`);
    }
  }

  for (const hidden of [world.hiddenRole, world.hiddenRoleName]) {
    if (!requestText.includes(hidden)) {
      assert.notInclude(text, hidden, `hidden definition: ${where}`);
    }
  }

  if (request.caller === "alice" || request.caller === "bob") {
    for (const definition of world.siteDefinitions) {
      if (!requestText.includes(definition)) {
        assert.notInclude(
          text,
          definition,
          `definition for ${request.caller}: ${where}`
        );
      }
    }
  }

  checkMembers(response);
};

/**
 * The client options of a request.
 *
 * @param request - The request.
 * @param token - The caller's session.
 * @returns The options.
 */
const optionsOf = (request: FuzzRequest, token: string): TestRequestOptions => {
  const headers = request.headers ?? {};

  if (request.rawBody !== undefined) {
    return { headers, rawBody: request.rawBody, token };
  }

  return request.body === undefined
    ? { headers, token }
    : { body: request.body, headers, token };
};

/**
 * Sends a request as its caller, checks the response and, for a refusal,
 * that nothing committed; counts its outcomes.
 *
 * @param context - Sessions, world and outcomes.
 * @param request - The request.
 * @returns The response.
 */
const send = Effect.fn("SchemaFuzz.send")(function* send(
  context: FuzzContext,
  request: FuzzRequest
) {
  const before = yield* committedState;

  const options = optionsOf(request, context.tokens[request.caller]);

  const response = yield* context.http.request(
    request.method,
    request.path,
    options
  );

  checkResponse(context.world, request, response);

  if (response.status >= 400) {
    assert.deepStrictEqual(
      yield* committedState,
      before,
      `a refusal committed: ${request.method} ${request.path} -> ${response.text}`
    );
  }

  for (const outcome of outcomesOf(response)) {
    context.outcomes.set(outcome, (context.outcomes.get(outcome) ?? 0) + 1);
  }

  return response;
});

/** How a write is sent. */
type Via = "changeSet" | "generic";

/** A name a create or rename uses. */
type NameChoice = "fresh" | "taken" | "invalid" | "long";

/** The ID a change-set create chooses. */
type IdChoice = "fresh" | "tombstone" | "visible" | "hidden";

/** A field type of a new field. */
type TypeChoice = "text" | "integer" | "bogus";

/** The fields of a new index. */
const INDEX_FIELDS = [
  "code",
  "title",
  "qty",
  "titleAndQty",
  "missing",
  "none",
] as const;

type IndexFields = (typeof INDEX_FIELDS)[number];

/** A role an access rule names. */
const ROLE_CHOICES = ["ruled", "admin", "hidden", "missing"] as const;

type RoleChoice = (typeof ROLE_CHOICES)[number];

/** A rule's condition. */
const CONDITION_CHOICES = ["none", "valid", "illTyped"] as const;

type ConditionChoice = (typeof CONDITION_CHOICES)[number];

/** A definition a lifecycle step targets. */
const TARGETS = [
  "ruledRole",
  "freeRole",
  "adminRole",
  "hiddenRole",
  "tombRole",
  "missingRole",
  "codeField",
  "titleField",
  "qtyField",
  "oldField",
  "coreUserName",
  "baseClass",
  "retiredChildClass",
  "coreUserClass",
  "changeEntry",
] as const;

type Target = (typeof TARGETS)[number];

/** What a lifecycle step does. */
const ACTIONS = [
  "delete",
  "retire",
  "reactivate",
  "purge",
  "purgeBadConfirm",
  "rename",
  "relabel",
  "require",
] as const;

type Action = (typeof ACTIONS)[number];

/** The version a step states. */
type VersionChoice = "current" | "stale" | "missing" | "malformed";

/** A generic body that is wrong as a body. */
const ODDITIES = [
  "unknownColumn",
  "readOnlyColumn",
  "malformedJson",
  "wrongTypes",
] as const;

type Oddity = (typeof ODDITIES)[number];

/** One fuzz step. */
type Step =
  | {
      readonly op: "addField";
      readonly caller: Caller;
      readonly via: Via;
      readonly child: boolean;
      readonly name: NameChoice;
      readonly type: TypeChoice;
      readonly required: boolean;
      readonly id: IdChoice;
    }
  | {
      readonly op: "addIndex";
      readonly caller: Caller;
      readonly via: Via;
      readonly fields: IndexFields;
      readonly unique: boolean;
      readonly id: IdChoice;
    }
  | {
      readonly op: "createRole";
      readonly caller: Caller;
      readonly via: Via;
      readonly name: NameChoice;
      readonly id: IdChoice;
    }
  | {
      readonly op: "createRule";
      readonly caller: Caller;
      readonly via: Via;
      readonly role: RoleChoice;
      readonly condition: ConditionChoice;
      readonly id: IdChoice;
    }
  | {
      readonly op: "lifecycle";
      readonly caller: Caller;
      readonly via: Via;
      readonly target: Target;
      readonly action: Action;
      readonly version: VersionChoice;
    }
  | {
      readonly op: "oddity";
      readonly caller: Caller;
      readonly oddity: Oddity;
      readonly target: Target;
    };

/**
 * The ID a target stands for.
 *
 * @param world - The world.
 * @param target - The target.
 * @returns Its ID.
 */
const idOf = (world: World, target: Target): string =>
  ({
    adminRole: BUILT_IN_ROLE_IDS.admin,
    baseClass: world.baseId,
    changeEntry: world.changeEntry,
    codeField: world.fields.code,
    coreUserClass: USER_CLASS_ID,
    coreUserName: "13160bfb-1a94-4f0b-a29b-bccf701673c0",
    freeRole: world.freeRole,
    hiddenRole: world.hiddenRole,
    missingRole: "0b0d6c3e-5a0e-4c33-9a43-6e7f6d1b2a99",
    oldField: world.fields.oldf,
    qtyField: world.fields.qty,
    retiredChildClass: world.retiredChildId,
    ruledRole: world.ruledRole,
    titleField: world.fields.title,
    tombRole: world.tombRole,
  })[target];

/**
 * The generic table of a target.
 *
 * @param target - The target.
 * @returns The qualified table name.
 */
const tableOfTarget = (target: Target): string => {
  if (target.endsWith("Role")) {
    return "core.role";
  }

  if (target.endsWith("Field") || target === "coreUserName") {
    return "core.field";
  }

  return target === "changeEntry" ? "core.change" : "core.class";
};

/**
 * The ID a change-set create uses.
 *
 * @param world - The world.
 * @param choice - The choice.
 * @returns The ID.
 */
const createId = (world: World, choice: IdChoice): string =>
  ({
    fresh: freshId(),
    hidden: world.hiddenRole,
    tombstone: world.tombRole,
    visible: world.fields.code,
  })[choice];

/**
 * A name for a create or a rename.
 *
 * @param choice - The choice.
 * @param taken - A name already in use where it is created.
 * @returns The name.
 */
const nameFor = (choice: NameChoice, taken: string): string =>
  ({
    fresh: freshToken("nm"),
    invalid: "Not A-Name",
    long: `n${"x".repeat(80)}`,
    taken,
  })[choice];

/**
 * An operation as the JSON a request body carries.
 *
 * @param operation - The operation.
 * @returns Its JSON.
 */
const toJson = (operation: Operation): Record<string, JsonValue> => {
  const parsed = parseJson(JSON.stringify(operation));

  return parsed.ok && isJsonObject(parsed.value) ? { ...parsed.value } : {};
};

/**
 * A generic POST body for a create: the definition table's columns from
 * the draft.
 *
 * @param operation - A create.
 * @returns The body.
 */
const genericBody = (operation: Operation) => {
  const body: Record<string, JsonValue> = {};

  if (!("definition" in operation)) {
    return body;
  }

  const draft: JsonObject = operation.definition;

  for (const spec of tableOf(operation.definition.kind).columns) {
    const value = draft[spec.property];

    if (!spec.column.startsWith("enforcement") && value !== undefined) {
      body[apiAttributeNameOf(spec.column)] = value;
    }
  }

  if (operation.definition.kind === "accessRule") {
    const { target } = operation.definition;

    body.target = target.kind;
    body.fields =
      target.kind === "fields" && target.fields !== "*"
        ? [...target.fields]
        : null;
  }

  return body;
};

/** A create step's operation, the kind it creates and a bogus type. */
interface CreateStep {
  readonly operation: Operation;
  readonly kind: DefinitionKind;
  /** Replaces a field's type in the body, so the decoder refuses it. */
  readonly bogusType?: JsonValue;
}

/**
 * The create operation of a create step.
 *
 * @param world - The world.
 * @param step - The step.
 * @returns The operation, the kind it creates and its field type, if a
 *   field's type is to be replaced by a bogus one.
 */
const createOperationOf = (
  world: World,
  step: Exclude<Step, { readonly op: "lifecycle" | "oddity" }>
): CreateStep => {
  if (step.op === "addField") {
    const field = addField(
      step.child ? world.childId : world.baseId,
      nameFor(step.name, "code"),
      { kind: step.type === "integer" ? "integer" : "text" },
      { id: createId(world, step.id), required: step.required }
    );

    // A bogus type replaces the valid one in the body: the decoder
    // refuses it.
    return step.type === "bogus"
      ? { bogusType: { kind: "colour" }, kind: "field", operation: field.op }
      : { kind: "field", operation: field.op };
  }

  if (step.op === "addIndex") {
    const fields = {
      code: [world.fields.code],
      missing: ["0b0d6c3e-5a0e-4c33-9a43-6e7f6d1b2a98"],
      none: [],
      qty: [world.fields.qty],
      title: [world.fields.title],
      titleAndQty: [world.fields.title, world.fields.qty],
    }[step.fields];

    return {
      kind: "index",
      operation: addIndex(
        world.baseId,
        fields,
        step.unique,
        createId(world, step.id)
      ).op,
    };
  }

  if (step.op === "createRole") {
    return {
      kind: "role",
      operation: addRole(
        nameFor(step.name, world.ruledRoleName),
        createId(world, step.id)
      ).op,
    };
  }

  const roleId = {
    admin: BUILT_IN_ROLE_IDS.admin,
    hidden: world.hiddenRole,
    missing: "0b0d6c3e-5a0e-4c33-9a43-6e7f6d1b2a97",
    ruled: world.ruledRole,
  }[step.role];

  // An ill-typed condition compares the integer `qty` with text.
  const condition =
    step.condition === "none"
      ? undefined
      : {
          left: {
            path: [
              step.condition === "valid" ? world.fields.code : world.fields.qty,
            ],
          },
          op: "eq" as const,
          right: { value: freshToken("cv") },
        };

  const description = freshToken("ds");

  const rule = addAccessRule(
    world.baseId,
    [roleId],
    condition === undefined ? { description } : { condition, description },
    { id: createId(world, step.id) }
  );

  return { kind: "accessRule", operation: rule.op };
};

/**
 * The stored version of a definition, as the step states it.
 *
 * @param stored - The stored definition, if any.
 * @param choice - Current or stale.
 * @returns The version.
 */
const versionFor = (
  stored: Definition | undefined,
  choice: VersionChoice
): number => {
  const current = stored?.version ?? 1;

  return choice === "stale" ? current + 3 : current;
};

/**
 * The change-set operation of a lifecycle step.
 *
 * @param id - The target.
 * @param version - The stated version.
 * @param step - The step.
 * @returns The operation.
 */
const lifecycleOperation = (
  id: string,
  version: number,
  step: Extract<Step, { readonly op: "lifecycle" }>
): Operation => {
  const builders: Readonly<Record<Action, () => Operation>> = {
    delete: () => ({ id, op: "delete", version }),
    purge: () => ({ confirm: { id, version }, id, op: "purge", version }),
    purgeBadConfirm: () => ({
      confirm: { id, version: version + 1 },
      id,
      op: "purge",
      version,
    }),
    reactivate: () => ({ id, op: "reactivate", version }),
    relabel: () => ({
      changes: { label: freshToken("lb") },
      id,
      op: "update",
      version,
    }),
    rename: () => ({ id, name: freshToken("rn"), op: "rename", version }),
    require: () => ({ changes: { required: true }, id, op: "update", version }),
    retire: () => ({ id, op: "retire", version }),
  };

  return builders[step.action]();
};

/**
 * The generic body of a lifecycle step, for `PATCH`.
 *
 * @param step - The step.
 * @returns The body.
 */
const patchBody = (
  step: Extract<Step, { readonly op: "lifecycle" }>
): JsonObject =>
  ({
    delete: {},
    purge: { state: "purged" },
    purgeBadConfirm: { state: "purged" },
    reactivate: { state: "active" },
    relabel: { label: freshToken("lb") },
    rename: { name: freshToken("rn") },
    require: { required: true },
    retire: { state: "retired" },
  })[step.action];

/**
 * The `If-Match` header of a generic write.
 *
 * @param version - The stated version.
 * @param choice - How it is stated.
 * @returns The headers.
 */
const ifMatch = (version: number, choice: VersionChoice) => {
  if (choice === "missing") {
    return {};
  }

  return { "if-match": choice === "malformed" ? "seven" : `"${version}"` };
};

/**
 * The request a step stands for.
 *
 * @param context - Sessions and world.
 * @param step - The step.
 * @returns The request.
 */
const requestOf = Effect.fn("SchemaFuzz.requestOf")(function* requestOf(
  context: FuzzContext,
  step: Step
) {
  const { world } = context;

  if (step.op === "oddity") {
    const snapshot = yield* (yield* Catalog).refresh;
    const id = idOf(world, step.target);
    const path = recordPath(tableOfTarget(step.target), id);
    const headers = { "if-match": `"${snapshot.get(id)?.version ?? 1}"` };

    const bodies: Readonly<Record<Oddity, Partial<FuzzRequest>>> = {
      malformedJson: { rawBody: '{"label": "x",' },
      readOnlyColumn: { body: { ownerLayer: "core" } },
      unknownColumn: { body: { colour: "red" } },
      wrongTypes: { body: { label: 42 } },
    };

    return {
      caller: step.caller,
      headers,
      method: "PATCH",
      path,
      ...bodies[step.oddity],
    } satisfies FuzzRequest;
  }

  if (step.op !== "lifecycle") {
    const { bogusType, kind, operation } = createOperationOf(world, step);

    if ("definition" in operation) {
      world.siteDefinitions.add(operation.definition.id);
    }

    const json = toJson(operation);
    const body = genericBody(operation);

    if (bogusType !== undefined) {
      json.definition = { ...objectOf(json.definition), type: bogusType };
      body[apiAttributeNameOf("type")] = bogusType;
    }

    return step.via === "changeSet"
      ? ({
          body: { operations: [json] },
          caller: step.caller,
          method: "POST",
          path: CHANGE_SETS,
        } satisfies FuzzRequest)
      : ({
          body,
          caller: step.caller,
          method: "POST",
          path: listPath(`core.${tableOf(kind).table}`),
        } satisfies FuzzRequest);
  }

  const snapshot = yield* (yield* Catalog).refresh;
  const id = idOf(world, step.target);
  const version = versionFor(snapshot.get(id), step.version);

  if (step.via === "changeSet") {
    return {
      body: { operations: [toJson(lifecycleOperation(id, version, step))] },
      caller: step.caller,
      method: "POST",
      path: CHANGE_SETS,
    } satisfies FuzzRequest;
  }

  const path = recordPath(tableOfTarget(step.target), id);
  const headers = ifMatch(version, step.version);

  return step.action === "delete"
    ? ({
        caller: step.caller,
        headers,
        method: "DELETE",
        path,
      } satisfies FuzzRequest)
    : ({
        body: patchBody(step),
        caller: step.caller,
        headers,
        method: "PATCH",
        path,
      } satisfies FuzzRequest);
});

/**
 * Runs a step: builds its request and sends it.
 *
 * @param context - Sessions, world and outcomes.
 * @param step - The step.
 * @returns The response.
 */
const runStep = (context: FuzzContext, step: Step) =>
  requestOf(context, step).pipe(
    Effect.flatMap((request) => send(context, request))
  );

/**
 * Runs steps in order.
 *
 * @param context - Sessions, world and outcomes.
 * @param steps - The steps.
 * @returns True, for fast-check.
 */
const runSteps = (context: FuzzContext, steps: readonly Step[]) =>
  Effect.gen(function* runAll() {
    for (const step of steps) {
      yield* runStep(context, step);
    }

    return true;
  });

const callerArb: Arbitrary<Caller> = constantFrom(
  "ada",
  "ada",
  "ada",
  "pam",
  "pam",
  "alice",
  "bob"
);

const viaArb: Arbitrary<Via> = constantFrom("changeSet", "generic");

const nameArb: Arbitrary<NameChoice> = constantFrom(
  "fresh",
  "fresh",
  "taken",
  "invalid",
  "long"
);

const idArb: Arbitrary<IdChoice> = constantFrom(
  "fresh",
  "fresh",
  "tombstone",
  "visible",
  "hidden"
);

const stepArb: Arbitrary<Step> = oneof(
  record({
    caller: callerArb,
    child: boolean(),
    id: idArb,
    name: nameArb,
    op: constantFrom("addField" as const),
    required: boolean(),
    type: constantFrom<TypeChoice>("text", "text", "integer", "bogus"),
    via: viaArb,
  }),
  record({
    caller: callerArb,
    fields: constantFrom(...INDEX_FIELDS),
    id: idArb,
    op: constantFrom("addIndex" as const),
    unique: boolean(),
    via: viaArb,
  }),
  record({
    caller: callerArb,
    id: idArb,
    name: nameArb,
    op: constantFrom("createRole" as const),
    via: viaArb,
  }),
  record({
    caller: callerArb,
    condition: constantFrom(...CONDITION_CHOICES),
    id: idArb,
    op: constantFrom("createRule" as const),
    role: constantFrom(...ROLE_CHOICES),
    via: viaArb,
  }),
  {
    arbitrary: record({
      action: constantFrom(...ACTIONS),
      caller: callerArb,
      op: constantFrom("lifecycle" as const),
      target: constantFrom(...TARGETS),
      version: constantFrom<VersionChoice>(
        "current",
        "current",
        "stale",
        "missing",
        "malformed"
      ),
      via: viaArb,
    }),
    weight: 3,
  },
  record({
    caller: callerArb,
    oddity: constantFrom(...ODDITIES),
    op: constantFrom("oddity" as const),
    target: constantFrom<Target>("freeRole", "codeField", "baseClass"),
  })
);

/**
 * One deterministic step per required outcome, reached through the same
 * request path and checks as the random ones.
 */
const TARGETED: ReadonlyMap<string, Step> = new Map<string, Step>([
  [
    "201",
    {
      caller: "ada",
      child: false,
      id: "fresh",
      name: "fresh",
      op: "addField",
      required: false,
      type: "text",
      via: "changeSet",
    },
  ],
  [
    "200",
    {
      action: "relabel",
      caller: "ada",
      op: "lifecycle",
      target: "codeField",
      version: "current",
      via: "generic",
    },
  ],
  [
    "400 InvalidRequest",
    {
      caller: "ada",
      oddity: "malformedJson",
      op: "oddity",
      target: "freeRole",
    },
  ],
  [
    "400 UnknownField",
    {
      caller: "ada",
      oddity: "unknownColumn",
      op: "oddity",
      target: "freeRole",
    },
  ],
  [
    "ValidationFailed:ReadOnlyField",
    {
      caller: "ada",
      oddity: "readOnlyColumn",
      op: "oddity",
      target: "freeRole",
    },
  ],
  [
    "403 NotAllowed",
    {
      caller: "alice",
      child: false,
      id: "fresh",
      name: "fresh",
      op: "addField",
      required: false,
      type: "text",
      via: "changeSet",
    },
  ],
  [
    "404 UnknownTable",
    {
      action: "relabel",
      caller: "bob",
      op: "lifecycle",
      target: "codeField",
      version: "current",
      via: "generic",
    },
  ],
  [
    "404 NotFound",
    {
      action: "relabel",
      caller: "ada",
      op: "lifecycle",
      target: "missingRole",
      version: "current",
      via: "generic",
    },
  ],
  [
    "412 VersionConflict",
    {
      action: "relabel",
      caller: "ada",
      op: "lifecycle",
      target: "codeField",
      version: "stale",
      via: "generic",
    },
  ],
  [
    "428 VersionRequired",
    {
      action: "relabel",
      caller: "ada",
      op: "lifecycle",
      target: "codeField",
      version: "missing",
      via: "generic",
    },
  ],
  [
    "403 DefinitionProtected",
    {
      action: "rename",
      caller: "ada",
      op: "lifecycle",
      target: "coreUserClass",
      version: "current",
      via: "changeSet",
    },
  ],
  [
    "409 DependencyConflict",
    {
      action: "delete",
      caller: "ada",
      op: "lifecycle",
      target: "ruledRole",
      version: "current",
      via: "changeSet",
    },
  ],
  [
    "409 UseRetireOrPurge",
    {
      action: "delete",
      caller: "ada",
      op: "lifecycle",
      target: "codeField",
      version: "current",
      via: "generic",
    },
  ],
  [
    "403 PermissionRequired",
    {
      action: "purge",
      caller: "ada",
      op: "lifecycle",
      target: "oldField",
      version: "current",
      via: "changeSet",
    },
  ],
  [
    "409 PurgeRefused",
    {
      action: "purge",
      caller: "pam",
      op: "lifecycle",
      target: "titleField",
      version: "current",
      via: "changeSet",
    },
  ],
  [
    "PurgeRefused:hasRecords",
    {
      action: "purge",
      caller: "pam",
      op: "lifecycle",
      target: "retiredChildClass",
      version: "current",
      via: "changeSet",
    },
  ],
  [
    "409 ExistingDataViolates",
    {
      caller: "ada",
      fields: "title",
      id: "fresh",
      op: "addIndex",
      unique: true,
      via: "changeSet",
    },
  ],
  [
    "DefinitionInvalid:idInUse",
    {
      caller: "ada",
      id: "tombstone",
      name: "fresh",
      op: "createRole",
      via: "changeSet",
    },
  ],
  [
    "DefinitionInvalid:invalidName",
    {
      caller: "ada",
      id: "fresh",
      name: "invalid",
      op: "createRole",
      via: "changeSet",
    },
  ],
  [
    "DefinitionInvalid:duplicateName",
    {
      caller: "ada",
      id: "fresh",
      name: "taken",
      op: "createRole",
      via: "changeSet",
    },
  ],
  [
    "DefinitionInvalid:unknownDefinition",
    {
      caller: "ada",
      condition: "none",
      id: "fresh",
      op: "createRule",
      role: "hidden",
      via: "changeSet",
    },
  ],
  [
    "DefinitionInvalid:versionConflict",
    {
      action: "relabel",
      caller: "ada",
      op: "lifecycle",
      target: "freeRole",
      version: "stale",
      via: "changeSet",
    },
  ],
  [
    "DefinitionInvalid:invalidCondition",
    {
      caller: "ada",
      condition: "illTyped",
      id: "fresh",
      op: "createRule",
      role: "ruled",
      via: "changeSet",
    },
  ],
  [
    "DefinitionInvalid:invalidIndex",
    {
      caller: "ada",
      fields: "none",
      id: "fresh",
      op: "addIndex",
      unique: false,
      via: "changeSet",
    },
  ],
]);

/** Outcomes every run must reach, through random or targeted steps. */
const REQUIRED_OUTCOMES = [
  "201",
  "200",
  "400 InvalidRequest",
  "400 UnknownField",
  "ValidationFailed:ReadOnlyField",
  "403 NotAllowed",
  "404 UnknownTable",
  "404 NotFound",
  "412 VersionConflict",
  "428 VersionRequired",
  "403 DefinitionProtected",
  "409 DependencyConflict",
  "409 UseRetireOrPurge",
  "403 PermissionRequired",
  "409 PurgeRefused",
  "PurgeRefused:hasRecords",
  "409 ExistingDataViolates",
  "DefinitionInvalid:idInUse",
  "DefinitionInvalid:invalidName",
  "DefinitionInvalid:duplicateName",
  "DefinitionInvalid:unknownDefinition",
  "DefinitionInvalid:versionConflict",
  "DefinitionInvalid:invalidCondition",
  "DefinitionInvalid:invalidIndex",
];

/**
 * A read-deny rule hiding a role, by name, from admins: a core rule, the
 * only kind that applies to platform tables (decision 0014).
 *
 * @param nameFieldId - The ID of `core.role.name`.
 * @param name - The role's name.
 * @returns The operation.
 */
const hideRole = (nameFieldId: string, name: string): Operation =>
  addAccessRule(
    PLATFORM_CLASS_IDS.role,
    [BUILT_IN_ROLE_IDS.admin],
    {
      condition: {
        left: { path: [nameFieldId] },
        op: "eq",
        right: { value: name },
      },
    },
    { effect: "deny", owner: { layer: "core" } }
  ).op;

const PAM = { login: "fuzz-pam", password: "fuzz-pam-password" } as const;

const decodeRecordIds = Schema.decodeUnknownSync(Schema.Array(Schema.String));

/** Whether the purging admin exists in this file's database. */
let purgerCreated = false;

/** Creates the admin holding `schema.purge`, once per database. */
const createPurger = Effect.gen(function* createPurger() {
  if (purgerCreated) {
    return;
  }

  const catalog = yield* Catalog;
  const { request } = yield* Transactions;

  yield* request(
    Effect.gen(function* createPurgerUser() {
      return yield* createFixtureUser(yield* catalog.current, {
        active: true,
        login: PAM.login,
        name: "Fuzz Pam",
        password: PAM.password,
        roles: ["admin", "schema_purger"],
      });
    })
  ).pipe(Effect.orDie);

  purgerCreated = true;
});

/**
 * A world of its own, under names carrying a tag: the random phase
 * changes its world, so the targeted steps run on worlds nothing changed.
 *
 * @param worldTag - Letters for its names.
 * @returns The world.
 */
const prepare = Effect.fn("SchemaFuzz.prepare")(function* prepare(
  worldTag: string
) {
  const catalog = yield* Catalog;

  yield* ensureSite;

  const baseName = `fz_base_${worldTag}`;
  const childName = `fz_child_${worldTag}`;
  const shedName = `fz_shed_${worldTag}`;
  const ruledName = `fzruled${worldTag}`;
  const freeName = `fzfree${worldTag}`;
  const hiddenName = `fzhiddenrole${worldTag}`;
  const tombName = `fztombrole${worldTag}`;
  const base = createClass(baseName);
  const child = createClass(childName, { parentId: base.id });
  const shed = createClass(shedName, { parentId: base.id });
  const code = addField(base.id, "code", { kind: "text", maxLength: 40 });
  const title = addField(base.id, "title", { kind: "text" });
  const qty = addField(base.id, "qty", { kind: "integer" });
  const oldf = addField(base.id, "oldf", { kind: "text" });
  const tag = addField(child.id, "tag", { kind: "text" });
  const ruled = addRole(ruledName);
  const free = addRole(freeName);
  const hidden = addRole(hiddenName);
  const tomb = addRole(tombName);
  const rule = addAccessRule(base.id, [ruled.id], { description: "fz rule" });

  yield* change([
    base.op,
    child.op,
    shed.op,
    code.op,
    title.op,
    qty.op,
    oldf.op,
    tag.op,
    addIndex(base.id, [code.id], true).op,
    ruled.op,
    free.op,
    hidden.op,
    tomb.op,
    rule.op,
  ]);

  // Rows: a duplicate title, a null quantity, a value in the old field.
  const seeded = yield* insertRecords([`"site"."${baseName}"`], base.id, 3, {
    code: `'rvcode' || g`,
    oldf: `'${ROW_TOKENS.oldValue}'`,
    qty: "CASE WHEN g = 1 THEN NULL ELSE g END",
    title: `'${ROW_TOKENS.dupTitle}'`,
  });

  // Records of a child class keep rows in the base: purging the retired
  // child is refused while they exist (`PurgeRefused` `hasRecords`).
  const shedRecords = yield* insertRecords(
    [`"site"."${baseName}"`, `"site"."${shedName}"`],
    shed.id,
    2
  );

  const snapshot = yield* catalog.refresh;

  yield* change([
    { id: oldf.id, op: "retire", version: snapshot.get(oldf.id)?.version ?? 1 },
    {
      id: shed.id,
      op: "retire",
      version: snapshot.get(shed.id)?.version ?? 1,
    },
    { id: tomb.id, op: "delete", version: 1 },
  ]);

  const nameField =
    snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name")?.id ?? "";

  yield* applyChangeSet({
    operations: [hideRole(nameField, hiddenName)],
    origin: setOrigin({ layer: "core" }),
  });

  const [changeEntry = ""] = yield* values(
    `SELECT id::text AS value FROM core."change" ORDER BY id LIMIT 1`
  );

  return {
    baseId: base.id,
    changeEntry,
    childId: child.id,
    fields: {
      code: code.id,
      oldf: oldf.id,
      qty: qty.id,
      tag: tag.id,
      title: title.id,
    },
    freeRole: free.id,
    hiddenRole: hidden.id,
    hiddenRoleName: hiddenName,
    recordIds: new Set([
      ...decodeRecordIds(seeded),
      ...decodeRecordIds(shedRecords),
    ]),
    retiredChildId: shed.id,
    rowTokens: new Set([
      ROW_TOKENS.dupTitle,
      ROW_TOKENS.oldValue,
      "rvcode1",
      "rvcode2",
    ]),
    ruledRole: ruled.id,
    ruledRoleName: ruledName,
    siteDefinitions: new Set([
      base.id,
      child.id,
      shed.id,
      shedName,
      code.id,
      title.id,
      qty.id,
      oldf.id,
      tag.id,
      ruled.id,
      free.id,
      tomb.id,
      rule.id,
      baseName,
      childName,
      ruledName,
      freeName,
      tombName,
    ]),
    tombRole: tomb.id,
  } satisfies World;
});

/**
 * Signs in every caller and prepares a world.
 *
 * @param tag - The world's tag.
 * @returns The context.
 */
const setUp = Effect.fn("SchemaFuzz.setUp")(function* setUp(tag: string) {
  const http = yield* TestHttpClient;

  yield* AcmeFixture;
  yield* createPurger;

  const world = yield* prepare(tag);

  const tokens: Record<Caller, string> = {
    ada: yield* http.signIn("ada", "ada-password"),
    alice: yield* http.signIn("alice", "alice-password"),
    bob: yield* http.signIn("bob", "bob-password"),
    pam: yield* http.signIn(PAM.login, PAM.password),
  };

  return { http, outcomes: new Map(), tokens, world } satisfies FuzzContext;
});

const RUNS = 50;
const MAX_STEPS = 6;
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
 * @param context - Sessions, world and outcomes.
 * @param run - Runs an effect with the test's services.
 * @returns fast-check's result.
 */
const checkSequences = async (
  context: FuzzContext,
  run: (effect: Effect.Effect<boolean, unknown, Services>) => Promise<boolean>
) =>
  await check(
    asyncProperty(
      array(stepArb, { maxLength: MAX_STEPS, minLength: 1 }),
      async (steps) => await run(runSteps(context, steps))
    ),
    { endOnFailure: true, numRuns: RUNS }
  );

describe("schema-fuzz", () => {
  it("every required outcome has a targeted step", () => {
    assert.sameMembers([...TARGETED.keys()], REQUIRED_OUTCOMES);
    assert.isTrue(parseJson('{"a": 1}').ok);
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: TIMEOUT })(
    (dbTest) => {
      dbTest.effect(
        "every targeted step reaches its outcome",
        () =>
          Effect.gen(function* targeted() {
            const context = yield* setUp("tq");

            const missed: string[] = [];

            for (const [outcome, step] of TARGETED) {
              const response = yield* runStep(context, step);

              if (!outcomesOf(response).includes(outcome)) {
                missed.push(`${outcome}: ${response.status} ${response.text}`);
              }
            }

            assert.deepStrictEqual(missed, []);
          }),
        TIMEOUT
      );

      dbTest.effect(
        "fuzzed definition writes never return Postgres text or stored values, and refusals commit nothing",
        () =>
          Effect.gen(function* fuzz() {
            const context = yield* setUp("fz");
            const services = yield* Effect.context<Services>();
            const run = Effect.runPromiseWith(services);

            const result = yield* Effect.promise(
              async () => await checkSequences(context, run)
            );

            assert.isFalse(
              result.failed,
              `counterexample ${JSON.stringify(result.counterexample)} (seed ${result.seed}): ${String(result.errorInstance)}`
            );

            // The targeted phase: a step for every outcome the random
            // phase missed, through the same requests and checks, on a
            // world the random phase never touched.
            const missed = REQUIRED_OUTCOMES.filter(
              (outcome) => !context.outcomes.has(outcome)
            );

            const untouched: FuzzContext = {
              ...context,
              world: yield* prepare("gx"),
            };

            for (const outcome of missed) {
              const step = TARGETED.get(outcome);

              if (step !== undefined) {
                yield* runStep(untouched, step);
              }
            }

            for (const outcome of REQUIRED_OUTCOMES) {
              assert.isTrue(
                context.outcomes.has(outcome),
                `never reached ${outcome}: ${JSON.stringify([...context.outcomes])}`
              );
            }

            yield* Effect.logInfo(
              `schema-fuzz: ${RUNS} runs; outcomes the targeted phase reached: ${missed.join(", ") || "none"}`
            );
          }),
        TIMEOUT
      );
    }
  );
});
