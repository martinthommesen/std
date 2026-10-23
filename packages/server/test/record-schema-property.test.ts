/**
 * The `recordSchema` property test (plan Step 2, guarantee 2A; Contracts
 * 6.3): the browser and the server give the same verdict for every field
 * both see.
 *
 * Each run generates a table (with a child class) whose fields cover every
 * type of Contracts 6.5 the engine creates, with type settings, required
 * and read-only fields, constant defaults, choices with a hidden one and a
 * child-class subset, an auto-numbered field, a retired field and fields a
 * restricted tester may never read. It then generates create and update
 * bodies from edge pools (valid and invalid values of every type, null,
 * wrong JSON types, system and unknown names) and, for an admin and the
 * tester, sends each through the HTTP API (`POST`, `PATCH`) and through
 * `validateRecord` on the metadata the endpoint served the same caller.
 * Per field, the server's `ValidationFailed` `fieldErrors` (none on
 * success) must equal the browser's, and unknown names must agree. The
 * generated names are single lowercase words, so a definition name and its
 * API name are the same.
 *
 * Only checks Contracts 6.3 leaves to the server may differ: a condition
 * value's check against the caller's view of its table
 * (`invalidCondition`), uniqueness (`notUnique`) and reference targets
 * (`InvalidReference`, after validation passed).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { TableMetadata } from "@std/api/table-metadata";
import type { AccessRuleDraft, ChoiceDraft } from "@std/definitions/definition";
import { FieldErrorSchema } from "@std/definitions/field-errors";
import type { FieldError } from "@std/definitions/field-errors";
import type { Operation } from "@std/definitions/operation";
import { validateRecord } from "@std/definitions/record-schema";
import type { RecordMode, StoredRecord } from "@std/definitions/record-schema";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import type { FieldType } from "@std/values/field-type";
import { parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import {
  array,
  asyncProperty,
  boolean,
  check,
  constantFrom,
  integer,
  subarray,
  tuple,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import {
  AcmeFixture,
  createFixtureUser,
} from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { numberOf, textOf } from "./api-support.ts";
import {
  fetchMetadata,
  readsTestLayer,
  recordPath,
  resourceOf,
} from "./reads-support.ts";
import {
  addField,
  addOverride,
  change,
  createClass,
  ensureSite,
  freshId,
} from "./schema-support.ts";
import { create, patch } from "./writes-support.ts";

/** A table's metadata, as the caller reads it. */
type MetaTable = typeof TableMetadata.Type;

const RUNS = 25;
const local = { owner: { layer: "local" }, protected: false } as const;

/** The kinds generated, every type the engine creates (Contracts 6.5). */
const KINDS = [
  "text",
  "longText",
  "integer",
  "bigInteger",
  "decimal",
  "boolean",
  "date",
  "dateTime",
  "choice",
  "reference",
  "uuid",
  "password",
  "json",
  "condition",
] as const;

type Kind = (typeof KINDS)[number];

/** One generated field. */
interface FieldSpec {
  readonly kind: Kind;
  readonly type: FieldType;
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly useDefault: boolean;
  readonly retire: boolean;
  readonly hiddenFromTester: boolean;
  /** Choice fields: the child class's subset, or null. */
  readonly childSubset: readonly string[] | null;
  /** The child class narrows a text field's max length to this. */
  readonly childMaxLength: number | null;
}

/** One generated body: field index to pooled value index. */
type BodySpec = readonly (readonly [number, number])[];

/** A generated table and its bodies. */
interface TableSpec {
  readonly fields: readonly FieldSpec[];
  readonly autoNumber: boolean;
  readonly bodies: readonly {
    readonly values: BodySpec;
    readonly extra: "none" | "system" | "unknown";
  }[];
}

const CHOICE_KEYS = ["alpha", "beta", "gamma"] as const;
const SOME_UUID = "0192f6a1-7b2c-7d3e-8f40-123456789abc";

