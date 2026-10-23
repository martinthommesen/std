/**
 * What a TMF route knows about its resource for one caller (Contracts
 * 11.1): the URLs of its records, the `@type` of each concrete class, the
 * attributes of local child classes, and what the caller may read and
 * name of each class (3.4).
 */
import { fieldDecision, knowsTable } from "@std/access/rules";
import type { DefinitionId } from "@std/definitions/ids";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { fieldAttribute, pathOf } from "@std/tmf/mapping";
import type {
  Attribute,
  RenderContext,
  SourceKey,
  SourceRecord,
  TmfApiMapping,
  TmfResourceMapping,
  ValueAttribute,
} from "@std/tmf/mapping";
import {
  IDENTITY_ATTRIBUTES,
  renderResource,
  typeAttributesOf,
} from "@std/tmf/render";
import type { TypeAttributes } from "@std/tmf/render";
import type { ClassAccess } from "@std/tmf/write";
import type { JsonObject } from "@std/values/json-value";

import type { ReadScope } from "../../records/read-view.ts";
import { typeNameOf } from "../api/table-names.ts";
import { readsSource, sourceKeysOf } from "./sources.ts";

/** One mapped resource of one API. */
export interface MappedResource {
  readonly api: TmfApiMapping;
  readonly resource: TmfResourceMapping;
}

/** Every API the server serves, for references between them. */
export type TmfRegistry = readonly TmfApiMapping[];

/**
 * The URL of a resource's record.
 *
 * @param origin - The request origin.
 * @param mapped - The API and resource.
 * @param id - The record ID.
 * @returns The `href`.
 */
export const hrefOf = (
  origin: string,
  mapped: MappedResource,
  id: string
): string => `${origin}${mapped.api.basePath}/${mapped.resource.name}/${id}`;

/**
 * The mapped resource whose class subtree holds a class, if an API serves
 * one.
 *
 * @param snapshot - The configuration.
 * @param registry - The served APIs.
 * @param classId - A concrete class.
 * @returns The API and resource, or undefined.
 */
export const resourceOfClass = (
  snapshot: ConfigSnapshot,
  registry: TmfRegistry,
  classId: DefinitionId
): MappedResource | undefined => {
  for (const api of registry) {
    for (const resource of api.resources) {
      if (new Set(snapshot.subtreeIds(resource.classId)).has(classId)) {
        return { api, resource };
      }
    }
  }

  return undefined;
};

/**
 * A class and its ancestors, the class first.
 *
 * @param snapshot - The configuration.
 * @param classId - The class.
 * @returns The ancestry.
 */
export const ancestryOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): readonly DefinitionId[] =>
  snapshot
    .lineage(classId)
    .map((entry) => entry.id)
    .toReversed();

/**
 * The polymorphism attributes of a concrete class in a resource (Contracts
 * 11.1).
 *
 * @param snapshot - The configuration.
 * @param resource - The resource mapping.
 * @param classId - The concrete class.
 * @returns `@type` and, where it applies, `@baseType`.
 */
export const typeAttributesFor = (
  snapshot: ConfigSnapshot,
  resource: TmfResourceMapping,
  classId: DefinitionId
): TypeAttributes =>
  typeAttributesOf(
    resource,
    ancestryOf(snapshot, classId),
    typeNameOf(snapshot, classId)
  );

/**
 * Type names and URLs for references (Contracts 10.2, 11.1): a class an
 * API serves takes its TMF type and URL there; any other class its
 * `/api/v1` type name and no URL.
 *
 * @param snapshot - The configuration.
 * @param registry - The served APIs.
 * @param origin - The request origin.
 * @returns The render context.
 */
export const renderContextOf = (
  snapshot: ConfigSnapshot,
  registry: TmfRegistry,
  origin: string
): RenderContext => ({
  hrefOf: (classId, id) => {
    const mapped = resourceOfClass(snapshot, registry, classId);

    return mapped === undefined ? undefined : hrefOf(origin, mapped, id);
  },
  lineageOf: (classId) => ancestryOf(snapshot, classId),
  typeOf: (classId) => {
    const mapped = resourceOfClass(snapshot, registry, classId);

    return mapped === undefined
      ? typeNameOf(snapshot, classId)
      : typeAttributesFor(snapshot, mapped.resource, classId)["@type"];
  },
});

/**
 * The attributes of a concrete class's local classes (Contracts 11.1): the
 * own fields of every class between the concrete class and its nearest
 * mapped class, by API name (10.2), unless the name is already a mapped
 * attribute's.
 *
 * @param snapshot - The configuration.
 * @param resource - The resource mapping.
 * @param classId - The concrete class.
 * @returns The extension attributes.
 */
export const extensionsOf = (
  snapshot: ConfigSnapshot,
  resource: TmfResourceMapping,
  classId: DefinitionId
): readonly ValueAttribute[] => {
  const mapped = new Set([
    resource.classId,
    ...resource.types.map((entry) => entry.classId),
  ]);

  const ancestry = ancestryOf(snapshot, classId);
  const nearest = ancestry.findIndex((entry) => mapped.has(entry));
  const local = nearest === -1 ? [] : ancestry.slice(0, nearest);

  const taken = new Set([
    ...IDENTITY_ATTRIBUTES,
    ...resource.attributes.map((attribute) => attribute.name),
  ]);

  return local.toReversed().flatMap((localClass) =>
    snapshot.ownFields(localClass).flatMap((field) => {
      const name = apiAttributeNameOf(field.name);

      return field.state === "active" && !taken.has(name)
        ? [fieldAttribute(name, field.id)]
        : [];
    })
  );
};

