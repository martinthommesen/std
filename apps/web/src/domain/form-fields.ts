import type { JsonValue } from "@std/values/json-value";
import { Option } from "effect";

import { createBaseValue } from "./form-input.ts";
import type { MetaField, MetaTable } from "./metadata.ts";
/**
 * Which fields a record's form shows, in which sections, and how each one
 * shows (Contracts 6.3, 6.3a, 6.5, 6.6) [judgment, decision 0020].
 *
 * Sections come from the table's form layout, which metadata serves with
 * only the active fields the caller can read. Without a layout the form
 * shows the display field, then every other active field in metadata
 * order, in one section. Two kinds of field are added after the layout's
 * sections, since a form must not hide them: a required field the layout
 * leaves out (without it a create could never succeed), and, when editing,
 * a retired field holding a value (read-only; retired fields without a
 * value are hidden).
 *
 * How a field shows:
 *
 * - `Restricted`: in the record's `withheld` (an access rule withholds it
 *   on this record): never shown as empty, never sent.
 * - `NotDelivered`: absent and not withheld.
 * - `ReadOnly`: read-only or auto-numbered fields, retired fields, fields
 *   the caller may not write (`write.create` or `write.update` is `no`),
 *   and references whose target the caller cannot open (metadata names it
 *   `null`): the value as text.
 * - `Editable`: everything else; `perRecord` is editable and the server
 *   decides.
 */
import type { RecordJson } from "./record.ts";

/** One section of a form: its label, if any, and its fields in order. */
export interface FormSection {
  readonly maybeLabel: Option.Option<string>;
  readonly fields: readonly MetaField[];
}

/** How one field shows on the form. */
export type FieldShow =
  | { readonly _tag: "Editable" }
  | { readonly _tag: "ReadOnly"; readonly value: JsonValue }
  | { readonly _tag: "Restricted" }
  | { readonly _tag: "NotDelivered" };

/** The section of required fields a form layout leaves out. */
export const REQUIRED_SECTION = "Other required fields";

/** The section of retired fields that hold a value. */
export const RETIRED_SECTION = "Retired fields";

/**
 * The fields of the endpoint as the form describes them: the concrete
 * class's description of each field when the form has it (its labels,
 * choices and rules apply to the record, Contracts 2.5), else the
 * endpoint's. Names are the endpoint's, as the body uses them.
 *
 * @param endpoint - The endpoint table's metadata.
 * @param maybeClass - The record's concrete class's, when it differs.
 * @returns The endpoint's fields.
 */
export const formFieldsOf = (
  endpoint: MetaTable,
  maybeClass: Option.Option<MetaTable>
): readonly MetaField[] =>
  Option.match(maybeClass, {
    onNone: () => endpoint.fields,
    onSome: (concrete) =>
      endpoint.fields.map((field) => {
        const described = concrete.fields.find(
          (candidate) => candidate.id === field.id
        );

        return described === undefined
          ? field
          : { ...described, name: field.name };
      }),
  });

const byId = (fields: readonly MetaField[], fieldId: string) =>
  Option.fromNullishOr(fields.find((field) => field.id === fieldId));

const layoutSections = (
  table: MetaTable,
  fields: readonly MetaField[]
): Option.Option<readonly FormSection[]> =>
  Option.map(Option.fromNullishOr(table.layouts.form), (elements) => {
    const starts = elements.flatMap((element, index) =>
      element.kind === "section" ? [index] : []
    );

    const fieldsBetween = (from: number, to: number) =>
      elements
        .slice(from, to)
        .flatMap((element) =>
          element.kind === "field"
            ? Option.toArray(byId(fields, element.fieldId))
            : []
        );

    const leading: FormSection = {
      fields: fieldsBetween(0, starts[0] ?? elements.length),
      maybeLabel: Option.none(),
    };

    const labelled = starts.map((start, index): FormSection => ({
      fields: fieldsBetween(start + 1, starts[index + 1] ?? elements.length),
      maybeLabel: Option.fromNullishOr(
        elements[start]?.kind === "section" ? elements[start].label : null
      ),
    }));

    return [leading, ...labelled].filter(
      (section) => section.fields.length > 0
    );
  });