const typeArb = (kind: Kind): Arbitrary<FieldType> => {
  switch (kind) {
    case "text": {
      return tuple(constantFrom(undefined, 1, 3, 10), boolean()).map(
        ([maxLength, caseSensitive]) =>
          maxLength === undefined
            ? { caseSensitive, kind: "text" }
            : { caseSensitive, kind: "text", maxLength }
      );
    }

    case "longText": {
      return constantFrom<FieldType>(
        { kind: "longText" },
        { kind: "longText", maxLength: 5 }
      );
    }

    case "integer": {
      return constantFrom<FieldType>(
        { kind: "integer" },
        { kind: "integer", max: 10, min: 0 },
        { kind: "integer", min: -5 }
      );
    }

    case "bigInteger": {
      return constantFrom<FieldType>(
        { kind: "bigInteger" },
        {
          kind: "bigInteger",
          max: "9007199254740993",
          min: "-9007199254740993",
        }
      );
    }

    case "decimal": {
      return constantFrom<FieldType>(
        { kind: "decimal", precision: 5, scale: 2 },
        { kind: "decimal", max: "99.99", min: "-1.5", precision: 5, scale: 2 },
        { kind: "decimal", precision: 3, scale: 0 },
        { kind: "decimal", precision: 10, scale: 4 }
      );
    }

    case "reference": {
      return constantFrom<FieldType>({
        kind: "reference",
        targetClassId: USER_CLASS_ID,
      });
    }

    case "condition": {
      return constantFrom<FieldType>({
        classId: ACME.asset,
        kind: "condition",
        profile: "filter",
      });
    }

    case "boolean":
    case "choice":
    case "date":
    case "dateTime":
    case "json":
    case "password":
    case "uuid": {
      return constantFrom<FieldType>({ kind });
    }

    default: {
      return kind satisfies never;
    }
  }
};

const fieldArb: Arbitrary<FieldSpec> = constantFrom(...KINDS).chain((kind) =>
  tuple(
    typeArb(kind),
    integer({ max: 9, min: 0 }),
    integer({ max: 9, min: 0 }),
    constantFrom<readonly string[] | null>(null, ["alpha", "gamma"], ["alpha"])
  ).map(([type, dice, other, subset]): FieldSpec => {
    const writable = kind !== "boolean";
    const readOnly = dice === 0;
    const retire = dice === 1;

    const textMax = type.kind === "text" ? (type.maxLength ?? 255) : Number.NaN;

    return {
      childMaxLength: type.kind === "text" && textMax >= 3 ? 2 : null,
      childSubset: kind === "choice" ? subset : null,
      hiddenFromTester: other === 0,
      kind,
      readOnly,
      required: writable && !readOnly && !retire && dice >= 7,
      retire,
      type,
      useDefault: other >= 6,
    };
  })
);

// Values sent per kind: valid, invalid and edge ones (Contracts 5.5, 6.5).
const POOLS: Readonly<Record<Kind, readonly JsonValue[]>> = {
  bigInteger: ["0", "9007199254740993", "-9007199254740994", 5, "1.0", "x"],
  boolean: [true, false, "true"],
  choice: ["alpha", "beta", "gamma", "delta", "Alpha", "_x", 1],
  condition: [
    { op: "true" },
    { op: "bogus" },
    {},
    5,
    {
      left: { path: ["00000000-0000-4000-8000-000000000000"] },
      op: "eq",
      right: { value: "x" },
    },
  ],
  date: ["2024-02-29", "2023-02-29", "0001-01-01", "9999-12-31", "2024-1-1", 1],
  dateTime: [
    "2026-10-20T10:15:30.123+02:00",
    "2026-10-20T08:15:30.1234Z",
    "2026-10-20T23:59:60Z",
    "2026-10-20",
    0,
  ],
  decimal: ["1.005", "1.50", "-0", "99.99", "100", "-1.6", 1.5, "x", "0.1"],
  integer: [0, 5, 11, -6, 1.5, 2_147_483_648, "5"],
  json: [{ a: 1 }, [1, 2], "s", 0.1, { b: { c: [null] } }, 1e300],
  longText: ["", "a\r\nb", "abcdefgh", "   ", 5],
  password: ["secret", "", 5, "a\u0000b"],
  reference: ["<admin>", SOME_UUID, "<ADMIN>", "nope", 3],
  text: [
    "",
    "  ",
    "a",
    "abc",
    "abcdefghijk",
    "ü",
    "line\nbreak",
    "a\u0000",
    "Straße",
    7,
  ],
  uuid: [SOME_UUID, SOME_UUID.toUpperCase(), "not-a-uuid", 1],
};