/**
 * Every attribute of a concrete class: the mapping's and its local ones.
 *
 * @param snapshot - The configuration.
 * @param resource - The resource mapping.
 * @param classId - The concrete class.
 * @returns The attributes.
 */
export const attributesOf = (
  snapshot: ConfigSnapshot,
  resource: TmfResourceMapping,
  classId: DefinitionId
): readonly Attribute[] => [
  ...resource.attributes,
  ...extensionsOf(snapshot, resource, classId),
];

/**
 * The extension fields to read for a concrete class.
 *
 * @param snapshot - The configuration.
 * @param resource - The resource mapping.
 * @returns The keys per class.
 */
export const extraKeysOf =
  (snapshot: ConfigSnapshot, resource: TmfResourceMapping) =>
  (classId: DefinitionId): ReadonlySet<SourceKey> =>
    sourceKeysOf(extensionsOf(snapshot, resource, classId));

/** The write actions a body's fields are named for. */
export type NamingAction = "create" | "update";

/**
 * The field a source writes: a path source is written through its
 * reference, resolved by the target's field, which the caller must read
 * (decision 0035).
 *
 * @param key - The source.
 * @returns The field's stable ID.
 */
const writtenFieldOf = (key: SourceKey): DefinitionId =>
  pathOf(key)?.reference ?? key;

/**
 * What the caller may read and name of exactly one class (Contracts 3.4):
 * the caller's visible schema of that class, and the fields a body may
 * name for a record of that class, readable there or writable there by a
 * field rule of one of the actions. TMF writes know the concrete class
 * (a create names it, an update locks and reads the record first), so the
 * names are decided for that class alone, never for its subtree: a field
 * a child class makes writable is unknown on a parent-class record, as it
 * is to a caller who cannot read it (`UnknownField`, never the record
 * service's `NotAllowed`, which would reveal that the field exists). The
 * record service still enforces every rule on the save.
 *
 * @param scope - The caller's scope.
 * @param classId - The concrete class.
 * @param actions - The write actions the body may be used for.
 * @returns The access.
 */
export const classAccessOf = (
  scope: ReadScope,
  classId: DefinitionId,
  actions: readonly NamingAction[]
): ClassAccess => {
  const { caller, snapshot } = scope;
  const view = scope.view(classId, true);
  const canRead = (key: SourceKey) => readsSource(scope, view, key);

  // A purged field is gone: unknown, as one that never existed.
  const exists = (key: SourceKey) =>
    (snapshot.field(writtenFieldOf(key))?.state ?? "purged") !== "purged" &&
    (pathOf(key) === undefined || canRead(key));

  const decisions = (key: SourceKey) =>
    actions.map(
      (action) =>
        fieldDecision(snapshot, caller, action, classId, writtenFieldOf(key))
          .kind
    );

  return {
    canName: (key) =>
      exists(key) &&
      (canRead(writtenFieldOf(key)) ||
        decisions(key).some((kind) => kind !== "never")),
    canRead,
    // Write permission on every record of the class, for every action:
    // a conditional field rule may refuse some records.
    canWrite: (key) =>
      exists(key) && decisions(key).every((kind) => kind === "always"),
    knows: knowsTable(snapshot, caller, classId),
  };
};

/**
 * Whether the caller knows an attribute on a class (for `fields`, `sort`
 * and filters): every source is in the caller's visible schema, or, for
 * an array, the part class is known to the caller.
 *
 * @param scope - The caller's scope.
 * @param classId - The class the request reads through.
 * @param attribute - The attribute.
 * @returns True when known.
 */
export const knownOn = (
  scope: ReadScope,
  classId: DefinitionId,
  attribute: Attribute
): boolean => {
  const view = scope.view(classId);
  const reads = (source: SourceKey) => readsSource(scope, view, source);

  if (attribute.kind === "parts") {
    return (
      knowsTable(scope.snapshot, scope.caller, attribute.item.classId) ||
      (attribute.ownerItems ?? []).some((owner) => owner.sources.every(reads))
    );
  }

  return attribute.sources.every(reads);
};

/** What rendering a record needs. */
export interface RenderInput {
  readonly scope: ReadScope;
  readonly registry: TmfRegistry;
  readonly mapped: MappedResource;
  readonly origin: string;
  /** `fields`: null for all. */
  readonly fields: ReadonlySet<string> | null;
}

/**
 * A record as its TMF resource, for the caller.
 *
 * @param input - Scope, APIs, the resource, origin and `fields`.
 * @param record - The record as read.
 * @returns The resource.
 */
export const renderFor = (
  input: RenderInput,
  record: SourceRecord
): JsonObject => {
  const { snapshot } = input.scope;
  const { resource } = input.mapped;

  return renderResource(resource, record, {
    ...renderContextOf(snapshot, input.registry, input.origin),
    extensions: extensionsOf(snapshot, resource, record.classId),
    fields: input.fields,
    href: hrefOf(input.origin, input.mapped, record.id),
    typeAttributes: typeAttributesFor(snapshot, resource, record.classId),
  });
};
