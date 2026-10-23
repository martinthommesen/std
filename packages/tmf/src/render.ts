/**
 * Rendering a record as a TMF resource (Contracts 10.2, 11.1), from what
 * the record service let the caller read (`SourceRecord`):
 *
 * - `id`, `href` and `@type` always; `@baseType` for a local child class
 *   (the TMF type of its nearest mapped ancestor) or a TMF subtype;
 * - every attribute whose sources the caller can all read on the record
 *   and whose value is not empty: an empty attribute is left out, never
 *   `null` (TMF630 v5.0.0 Part 1 §4.1 p.39), and so is one the caller
 *   cannot read, so a hidden field and an empty one look alike only
 *   through the generic API's `withheld` (TMF has no such marker);
 * - arrays of parts with the parts the caller can see, each item with
 *   `@type` and `id`;
 * - with `fields`, only the selected attributes besides the identity
 *   attributes.
 */
import type { JsonObject, JsonValue } from "@std/values/json-value";

import type {
  Attribute,
  ItemMapping,
  PartsAttribute,
  RenderContext,
  SourceRecord,
  TmfResourceMapping,
  ValueAttribute,
} from "./mapping.ts";

/** The polymorphism attributes of a resource (Contracts 11.1). */
export interface TypeAttributes {
  readonly "@type": string;
  readonly "@baseType"?: string;
  readonly "@schemaLocation"?: string;
}

/** The attributes every resource has, whatever `fields` selects. */
export const IDENTITY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "id",
  "href",
  "@type",
  "@baseType",
  "@schemaLocation",
]);

/**
 * The polymorphism attributes of a record's concrete class (Contracts
 * 11.1): a shipped class renders the TMF type its mapping names; a local
 * child class renders its own type name (`LocalVipIncident`, the
 * UpperCamelCase form of its qualified name) with the `@baseType` of its
 * nearest mapped ancestor.
 *
 * @param resource - The resource mapping.
 * @param ancestry - The concrete class, then its ancestors up to the root.
 * @param ownTypeName - The concrete class's own type name.
 * @returns `@type` and, where it applies, `@baseType`.
 */
export const typeAttributesOf = (
  resource: Pick<TmfResourceMapping, "types">,
  ancestry: readonly string[],
  ownTypeName: string
): TypeAttributes => {
  const [concrete] = ancestry;
  const own = resource.types.find((entry) => entry.classId === concrete);

  if (own !== undefined) {
    return own.baseType === undefined
      ? { "@type": own.type }
      : { "@baseType": own.baseType, "@type": own.type };
  }

  const nearest = ancestry
    .map((classId) => resource.types.find((entry) => entry.classId === classId))
    .find((entry) => entry !== undefined);

  return nearest === undefined
    ? { "@type": ownTypeName }
    : { "@baseType": nearest.type, "@type": ownTypeName };
};

/**
 * Whether the caller can read every source of an attribute on a record.
 *
 * @param attribute - The attribute.
 * @param record - The record as read.
 * @returns True when the attribute may render.
 */
export const readableOn = (
  attribute: Attribute,
  record: SourceRecord
): boolean =>
  attribute.kind === "parts"
    ? record.parts.has(attribute.name)
    : attribute.sources.every((source) => record.values.has(source));

const renderValue = (
  attribute: ValueAttribute,
  record: SourceRecord,
  context: RenderContext
): JsonValue | undefined =>
  readableOn(attribute, record)
    ? attribute.render(record.values, context)
    : undefined;

/**
 * Renders one item of an array of parts: `@type`, `id`, and its readable
 * attributes.
 *
 * @param item - The item mapping.
 * @param part - The part as read.
 * @param context - Type names and hrefs.
 * @returns The item.
 */
export const renderItem = (
  item: ItemMapping,
  part: SourceRecord,
  context: RenderContext
): JsonObject => {
  const rendered = new Map<string, JsonValue>([
    ["@type", item.type],
    ["id", part.id],
  ]);

  // An array without visible items is empty, and left out.
  const itemsOf = (attribute: PartsAttribute) => {
    const nested = part.parts.get(attribute.name) ?? [];

    return nested.length === 0
      ? undefined
      : nested.map((each) => renderItem(attribute.item, each, context));
  };

  for (const attribute of item.attributes) {
    const value =
      attribute.kind === "parts"
        ? itemsOf(attribute)
        : renderValue(attribute, part, context);

    if (value !== undefined) {
      rendered.set(attribute.name, value);
    }
  }

  return Object.fromEntries(rendered);
};

const renderParts = (
  item: ItemMapping,
  record: SourceRecord,
  name: string,
  context: RenderContext
): JsonValue | undefined => {
  const parts = record.parts.get(name) ?? [];

  return parts.length === 0
    ? undefined
    : parts.map((part) => renderItem(item, part, context));
};

/** What a resource's rendering needs besides the record. */
export interface ResourceContext extends RenderContext {
  /** The record's own URL. */
  readonly href: string;
  readonly typeAttributes: TypeAttributes;
  /**
   * Attributes of the record's local classes below the nearest mapped
   * class (their own fields by API name, Contracts 11.1).
   */
  readonly extensions: readonly ValueAttribute[];
  /** `fields`: the attributes to render besides the identity ones; null: all. */
  readonly fields: ReadonlySet<string> | null;
}

/**
 * Renders a record as a TMF resource.
 *
 * @param resource - The resource mapping.
 * @param record - The record as the caller may read it.
 * @param context - URL, type attributes, extensions and `fields`.
 * @returns The resource.
 */
export const renderResource = (
  resource: Pick<TmfResourceMapping, "attributes">,
  record: SourceRecord,
  context: ResourceContext
): JsonObject => {
  const rendered = new Map<string, JsonValue>([
    ["id", record.id],
    ["href", context.href],
    ...Object.entries(context.typeAttributes),
  ]);

  const selected = (name: string) =>
    context.fields === null || context.fields.has(name);

  for (const attribute of [...resource.attributes, ...context.extensions]) {
    if (selected(attribute.name)) {
      const value =
        attribute.kind === "parts"
          ? renderParts(attribute.item, record, attribute.name, context)
          : renderValue(attribute, record, context);

      if (value !== undefined) {
        rendered.set(attribute.name, value);
      }
    }
  }

  return Object.fromEntries(rendered);
};
