/**
 * Records as `/api/v2` resources (Contracts 10.2): one flat JSON object,
 *
 * ```json
 * { "id", "href", "@type", "@baseType", "@schemaLocation", "revision",
 *   "creationDate", "createdBy": { "@type": "EntityRef", ... },
 *   "lastUpdate", "updatedBy", ..., "withheld": [...] }
 * ```
 *
 * - `href` is the record's absolute URL through its concrete class;
 *   `@type` the concrete class's type name (`HelpdeskIncident`), `@baseType`
 *   the parent class's (absent on a root's own records), `@schemaLocation`
 *   the caller's JSON Schema of the concrete class.
 * - Attribute names are API names; value shapes are 6.5's. An attribute
 *   without a value is left out, never `null` (TMF630 v5.0.0 Part 1 §4.1
 *   p.39); `withheld` lists the selected attributes access rules withheld,
 *   so a restricted value never looks empty (6.6).
 * - A reference is a typed reference (`<DeclaredType>Ref`, `@baseType`-free,
 *   TMF630 v5.0.0 Part 7 §1.4.3) when the caller knows the field's declared
 *   target class, else a generic `EntityRef`: `id`; `@referredType` and `href` naming
 *   the target's concrete class when the caller can see the target, else
 *   the declared target class when the caller knows it, else neither (a
 *   class name the caller cannot know is never shown, 3.4); `name`, the
 *   label under exactly the 3.6 rule. A selected one-hop path
 *   (`fields=assignedTo.email`) adds its value to the EntityRef.
 */
import { knowsTable } from "@std/access/rules";
import type { DefinitionId } from "@std/definitions/ids";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Config, Effect } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { apiNameOfField } from "../../records/read-field.ts";
import type {
  DecodedEntry,
  DecodedRecord,
} from "../../records/read-records.ts";
import type { ReadScope } from "../../records/read-view.ts";
import { isLoopbackHost } from "../session-cookie.ts";
import { collectionNameOf, typeNameOf } from "./table-names.ts";

/** Where `/api/v2` lives. */
export const V2_PREFIX = "/api/v2";

/**
 * The origin `href`s start with: `STD_PUBLIC_URL` when set (its origin),
 * else the request's `Host`, over `http` for a loopback host and `https`
 * otherwise, as the session cookie's `Secure` rule assumes (decision
 * 0018). [judgment]
 *
 * @param request - The request.
 * @returns The origin, without a trailing slash.
 */
export const originOf = Effect.fn("V2.originOf")(function* originOf(
  request: HttpServerRequest
) {
  const configured = yield* Config.String("STD_PUBLIC_URL").pipe(
    Config.withDefault(""),
    Effect.orDie
  );

  if (configured !== "") {
    return new URL(configured).origin;
  }

  const host = request.headers.host ?? "localhost";
  const scheme = isLoopbackHost(host) ? "http" : "https";

  return `${scheme}://${host}`;
});

/**
 * The absolute URL of a record through its class.
 *
 * @param origin - The origin.
 * @param collection - The class's v2 collection name.
 * @param id - The record ID.
 * @returns The URL.
 */
export const recordHref = (
  origin: string,
  collection: string,
  id: string
): string => `${origin}${V2_PREFIX}/${collection}/${id}`;

/**
 * The URL of a class's JSON Schema for the caller (`@schemaLocation`).
 *
 * @param origin - The origin.
 * @param collection - The class's v2 collection name.
 * @returns The URL.
 */
export const schemaLocation = (origin: string, collection: string): string =>
  `${origin}${V2_PREFIX}/tableMetadata/${collection}/schema.json`;

/** The polymorphism attributes of a resource (Contracts 10.2). */
export interface TypeAttributes {
  readonly "@type": string;
  readonly "@baseType"?: string;
  readonly "@schemaLocation": string;
}

/**
 * The polymorphism attributes of a class.
 *
 * @param scope - The caller's scope.
 * @param origin - The origin.
 * @param classId - The concrete class.
 * @returns `@type`, `@baseType` (when the class has a parent) and
 *   `@schemaLocation`.
 */
export const typeAttributes = (
  scope: ReadScope,
  origin: string,
  classId: DefinitionId
): TypeAttributes => {
  const { snapshot } = scope;
  const parentId = snapshot.class(classId)?.parentId ?? null;

  const location = schemaLocation(origin, collectionNameOf(snapshot, classId));

  const type = typeNameOf(snapshot, classId);

  return parentId === null
    ? { "@schemaLocation": location, "@type": type }
    : {
        "@baseType": typeNameOf(snapshot, parentId),
        "@schemaLocation": location,
        "@type": type,
      };
};

