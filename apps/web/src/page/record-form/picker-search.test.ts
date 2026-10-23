/**
 * What a reference picker sends for a typed text (decision 0020, review
 * round 1): the operation the display field's type supports, for every
 * field type; the ID lookup; the sort; and nothing when nothing can match.
 */
import type { Expr } from "@std/conditions/ast";
import type { MetaFieldType } from "@std/definitions/table-metadata";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import type { MetaField, MetaTable } from "../../domain/metadata.ts";
import { field, userTable } from "../../table-fixture.ts";
import {
  DisplayMatch,
  PickerFilter,
  displayMatchOf,
  isSearchableByText,
  pickerFilterOf,
  pickerSortOf,
} from "./picker-search.ts";

const FIELD_ID = "00000000-0000-4000-8000-00000000d001";

const A_UUID = "019A0000-0000-7000-8000-0000000FA001";

const displayField = (
  type: MetaFieldType,
  overrides: Partial<MetaField> = {}
): MetaField =>
  field(FIELD_ID, "shown", "Shown", type, { nullable: true, ...overrides });

const left = { path: [FIELD_ID] };

const matching = (condition: Expr) => DisplayMatch.Match({ condition });

const PRIORITY = displayField(
  { kind: "choice" },
  {
    choices: [
      { key: "p1", label: "Critical", order: 1, retired: false },
      { key: "p2", label: "High", order: 2, retired: false },
      { key: "p3", label: "Highest (old)", order: 3, retired: true },
      { key: "p4", label: "Low", order: 4, retired: false },
    ],
  }
);

describe("the operation a picker searches a display field with", () => {
  it("text and long text: contains the text", () => {
    for (const kind of ["text", "longText"] as const) {
      expect(displayMatchOf(displayField({ kind }), "  Al ")).toStrictEqual(
        matching({ left, op: "contains", right: "Al" })
      );
    }
  });

  it("integer, big integer and decimal: equal to the number the text is, else nothing matches", () => {
    expect(
      displayMatchOf(displayField({ kind: "integer" }), "42")
    ).toStrictEqual(matching({ left, op: "eq", right: { value: 42 } }));
    expect(
      displayMatchOf(displayField({ kind: "bigInteger" }), "9007199254740993")
    ).toStrictEqual(
      matching({ left, op: "eq", right: { value: "9007199254740993" } })
    );
    expect(
      displayMatchOf(
        displayField({ kind: "decimal", precision: 10, scale: 2 }),
        "12.5"
      )
    ).toStrictEqual(matching({ left, op: "eq", right: { value: "12.5" } }));

    for (const kind of ["integer", "bigInteger"] as const) {
      expect(displayMatchOf(displayField({ kind }), "Al")).toStrictEqual(
        DisplayMatch.NoMatch()
      );
    }

    expect(
      displayMatchOf(
        displayField({ kind: "decimal", precision: 10, scale: 2 }),
        "twelve"
      )
    ).toStrictEqual(DisplayMatch.NoMatch());
  });

  it("date: equal to the date the text is", () => {
    expect(
      displayMatchOf(displayField({ kind: "date" }), "2026-10-22")
    ).toStrictEqual(
      matching({ left, op: "eq", right: { value: "2026-10-22" } })
    );
    expect(
      displayMatchOf(displayField({ kind: "date" }), "22.10.2026")
    ).toStrictEqual(DisplayMatch.NoMatch());
  });

  it("date-time: a date is its UTC day, an instant equals", () => {
    expect(
      displayMatchOf(displayField({ kind: "dateTime" }), "2026-10-22")
    ).toStrictEqual(
      matching({
        args: [
          { left, op: "ge", right: { value: "2026-10-22T00:00:00.000Z" } },
          { left, op: "lt", right: { value: "2026-10-23T00:00:00.000Z" } },
        ],
        op: "and",
      })
    );
    expect(
      displayMatchOf(displayField({ kind: "dateTime" }), "2026-10-22T08:15:00Z")
    ).toStrictEqual(
      matching({
        left,
        op: "eq",
        right: { value: "2026-10-22T08:15:00.000Z" },
      })
    );
    expect(
      displayMatchOf(displayField({ kind: "dateTime" }), "9999-12-31")
    ).toStrictEqual(
      matching({
        left,
        op: "ge",
        right: { value: "9999-12-31T00:00:00.000Z" },
      })
    );
    expect(
      displayMatchOf(displayField({ kind: "dateTime" }), "today")
    ).toStrictEqual(DisplayMatch.NoMatch());
  });

  it("choice: in the keys whose label contains the text (hidden choices too), or whose key it is", () => {
    expect(displayMatchOf(PRIORITY, "high")).toStrictEqual(
      matching({
        left,
        op: "in",
        right: [{ value: "p2" }, { value: "p3" }],
      })
    );
    expect(displayMatchOf(PRIORITY, "p4")).toStrictEqual(
      matching({ left, op: "in", right: [{ value: "p4" }] })
    );
    expect(displayMatchOf(PRIORITY, "Medium")).toStrictEqual(
      DisplayMatch.NoMatch()
    );
  });

  it("boolean: yes or true, no or false, and their beginnings", () => {
    const flag = displayField({ kind: "boolean" });

    expect(displayMatchOf(flag, "Yes")).toStrictEqual(
      matching({ left, op: "eq", right: { value: true } })
    );
    expect(displayMatchOf(flag, "t")).toStrictEqual(
      matching({ left, op: "eq", right: { value: true } })
    );
    expect(displayMatchOf(flag, "n")).toStrictEqual(
      matching({ left, op: "eq", right: { value: false } })
    );
    expect(displayMatchOf(flag, "maybe")).toStrictEqual(DisplayMatch.NoMatch());
  });

  it("uuid and reference: equal to the UUID the text is, in lowercase", () => {
    expect(
      displayMatchOf(
        displayField({ kind: "reference", target: "core.user" }),
        A_UUID
      )
    ).toStrictEqual(
      matching({ left, op: "eq", right: { value: A_UUID.toLowerCase() } })
    );
    expect(
      displayMatchOf(displayField({ kind: "uuid" }), "not-a-uuid")
    ).toStrictEqual(DisplayMatch.NoMatch());
  });

  it("json, condition, password and secret: no search", () => {
    const types: readonly MetaFieldType[] = [
      { kind: "json" },
      { kind: "condition", profile: "filter", table: null },
      { kind: "password" },
      { kind: "secret" },
    ];

    for (const type of types) {
      expect(displayMatchOf(displayField(type), "x")).toStrictEqual(
        DisplayMatch.Unsearchable()
      );
    }
  });
});