// Pool entries standing for the admin's user ID (a visible target).
const PLACEHOLDERS: ReadonlyMap<JsonValue, (admin: string) => string> = new Map(
  [
    ["<admin>", (admin: string) => admin],
    ["<ADMIN>", (admin: string) => admin.toUpperCase()],
  ]
);

const valueIndexArb = integer({ max: 10, min: -1 });

const bodyArb = (fieldCount: number) =>
  tuple(
    subarray(
      Array.from({ length: fieldCount }, (_, index) => index),
      { minLength: 0 }
    ).chain((indexes) =>
      tuple(
        ...indexes.map((index) => tuple(constantFrom(index), valueIndexArb))
      )
    ),
    constantFrom<"none" | "system" | "unknown">(
      "none",
      "none",
      "none",
      "none",
      "system",
      "unknown"
    )
  ).map(([values, extra]) => ({ extra, values }));

const tableArb: Arbitrary<TableSpec> = array(fieldArb, {
  maxLength: 9,
  minLength: 3,
}).chain((fields) =>
  tuple(
    boolean(),
    array(bodyArb(fields.length), { maxLength: 10, minLength: 6 })
  ).map(([autoNumber, bodies]) => ({ autoNumber, bodies, fields }))
);

/** Safe valid values under every generated field setting, for base records. */
const SAFE_VALUES: Readonly<Record<Kind, JsonValue>> = {
  bigInteger: "7",
  boolean: true,
  choice: "alpha",
  condition: { op: "true" },
  date: "2024-02-29",
  dateTime: "2026-10-20T08:15:30.123Z",
  decimal: "1",
  integer: 5,
  json: { a: 1 },
  longText: "a",
  password: "secret",
  reference: "<admin>",
  text: "a",
  uuid: SOME_UUID,
};

// Constant defaults that are valid under every generated setting.
const DEFAULTS: ReadonlyMap<Kind, JsonValue> = new Map<Kind, JsonValue>([
  ["integer", 5],
  ["boolean", true],
  ["choice", "alpha"],
  ["date", "2024-02-29"],
]);

const defaultOf = (field: FieldSpec): JsonValue | null => {
  if (!field.useDefault || field.retire) {
    return null;
  }

  if (field.type.kind === "text") {
    return (field.type.maxLength ?? 255) >= 2 ? "ab" : null;
  }

  return DEFAULTS.get(field.kind) ?? null;
};

/** What one generated table became. */
interface BuiltTable {
  readonly root: string;
  readonly child: string;
  readonly names: readonly string[];
}

let tableCounter = 0;

