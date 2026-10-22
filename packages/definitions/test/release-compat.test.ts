/**
 * Release compatibility (decision 0017): properties added after a release
 * may be absent from what a client of that release sends and from what it
 * stored (definition revisions, shipped base records); absent reads as
 * null, their documented default. Present values are still checked.
 */
import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import {
  DefinitionSchema,
  FieldDraftSchema,
  OverrideDraftSchema,
} from "../src/definition.ts";
import { OperationSchema } from "../src/operation.ts";

const ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
const OTHER = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e90";

/** An `addField` draft as v0.0.1's quickstart sends it. */
const releasedField = {
  classId: OTHER,
  default: null,
  helpText: null,
  id: ID,
  kind: "field",
  label: "Serial",
  name: "serial",
  owner: { layer: "local" },
  protected: false,
  readOnly: false,
  required: false,
  type: { kind: "text" },
} as const;

/** A `setOverride` draft as v0.0.1 knew it. */
const releasedOverride = {
  classId: OTHER,
  default: null,
  fieldId: ID,
  helpText: null,
  id: "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e91",
  kind: "override",
  label: null,
  max: null,
  maxLength: null,
  min: null,
  owner: { layer: "local" },
  protected: false,
  readOnly: null,
  required: true,
} as const;

describe("release compatibility of definitions", () => {
  it("decodes a v0.0.1 field draft with numberPrefix null", () => {
    const decoded = Schema.decodeUnknownSync(FieldDraftSchema)(releasedField);

    assert.strictEqual(decoded.numberPrefix, null);
    assert.strictEqual(decoded.name, "serial");
  });

  it("decodes a v0.0.1 override draft with choices and numberPrefix null", () => {
    const decoded =
      Schema.decodeUnknownSync(OverrideDraftSchema)(releasedOverride);

    assert.strictEqual(decoded.choices, null);
    assert.strictEqual(decoded.numberPrefix, null);
  });

  it("decodes v0.0.1 change-set operations", () => {
    const operations = Schema.decodeUnknownSync(Schema.Array(OperationSchema))([
      { definition: releasedField, op: "addField" },
      { definition: releasedOverride, op: "setOverride", version: null },
    ]);

    assert.lengthOf(operations, 2);
  });

  it("decodes a v0.0.1 stored field definition (a definition revision)", () => {
    const decoded = Schema.decodeUnknownSync(DefinitionSchema)({
      ...releasedField,
      enforcement: "enforced",
      enforcementNote: null,
      state: "active",
      version: 1,
    });

    assert.strictEqual(decoded.kind, "field");
    assert.isTrue("numberPrefix" in decoded && decoded.numberPrefix === null);
  });

  it("keeps present values and still checks them", () => {
    const decode = Schema.decodeUnknownResult(FieldDraftSchema);

    const prefixed = decode({ ...releasedField, numberPrefix: "INC" });

    assert.isTrue(
      Result.isSuccess(prefixed) && prefixed.success.numberPrefix === "INC"
    );
    assert.isTrue(
      Result.isFailure(decode({ ...releasedField, numberPrefix: 5 }))
    );
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(OverrideDraftSchema)({
          ...releasedOverride,
          choices: "alpha",
        })
      )
    );
  });
});