const targetWith = (display: MetaField | null): MetaTable => ({
  ...userTable,
  displayField: display?.name ?? null,
  fields: display === null ? userTable.fields : [...userTable.fields, display],
  name: "help.thing",
});

describe("what a picker sends", () => {
  it("a blank text lists the first targets, sorted by a sortable display field", () => {
    const target = targetWith(displayField({ kind: "integer" }));

    expect(pickerFilterOf(target, "  ")).toStrictEqual(
      PickerFilter.Search({ filter: Option.none() })
    );
    expect(pickerSortOf(target)).toStrictEqual(Option.some("shown"));
  });

  it("prints the display field's match with its name", () => {
    expect(
      pickerFilterOf(targetWith(displayField({ kind: "integer" })), "42")
    ).toStrictEqual(PickerFilter.Search({ filter: Option.some("shown = 42") }));
    expect(pickerFilterOf(targetWith(PRIORITY), "high")).toStrictEqual(
      PickerFilter.Search({ filter: Option.some('shown in ("p2", "p3")') })
    );
  });

  it("a UUID also finds the target with that ID", () => {
    const uuid = A_UUID.toLowerCase();

    expect(
      pickerFilterOf(targetWith(displayField({ kind: "text" })), A_UUID)
    ).toStrictEqual(
      PickerFilter.Search({
        filter: Option.some(`(shown contains "${A_UUID}") or id = "${uuid}"`),
      })
    );
    expect(pickerFilterOf(targetWith(null), A_UUID)).toStrictEqual(
      PickerFilter.Search({ filter: Option.some(`id = "${uuid}"`) })
    );
    expect(
      pickerFilterOf(targetWith(displayField({ kind: "json" })), A_UUID)
    ).toStrictEqual(
      PickerFilter.Search({ filter: Option.some(`id = "${uuid}"`) })
    );
  });

  it("sends nothing for a text nothing can match", () => {
    expect(
      pickerFilterOf(targetWith(displayField({ kind: "integer" })), "Al")
    ).toStrictEqual(PickerFilter.NothingMatches());
    expect(pickerFilterOf(targetWith(null), "Al")).toStrictEqual(
      PickerFilter.NothingMatches()
    );
  });

  it("neither searches nor sorts by a json display field, and says it finds by ID", () => {
    const target = targetWith(displayField({ kind: "json" }));

    expect(pickerSortOf(target)).toStrictEqual(Option.none());
    expect(isSearchableByText(target)).toBeFalsy();
    expect(isSearchableByText(targetWith(null))).toBeFalsy();
    expect(isSearchableByText(userTable)).toBeTruthy();
  });
});