const buildTable = Effect.fn("RecordSchemaProperty.buildTable")(
  function* buildTable(spec: TableSpec, testerRole: string) {
    tableCounter += 1;

    const root = createClass(`pt${tableCounter}`);
    const child = createClass(`pt${tableCounter}_c`, { parentId: root.id });
    const names = spec.fields.map((_, index) => `f${index}`);
    const operations: Operation[] = [root.op, child.op];
    const ids: string[] = [];
    const later: Operation[] = [];

    for (const [index, field] of spec.fields.entries()) {
      const added = addField(root.id, names[index] ?? `f${index}`, field.type, {
        default: defaultOf(field),
        readOnly: field.readOnly,
        required: field.required,
      });

      ids.push(added.id);
      operations.push(added.op);

      if (field.kind === "choice") {
        for (const [order, key] of CHOICE_KEYS.entries()) {
          const definition: ChoiceDraft = {
            ...local,
            fieldId: added.id,
            hidden: key === "gamma",
            id: freshId(),
            key,
            kind: "choice",
            label: key,
            order: order + 1,
          };

          operations.push({ definition, op: "createChoice" });
        }
      }

      const subset = field.childSubset;
      const narrow = field.childMaxLength;

      if (subset !== null || narrow !== null) {
        operations.push(
          addOverride(child.id, added.id, {
            choices: subset,
            maxLength: narrow,
          }).op
        );
      }

      if (field.retire) {
        later.push({ id: added.id, op: "retire", version: 1 });
      }
    }

    if (spec.autoNumber) {
      operations.push(
        addField(root.id, "num", { kind: "text" }, { numberPrefix: "PT" }).op
      );
    }

    const rule = (
      effect: "allow" | "deny",
      target: AccessRuleDraft["target"],
      actions: AccessRuleDraft["actions"]
    ): Operation => ({
      definition: {
        ...local,
        actions,
        active: true,
        classId: root.id,
        condition: null,
        description: null,
        effect,
        id: freshId(),
        kind: "accessRule",
        name: null,
        roleIds: [testerRole],
        target,
      },
      op: "createAccessRule",
    });

    const hidden = ids.filter(
      (_, index) => spec.fields[index]?.hiddenFromTester === true
    );

    operations.push(
      rule("allow", { kind: "records" }, ["read", "create", "update"]),
      rule("allow", { fields: "*", kind: "fields" }, [
        "read",
        "create",
        "update",
      ])
    );

    if (hidden.length > 0) {
      operations.push(
        rule("deny", { fields: hidden, kind: "fields" }, ["read"])
      );
    }

    yield* change(operations);

    if (later.length > 0) {
      yield* change(later);
    }

    return {
      child: `site.pt${tableCounter}_c`,
      names: [...names, ...(spec.autoNumber ? ["num"] : [])],
      root: `site.pt${tableCounter}`,
    } satisfies BuiltTable;
  }
);

const metadataOf = Effect.fn("RecordSchemaProperty.metadataOf")(
  function* metadataOf(token: string, table: string) {
    const { body } = yield* fetchMetadata(token, table);

    return body;
  }
);

/** A verdict: per field, its sorted error codes; and unknown names. */
interface Verdict {
  readonly fields: Readonly<Record<string, string>>;
  readonly unknown: readonly string[];
  /**
   * The server refused the body before any field (`InvalidRequest`): its
   * JSON parser refuses U+0000 in any string and numbers a double does not
   * hold exactly (Contracts 6.5).
   */
  readonly bodyRefused?: true;
}

// Field errors only the server can give: a condition value checked
// against the caller's view of its table, and uniqueness.
const SERVER_ONLY_CODES = [
  "InvalidValue:invalidCondition",
  "InvalidValue:notUnique",
] as const;

/**
 * Whether the browser's verdict agrees with the server's. When the server's
 * JSON parser refused the whole body, the browser must refuse every field
 * whose value that parser refuses (the web app never sends such a body).
 *
 * @param server - The server's verdict.
 * @param browser - `validateRecord`'s verdict.
 * @param body - The body sent.
 * @returns True when they agree.
 */
const agrees = (
  server: Verdict,
  browser: Verdict,
  body: JsonObject
): boolean => {
  if (server.bodyRefused === true) {
    const holding = Object.entries(body).flatMap(([name, value]) =>
      parseJson(JSON.stringify(value)).ok ? [] : [name]
    );

    return (
      holding.length > 0 &&
      holding.every((name) => browser.fields[name] !== undefined)
    );
  }

  if (JSON.stringify(server.unknown) !== JSON.stringify(browser.unknown)) {
    return false;
  }

  const names = new Set([
    ...Object.keys(server.fields),
    ...Object.keys(browser.fields),
  ]);

  // A field the server refused with a check only it can make is left out:
  // the browser cannot know that verdict (Contracts 6.3).
  return [...names].every(
    (name) =>
      SERVER_ONLY_CODES.some(
        (code) => server.fields[name]?.includes(code) === true
      ) || server.fields[name] === browser.fields[name]
  );
};

const codeOf = (error: FieldError): string =>
  error._tag === "InvalidValue" ? `InvalidValue:${error.reason}` : error._tag;

const byField = (errors: readonly FieldError[]): Record<string, string> => {
  const grouped: Record<string, string[]> = {};

  for (const error of errors) {
    const codes = grouped[error.field] ?? [];

    codes.push(codeOf(error));
    grouped[error.field] = codes;
  }

  return Object.fromEntries(
    Object.entries(grouped).map(([field, codes]) => [
      field,
      codes.toSorted().join(","),
    ])
  );
};