const defaultSection = (
  table: MetaTable,
  fields: readonly MetaField[]
): FormSection => ({
  fields: [
    ...fields.filter((field) => field.name === table.displayField),
    ...fields.filter(
      (field) => field.name !== table.displayField && field.state === "active"
    ),
  ],
  maybeLabel: Option.none(),
});

const isAssignedBySystem = (field: MetaField): boolean =>
  field.autoNumber !== null || field.readOnly;

const isRequiredWithoutDefault = (field: MetaField): boolean =>
  field.state === "active" &&
  field.required &&
  field.default === null &&
  !isAssignedBySystem(field);

const holdsValue = (record: RecordJson, field: MetaField): boolean => {
  const value = record.values[field.name];

  return value !== undefined && value !== null;
};

const extraSection = (
  label: string,
  fields: readonly MetaField[]
): readonly FormSection[] =>
  fields.length === 0 ? [] : [{ fields, maybeLabel: Option.some(label) }];

/**
 * The form's sections.
 *
 * @param table - The endpoint table's metadata (its layout).
 * @param fields - The fields as {@link formFieldsOf} describes them.
 * @param maybeRecord - The record, when editing.
 * @returns The sections, in order.
 */
export const formSections = (
  table: MetaTable,
  fields: readonly MetaField[],
  maybeRecord: Option.Option<RecordJson>
): readonly FormSection[] => {
  const fromLayout = layoutSections(table, fields);

  const sections = Option.getOrElse(fromLayout, () => [
    defaultSection(table, fields),
  ]);

  const shown = new Set(
    sections.flatMap((section) => section.fields.map((field) => field.id))
  );

  const missingRequired = Option.isSome(fromLayout)
    ? fields.filter(
        (field) => !shown.has(field.id) && isRequiredWithoutDefault(field)
      )
    : [];

  const retired = Option.match(maybeRecord, {
    onNone: () => [],
    onSome: (record) =>
      fields.filter(
        (field) =>
          field.state === "retired" &&
          !shown.has(field.id) &&
          holdsValue(record, field)
      ),
  });

  return [
    ...sections,
    ...extraSection(REQUIRED_SECTION, missingRequired),
    ...extraSection(RETIRED_SECTION, retired),
  ];
};

/**
 * Whether the caller may change a field on this form: not read-only, not
 * retired, writable for the form's mode (`yes` or `perRecord`), and for a
 * reference, a target the caller can open.
 *
 * @param field - The field.
 * @param isCreate - Whether the form creates a record.
 * @returns True when the form offers an input.
 */
export const isWritable = (field: MetaField, isCreate: boolean): boolean => {
  const access = isCreate ? field.write.create : field.write.update;

  const hasTarget =
    field.type.kind !== "reference" || field.type.target !== null;

  return (
    !isAssignedBySystem(field) &&
    field.state === "active" &&
    access !== "no" &&
    hasTarget
  );
};

/**
 * How a field shows on the form.
 *
 * @param field - The field.
 * @param maybeRecord - The record, when editing.
 * @returns How it shows.
 */
export const fieldShowOf = (
  field: MetaField,
  maybeRecord: Option.Option<RecordJson>
): FieldShow =>
  Option.match(maybeRecord, {
    onNone: () =>
      isWritable(field, true)
        ? { _tag: "Editable" }
        : { _tag: "ReadOnly", value: createBaseValue(field) },
    onSome: (record) => {
      if (record.withheld?.includes(field.name) === true) {
        return { _tag: "Restricted" };
      }

      const value = record.values[field.name];

      if (value === undefined) {
        return { _tag: "NotDelivered" };
      }

      return isWritable(field, false)
        ? { _tag: "Editable" }
        : { _tag: "ReadOnly", value };
    },
  });
