/**
 * `recordSchema` and `validateRecord` (Contracts 6.3) on hand-written
 * metadata: per-field issues at the field's name, the create, update and
 * read modes, and name resolution. The agreement with the server is the
 * server's `record-schema-property` test.
 */
import { assert, describe, it } from "@effect/vitest";
import { isFailure, isSuccess } from "effect/Result";
import { decodeUnknownResult } from "effect/Schema";

import type { FieldError } from "../src/field-errors.ts";
import { recordSchema, validateRecord } from "../src/record-schema.ts";
import type { MetaField, MetaTable } from "../src/table-metadata.ts";

const field = (
  name: string,
  type: MetaField["type"],
  extra: Partial<MetaField> = {}
): MetaField => ({
  autoNumber: null,
  choices: null,
  default: null,
  helpText: null,
  id: `00000000-0000-4000-8000-${name.padStart(12, "0")}`,
  inheritedFrom: null,
  label: name,
  name,
  nullable: type.kind !== "boolean",
  read: "yes",
  readOnly: false,
  required: false,
  state: "active",
  type,
  write: { create: "yes", update: "yes" },
  ...extra,
});

const table: MetaTable = {
  ancestors: [],
  creatable: true,
  displayField: "title",
  fields: [
    field("title", { kind: "text", maxLength: 5 }, { required: true }),
    field("cost", { kind: "decimal", precision: 5, scale: 2 }),
    field(
      "status",
      { kind: "choice" },
      {
        choices: [
          { key: "open", label: "Open", order: 1, retired: false },
          { key: "old", label: "Old", order: 2, retired: true },
        ],
      }
    ),
    field(
      "code",
      { kind: "text" },
      { autoNumber: { prefix: "T" }, readOnly: true }
    ),
    field("gone", { kind: "integer" }, { state: "retired" }),
    field("secret", { kind: "password" }),
  ],
  formRules: [],
  helpText: null,
  id: "00000000-0000-4000-8000-000000000001",
  label: "T",
  layouts: { form: null, list: null },
  name: "site.t",
  relatedLists: [],
};

const codes = (errors: readonly FieldError[]): string[] =>
  errors.map((error) =>
    error._tag === "InvalidValue"
      ? `${error.field}:${error.reason}`
      : `${error.field}:${error._tag}`
  );