const ServerErrorSchema = Schema.Union([
  Schema.Struct({
    code: Schema.Literal("ValidationFailed"),
    fieldErrors: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ code: Schema.Literal("UnknownField"), field: Schema.String }),
  Schema.Struct({ code: Schema.Literal("InvalidReference") }),
  Schema.Struct({
    code: Schema.Literal("InvalidRequest"),
    parameter: Schema.Literal("body"),
  }),
]);

const FieldErrorsSchema = Schema.Array(FieldErrorSchema);

// The API spells the system member `version` as `revision` (Contracts
// 10.2); the browser knows it by its definition name.
const definitionNamed = (error: FieldError): FieldError =>
  error.field === "revision" ? { ...error, field: "version" } : error;

const serverVerdict = (status: number, body: JsonValue | undefined) =>
  Effect.gen(function* verdictOfResponse() {
    if (status === 200 || status === 201) {
      return { fields: {}, unknown: [] } satisfies Verdict;
    }

    const error = yield* Schema.decodeUnknownEffect(ServerErrorSchema)(
      body
    ).pipe(
      Effect.mapError(
        () => new Error(`unexpected ${status} ${JSON.stringify(body)}`)
      ),
      Effect.orDie
    );

    if (error.code === "InvalidRequest") {
      return { bodyRefused: true, fields: {}, unknown: [] } satisfies Verdict;
    }

    if (error.code === "UnknownField") {
      return { fields: {}, unknown: [error.field] } satisfies Verdict;
    }

    if (error.code === "InvalidReference") {
      return { fields: {}, unknown: [] } satisfies Verdict;
    }

    const errors = yield* Schema.decodeUnknownEffect(FieldErrorsSchema)(
      error.fieldErrors
    ).pipe(Effect.orDie);

    return {
      fields: byField(errors.map(definitionNamed)),
      unknown: [],
    } satisfies Verdict;
  });

const browserVerdict = (
  table: MetaTable,
  mode: RecordMode,
  body: JsonObject,
  stored?: StoredRecord,
  through?: MetaTable
): Verdict => {
  const verdict = validateRecord(
    table,
    mode,
    body,
    stored,
    through === undefined ? {} : { through }
  );

  return {
    fields: byField(verdict.errors),
    unknown: verdict.unknownFields.slice(0, 1),
  };
};

const bodyOf = (
  spec: TableSpec,
  built: BuiltTable,
  body: TableSpec["bodies"][number],
  table: MetaTable,
  admin: string
): JsonObject => {
  const visible = new Set(table.fields.map((field) => field.name));
  const values: Record<string, JsonValue> = {};

  for (const [index, pick] of body.values) {
    const field = spec.fields[index];
    const name = built.names[index];

    if (field !== undefined && name !== undefined && visible.has(name)) {
      const pool = POOLS[field.kind];
      const raw = pick < 0 ? null : (pool[pick % pool.length] ?? null);

      values[name] = PLACEHOLDERS.get(raw)?.(admin) ?? raw;
    }
  }

  if (body.extra === "system") {
    values.version = 1;
  } else if (body.extra === "unknown") {
    values.no_such_field = 1;
  }

  return values;
};

/**
 * A base record's body: a safe value for every required field.
 *
 * @param spec - The table.
 * @param built - Its names.
 * @param admin - The admin's user ID.
 * @returns The body.
 */
const baseBody = (
  spec: TableSpec,
  built: BuiltTable,
  admin: string
): JsonObject =>
  Object.fromEntries(
    spec.fields.flatMap((field, index) =>
      field.required
        ? [
            [
              built.names[index] ?? "",
              PLACEHOLDERS.get(SAFE_VALUES[field.kind])?.(admin) ??
                SAFE_VALUES[field.kind],
            ],
          ]
        : []
    )
  );

/** A stored record as the browser's `validateRecord` and the test read it. */
interface Stored extends StoredRecord {
  readonly id: string;
  /** The resource's revision, for `If-Match`. */
  readonly version: number;
}

