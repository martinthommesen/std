import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { TICKET_FIELDS, ticketTable } from "../form-fixture.ts";
import { FieldInput } from "./form-input.ts";
/**
 * What becomes of a form's edits when its definitions change (decision
 * 0020): the cases the form stories do not reach, a create form and a
 * type change.
 */
import type { MetaField } from "./metadata.ts";
import {
  droppedText,
  inputText,
  mergeChanges,
  reconcileWithMetadata,
} from "./stale-edits.ts";

const fieldById = (fieldId: string): MetaField => {
  const field = ticketTable.fields.find(
    (candidate) => candidate.id === fieldId
  );

  if (field === undefined) {
    throw new RangeError(`the fixture lacks field ${fieldId}`);
  }

  return field;
};

describe("reconciling edits with new metadata", () => {
  it("drops an edit whose input no longer fits the field's type, noting what was typed", () => {
    const points = fieldById(TICKET_FIELDS.points);
    const retyped = { ...points, type: { kind: "boolean" as const } };

    const reconciled = reconcileWithMetadata(
      { [points.id]: FieldInput.Text({ text: "5" }) },
      [points],
      [retyped],
      false
    );

    expect(reconciled.edits).toStrictEqual({});
    expect(reconciled.dropped).toStrictEqual([
      {
        fieldId: points.id,
        label: "Points",
        maybeText: Option.some("5"),
        reason: "TypeChanged",
      },
    ]);
  });

  it("on a create form, judges a field by its create write limit", () => {
    const description = fieldById(TICKET_FIELDS.description);

    const updateOnly = {
      ...description,
      write: { create: "no" as const, update: "yes" as const },
    };

    const edits = {
      [description.id]: FieldInput.Text({ text: "Details" }),
    };

    expect(
      reconcileWithMetadata(edits, [description], [updateOnly], true).dropped
    ).toHaveLength(1);
    expect(
      reconcileWithMetadata(edits, [description], [updateOnly], false).edits
    ).toStrictEqual(edits);
  });

  it("says a dropped choice by its label, a write-only value never", () => {
    const status = fieldById(TICKET_FIELDS.status);
    const pin = fieldById(TICKET_FIELDS.pin);

    expect(
      inputText(status, FieldInput.Choice({ key: "in_progress" }))
    ).toStrictEqual(Option.some("In progress"));
    expect(
      droppedText({
        fieldId: pin.id,
        label: pin.label,
        maybeText: inputText(
          pin,
          FieldInput.WriteOnly({ maybeValue: Option.none() })
        ),
        reason: "Retired",
      })
    ).toBe("Your change to PIN was not kept: the field was retired.");
  });

  it("adds a later refusal's changes once each", () => {
    const renamed = {
      field: "summary",
      fieldId: TICKET_FIELDS.shortDescription,
      kind: "fieldRenamed" as const,
      revision: 6,
      table: "help.ticket",
    };

    expect(
      mergeChanges([renamed], [{ ...renamed, revision: 7 }])
    ).toStrictEqual([{ ...renamed, revision: 7 }]);
  });
});