describe(recordSchema, () => {
  it("validates the complete JSON body before returning field errors", () => {
    for (const body of [
      null,
      [1],
      Object.fromEntries<string | undefined>([
        ["nope", undefined],
        ["title", "too long"],
      ]),
      { nope: { nested: () => 1 }, title: "too long" },
    ]) {
      assert.deepStrictEqual(validateRecord(table, "create", body), {
        errors: [],
        invalidBody: true,
        unknownFields: [],
      });
      assert.isTrue(
        isFailure(decodeUnknownResult(recordSchema(table, "create"))(body))
      );
    }
  });

  it("checks update metadata before a malformed body", () => {
    assert.throws(() => {
      validateRecord(table, "update", null);
    }, /an update needs the stored record/u);
    assert.throws(() => {
      validateRecord(table, "update", null, {
        class: "site.other",
        values: {},
      });
    }, /metadata of site.other/u);
    assert.throws(() => {
      validateRecord(
        table,
        "update",
        null,
        { class: table.name, values: {} },
        {
          through: { ...table, name: "site.other" },
        }
      );
    }, /cannot be updated through site.other/u);
  });

  it("reports each failing field at its name", () => {
    const schema = recordSchema(table, "create");

    assert.isTrue(
      isFailure(decodeUnknownResult(schema)({ cost: "1.005", title: "long!!" }))
    );
    assert.isTrue(isSuccess(decodeUnknownResult(schema)({ title: "ok" })));
  });

  it("gives the create verdict per field", () => {
    const verdict = validateRecord(table, "create", {
      code: "T0000001",
      cost: "1.005",
      gone: 1,
      status: "old",
    });

    assert.deepStrictEqual(codes(verdict.errors), [
      "title:Required",
      "cost:inexactScale",
      "status:retiredChoice",
      "code:ReadOnlyField",
      "gone:DefinitionRetired",
    ]);

    // An auto-numbered field sent as null is not written.
    assert.deepStrictEqual(
      validateRecord(table, "create", { code: null, title: "a" }).errors,
      []
    );
  });

  it("keeps an unchanged retired choice and ignores a no-op update", () => {
    const stored = {
      class: "site.t",
      values: { code: "T0000001", status: "old", title: "a" },
    };

    assert.deepStrictEqual(
      validateRecord(table, "update", { status: "old", title: "a" }, stored)
        .errors,
      []
    );
    assert.deepStrictEqual(
      codes(
        validateRecord(table, "update", { code: "T2", title: "" }, stored)
          .errors
      ),
      ["title:Required", "code:ReadOnlyField"]
    );
    // A field withheld on the record counts as written.
    assert.deepStrictEqual(
      codes(
        validateRecord(
          table,
          "update",
          { code: "T0000001" },
          { class: "site.t", values: {} }
        ).errors
      ),
      ["code:ReadOnlyField"]
    );
  });

  it("validates an update with the concrete class's metadata only", () => {
    // A child class narrows `title` to 2 code points and adds `extra`.
    const child = {
      ...table,
      ancestors: [{ id: table.id, label: table.label, name: table.name }],
      fields: [
        ...table.fields.map((entry) =>
          entry.name === "title"
            ? { ...entry, type: { kind: "text" as const, maxLength: 2 } }
            : entry
        ),
        field("extra", { kind: "integer" }),
      ],
      id: "00000000-0000-4000-8000-000000000002",
      name: "site.t_child",
    };

    const stored = { class: "site.t_child", values: { title: "a" } };

    // The parent's metadata would accept "abc"; the server validates the
    // child's override, so the parent's metadata is refused loudly.
    assert.throws(() => {
      validateRecord(table, "update", { title: "abc" }, stored);
    }, /metadata of site\.t_child/u);
    assert.throws(() => {
      validateRecord(table, "update", { title: "abc" });
    });

    // Through the parent endpoint: the child's rules, the parent's names.
    const through = validateRecord(
      child,
      "update",
      { extra: 1, title: "abc" },
      stored,
      { through: table }
    );

    assert.deepStrictEqual(through.unknownFields, ["extra"]);
    assert.deepStrictEqual(
      codes(
        validateRecord(child, "update", { title: "abc" }, stored, {
          through: table,
        }).errors
      ),
      ["title:tooLong"]
    );

    // An endpoint outside the lineage is refused.
    assert.throws(() => {
      validateRecord(child, "update", { title: "a" }, stored, {
        through: { ...table, name: "site.other" },
      });
    });
  });

  it("resolves names like the server", () => {
    assert.deepStrictEqual(
      validateRecord(table, "create", { nope: 1, title: "a" }).unknownFields,
      ["nope"]
    );
    assert.deepStrictEqual(
      codes(validateRecord(table, "create", { id: "x", title: "a" }).errors),
      ["id:ReadOnlyField"]
    );
    assert.isTrue(validateRecord(table, "create", [1]).invalidBody);
    assert.deepStrictEqual(
      codes(validateRecord(table, "create", { title: "a\u0000" }).errors),
      ["title:nulCharacter"]
    );
  });

  it("checks delivered values in read mode", () => {
    assert.deepStrictEqual(
      validateRecord(table, "read", {
        cost: "1.50",
        secret: { set: true },
        title: "a",
      }).errors,
      []
    );
    assert.deepStrictEqual(
      codes(validateRecord(table, "read", { secret: "x" }).errors),
      ["secret:wrongJsonType"]
    );
  });
});