// A reference as the browser's stored values hold it: the target's ID, not
// the resource's EntityRef.
const storedValueOf = (
  field: MetaTable["fields"][number],
  resource: JsonObject
): JsonValue => {
  const value = resource[field.apiName] ?? null;

  return field.type.kind === "reference" && isJsonObject(value)
    ? (value.id ?? null)
    : value;
};

const storedOf = Effect.fn("RecordSchemaProperty.storedOf")(function* storedOf(
  token: string,
  table: string,
  id: string,
  meta: MetaTable
) {
  const http = yield* TestHttpClient;
  const names = meta.fields.map((field) => field.apiName);

  // Every field is selected explicitly, so retired ones are delivered too.
  // A caller who can read no field has nothing to select: an empty `fields`
  // is a malformed parameter (`400 InvalidRequest`), so the default
  // selection (empty for that caller) is read instead.
  const response = yield* http.get(
    recordPath(
      table,
      id,
      names.length === 0 ? {} : { fields: names.join(",") }
    ),
    { token }
  );

  const resource = yield* resourceOf(response);
  const revision = numberOf(resource.revision);

  return {
    class: meta.name,
    id,
    values: Object.fromEntries(
      meta.fields.map((field) => [field.name, storedValueOf(field, resource)])
    ),
    version: revision,
  } satisfies Stored;
});

/** One disagreement, for the failure message. */
interface Mismatch {
  readonly who: string;
  readonly table: string;
  readonly mode: RecordMode;
  readonly body: JsonObject;
  readonly server: Verdict;
  readonly browser: Verdict;
}

/** What every comparison of a run shares. */
interface RunContext {
  readonly tokens: Readonly<Record<"admin" | "tester", string>>;
  readonly adminId: string;
  readonly testerRole: string;
  readonly mismatches: Mismatch[];
  readonly compared: {
    count: number;
    refused: number;
    readonly codes: Set<string>;
  };
}

/**
 * Records one comparison and any disagreement.
 *
 * @param context - The run's observations.
 * @param mismatch - The comparison.
 * @param status - The server's status.
 */
const observe = (
  context: RunContext,
  mismatch: Mismatch,
  status: number
): void => {
  context.compared.count += 1;
  context.compared.refused += status === 200 || status === 201 ? 0 : 1;

  for (const code of Object.values(mismatch.server.fields)) {
    context.compared.codes.add(code);
  }

  if (!agrees(mismatch.server, mismatch.browser, mismatch.body)) {
    context.mismatches.push(mismatch);
  }
};

/** One caller's comparisons on one table. */
interface Target {
  readonly who: "admin" | "tester";
  readonly table: string;
  readonly baseId: string;
}

const compareBody = Effect.fn("RecordSchemaProperty.compareBody")(
  function* compareBody(
    context: RunContext,
    target: Target,
    meta: MetaTable,
    values: JsonObject
  ) {
    const { baseId, table, who } = target;
    const token = context.tokens[who];
    const created = yield* create(token, table, values);

    observe(
      context,
      {
        body: values,
        browser: browserVerdict(meta, "create", values),
        mode: "create",
        server: yield* serverVerdict(created.status, created.json),
        table,
        who,
      },
      created.status
    );

    const stored = yield* storedOf(token, table, baseId, meta);
    const updated = yield* patch(token, table, baseId, stored.version, values);

    observe(
      context,
      {
        body: values,
        browser: browserVerdict(meta, "update", values, stored),
        mode: "update",
        server: yield* serverVerdict(updated.status, updated.json),
        table,
        who,
      },
      updated.status
    );
  }
);

/** A child record updated through its parent's endpoint. */
interface ThroughParent {
  readonly spec: TableSpec;
  readonly tables: BuiltTable;
  readonly id: string;
  readonly parent: MetaTable;
  readonly child: MetaTable;
}