/** What an EntityRef is built from. */
export interface ReferenceParts {
  readonly id: string;
  /** The reference field's declared target class. */
  readonly declaredClassId: DefinitionId;
  /** The visible target's concrete class, or null. */
  readonly targetClassId: DefinitionId | null;
  /** The label under 3.6, or null. */
  readonly label: string | null;
}

/**
 * An EntityRef (Contracts 10.2).
 *
 * @param scope - The caller's scope.
 * @param origin - The origin.
 * @param reference - The target and what the caller may know of it.
 * @returns The EntityRef.
 */
export const entityRef = (
  scope: ReadScope,
  origin: string,
  reference: ReferenceParts
): JsonObject => {
  const { snapshot, caller } = scope;
  const declared = reference.declaredClassId;
  const known = knowsTable(snapshot, caller, declared) ? declared : null;
  const referredId = reference.targetClassId ?? known;

  // A typed reference (`CoreUserRef`) when the caller knows the field's
  // declared target class; the generic `EntityRef` otherwise (TMF630
  // v5.0.0 Part 7 §1.4.3 p.15).
  const refType =
    known === null ? "EntityRef" : `${typeNameOf(snapshot, known)}Ref`;

  const ref = new Map<string, JsonValue>([
    ["@type", refType],
    ["id", reference.id],
  ]);

  if (referredId !== null) {
    ref.set("@referredType", typeNameOf(snapshot, referredId));
    ref.set(
      "href",
      recordHref(origin, collectionNameOf(snapshot, referredId), reference.id)
    );
  }

  if (reference.label !== null) {
    ref.set("name", reference.label);
  }

  return Object.fromEntries(ref);
};

// References before the paths through them, which extend their EntityRef.
const referencesFirst = (
  entries: readonly DecodedEntry[]
): readonly DecodedEntry[] => [
  ...entries.filter((entry) => entry.item.through === undefined),
  ...entries.filter((entry) => entry.item.through !== undefined),
];

/** A resource's attributes while they are collected. */
interface Attributes {
  readonly values: Map<string, JsonValue>;
  readonly refs: Map<string, Map<string, JsonValue>>;
  readonly withheld: Set<string>;
}

const addPath = (
  attributes: Attributes,
  name: string,
  entry: DecodedEntry
): void => {
  const member =
    entry.item.through === undefined
      ? undefined
      : apiNameOfField(entry.item.through.field);

  const ref = attributes.refs.get(name);

  if (ref !== undefined && member !== undefined && entry.value !== null) {
    ref.set(member, entry.value);
  }
};

const addEntry = (
  scope: ReadScope,
  origin: string,
  attributes: Attributes,
  entry: DecodedEntry
): void => {
  const { field, through } = entry.item;
  const name = apiNameOfField(field);

  if (name === undefined) {
    return;
  }

  if (entry.withheld) {
    attributes.withheld.add(name);
  } else if (through !== undefined) {
    addPath(attributes, name, entry);
  } else if (field.type.kind === "reference" && isJsonString(entry.value)) {
    const ref = entityRef(scope, origin, {
      declaredClassId: field.type.targetClassId,
      id: entry.value,
      label: entry.label,
      targetClassId: entry.targetClassId,
    });

    attributes.refs.set(name, new Map(Object.entries(ref)));
  } else if (entry.value !== null) {
    attributes.values.set(name, entry.value);
  }
};

/**
 * A decoded record as a v2 resource.
 *
 * @param scope - The caller's scope.
 * @param origin - The origin.
 * @param record - The record.
 * @returns The resource.
 */
export const resourceOf = (
  scope: ReadScope,
  origin: string,
  record: DecodedRecord
): JsonObject => {
  const attributes: Attributes = {
    refs: new Map(),
    values: new Map(),
    withheld: new Set(),
  };

  for (const entry of referencesFirst(record.entries)) {
    addEntry(scope, origin, attributes, entry);
  }

  const collection = collectionNameOf(scope.snapshot, record.classId);

  const resource = new Map<string, JsonValue>([
    ["id", record.id],
    ["href", recordHref(origin, collection, record.id)],
    ...Object.entries(typeAttributes(scope, origin, record.classId)),
    ["revision", record.version],
    ...attributes.values,
  ]);

  for (const [name, ref] of attributes.refs) {
    resource.set(name, Object.fromEntries(ref));
  }

  if (attributes.withheld.size > 0) {
    resource.set("withheld", [...attributes.withheld]);
  }

  return Object.fromEntries(resource);
};