const compareThroughParent = Effect.fn(
  "RecordSchemaProperty.compareThroughParent"
)(function* compareThroughParent(
  context: RunContext,
  who: "admin" | "tester",
  input: ThroughParent
) {
  const token = context.tokens[who];
  const table = input.tables.root;

  for (const body of input.spec.bodies) {
    const values = bodyOf(
      input.spec,
      input.tables,
      body,
      input.parent,
      context.adminId
    );

    const stored = yield* storedOf(
      token,
      input.tables.child,
      input.id,
      input.child
    );

    const updated = yield* patch(
      token,
      table,
      input.id,
      stored.version,
      values
    );

    observe(
      context,
      {
        body: values,
        browser: browserVerdict(
          input.child,
          "update",
          values,
          stored,
          input.parent
        ),
        mode: "update",
        server: yield* serverVerdict(updated.status, updated.json),
        table: `${table} (a ${input.tables.child} record)`,
        who,
      },
      updated.status
    );
  }
});

const runTable = Effect.fn("RecordSchemaProperty.runTable")(function* runTable(
  spec: TableSpec,
  context: RunContext
) {
  const built = yield* buildTable(spec, context.testerRole);
  const { adminId, tokens } = context;

  const compareTable = Effect.fn("RecordSchemaProperty.compareTable")(
    function* compareTable(table: string) {
      const base = yield* create(
        tokens.admin,
        table,
        baseBody(spec, built, adminId)
      );

      assert.strictEqual(base.status, 201, `base record: ${base.text}`);
      const baseId = textOf((yield* resourceOf(base)).id);

      const metadata = {
        admin: yield* metadataOf(tokens.admin, table),
        tester: yield* metadataOf(tokens.tester, table),
      };

      for (const who of ["admin", "tester"] as const) {
        const meta = metadata[who];

        for (const body of spec.bodies) {
          yield* compareBody(
            context,
            { baseId, table, who },
            meta,
            bodyOf(spec, built, body, meta, adminId)
          );
        }
      }

      return { baseId, metadata };
    }
  );

  const parent = yield* compareTable(built.root);
  const child = yield* compareTable(built.child);

  // Updates of a child record through the parent endpoint use its effective
  // schema (overrides) and the parent's names. Record writes do not change metadata.
  for (const who of ["admin", "tester"] as const) {
    yield* compareThroughParent(context, who, {
      child: child.metadata[who],
      id: child.baseId,
      parent: parent.metadata[who],
      spec,
      tables: built,
    });
  }
});

/**
 * Runs the property: one generated table per run, each compared in full.
 *
 * @param run - Runs an effect with the test's services.
 * @param context - Tokens, IDs and the observations.
 * @returns fast-check's details.
 */
const checkTables = async (
  run: (effect: ReturnType<typeof runTable>) => Promise<void>,
  context: RunContext
) =>
  await check(
    asyncProperty(tableArb, async (spec) => {
      const before = context.mismatches.length;

      await run(runTable(spec, context));

      return context.mismatches.length === before;
    }),
    { endOnFailure: true, numRuns: RUNS }
  );

const setup = Effect.gen(function* setupTester() {
  yield* ensureSite;

  const role = freshId();

  yield* change([
    {
      definition: {
        ...local,
        helpText: null,
        id: role,
        kind: "role",
        label: "Tester",
        name: "tester",
      },
      op: "createRole",
    },
  ]);

  const snapshot = yield* (yield* Catalog).refresh;
  const { request } = yield* Transactions;

  yield* request(
    createFixtureUser(snapshot, {
      active: true,
      login: "tester",
      name: "Tester",
      password: "tester-password",
      roles: ["tester"],
    })
  ).pipe(Effect.orDie);

  const http = yield* TestHttpClient;

  return {
    adminId: (yield* AcmeFixture).admin.id,
    testerRole: role,
    tokens: {
      admin: yield* http.signIn("ada", "ada-password"),
      tester: yield* http.signIn("tester", "tester-password"),
    },
  };
});

/** Verdicts every run of the suite must reach on the server. */
const REQUIRED_CODES = [
  "Required",
  "ReadOnlyField",
  "DefinitionRetired",
  "InvalidValue:wrongJsonType",
  "InvalidValue:tooLong",
  "InvalidValue:inexactScale",
  "InvalidValue:invalidDate",
  "InvalidValue:invalidUuid",
  "InvalidValue:unknownChoice",
  "InvalidValue:retiredChoice",
  "InvalidValue:emptyNotAllowed",
  "InvalidValue:nullNotAllowed",
] as const;

const plainField = (
  kind: Kind,
  type: FieldType,
  options: Partial<FieldSpec> = {}
): FieldSpec => ({
  childMaxLength: null,
  childSubset: null,
  hiddenFromTester: false,
  kind,
  readOnly: false,
  required: false,
  retire: false,
  type,
  useDefault: false,
  ...options,
});

/**
 * Regression for seed -936010053: a table whose every field the restricted
 * user cannot read. Its metadata has no fields, and the stored record of an
 * update must still be read (with the default selection, not `fields=`).
 */
const ALL_HIDDEN_TABLE: TableSpec = {
  autoNumber: false,
  bodies: [
    { extra: "none", values: [] },
    { extra: "unknown", values: [] },
  ],
  fields: [
    plainField("text", { kind: "text" }, { hiddenFromTester: true }),
    plainField("integer", { kind: "integer" }, { hiddenFromTester: true }),
    plainField("boolean", { kind: "boolean" }, { hiddenFromTester: true }),
  ],
};

/**
 * The targeted phase: one fixed table whose bodies reach every verdict of
 * `REQUIRED_CODES`, compared like the random tables. Random runs reach most
 * of them; this makes the coverage gate independent of the seed, as the
 * error fuzz's targeted phase does (decision 0014).
 */
const COVERAGE_TABLE: TableSpec = {
  autoNumber: false,
  bodies: [
    // null boolean, required text emptied, hidden choice, empty password
    {
      extra: "none",
      values: [
        [0, -1],
        [1, 0],
        [5, 2],
        [6, 1],
      ],
    },
    // wrong JSON type, too long, inexact scale, invalid date, invalid UUID,
    // unknown choice, read-only and retired fields written
    {
      extra: "none",
      values: [
        [0, 2],
        [1, 4],
        [2, 0],
        [3, 1],
        [4, 2],
        [5, 3],
        [7, 2],
        [8, 2],
      ],
    },
  ],
  fields: [
    plainField("boolean", { kind: "boolean" }),
    plainField("text", { kind: "text", maxLength: 3 }, { required: true }),
    plainField("decimal", { kind: "decimal", precision: 10, scale: 2 }),
    plainField("date", { kind: "date" }),
    plainField("uuid", { kind: "uuid" }),
    plainField("choice", { kind: "choice" }),
    plainField("password", { kind: "password" }),
    plainField("text", { kind: "text" }, { readOnly: true }),
    plainField("text", { kind: "text" }, { retire: true }),
  ],
};

describe("recordSchema property", () => {
  it("covers every type of Contracts 6.5 the engine creates", () => {
    assert.lengthOf(KINDS, 14);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "browser and server give the same verdict per field",
      () =>
        Effect.gen(function* property() {
          const prepared = yield* setup;
          const mismatches: Mismatch[] = [];
          const compared = { codes: new Set<string>(), count: 0, refused: 0 };
          const context = { ...prepared, compared, mismatches };

          const services =
            yield* Effect.context<
              Effect.Services<ReturnType<typeof runTable>>
            >();

          const run = Effect.runPromiseWith(services);

          const result = yield* Effect.promise(
            async () => await checkTables(run, context)
          );

          yield* runTable(COVERAGE_TABLE, context);
          yield* runTable(ALL_HIDDEN_TABLE, context);

          assert.deepStrictEqual(mismatches, []);
          assert.isFalse(
            result.failed,
            `${JSON.stringify(mismatches.slice(0, 3), null, 1)} ${String(result.errorInstance)} (seed ${result.seed})`
          );

          // Not vacuous: many comparisons, and many of them refusals.
          assert.isAbove(compared.count, 500);
          assert.isAbove(compared.refused, 100);

          // Every kind of verdict was reached on the server and matched.
          const reached = [...compared.codes].join(" ");

          for (const code of REQUIRED_CODES) {
            assert.include(reached, code);
          }
        }),
      { timeout: 600_000 }
    );
  });
});
