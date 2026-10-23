/**
 * TMF621's value-object arrays that mix ticket fields and json (Contracts
 * 11.2; decision 0035): `troubleTicketCharacteristic`,
 * `troubleTicketRelationship`, `externalIdentifier`, `attachment`,
 * `relatedEntity` and `statusChangeHistory`.
 *
 * Each array renders the items its mapped fields give, then the items
 * kept as given in its json field. A write replaces the json items whole
 * (RFC 7396: an array replaces the old one). Mapped items:
 *
 * - a mapped characteristic (`urgency`, `majorIncident`, `holdReason`,
 *   `resolutionCode`, `resolutionNotes`, and on problems `knownError`,
 *   `workaround`, `rootCause`) writes its field; one the array leaves out
 *   is cleared, as strict RFC 7396 replaces the array (Martin, decided in
 *   decision 0035), so a required one (`urgency`) left out fails validation
 *   naming its field; one whose field the record's class lacks (a
 *   `majorIncident` on a problem) is kept in json;
 * - an incident's `causedBy` and `parent` relationships write `problem`
 *   and `parent_incident`, and one the array leaves out clears its field
 *   when the caller can read it (both are optional references); on other
 *   classes they are kept in json;
 * - the first external identifier is the ticket's number, read-only.
 *
 * Every item carries `@type` (filled in on write when absent) and the
 * attributes the profile requires of it (TMF621 CP v5.0.0 pp.3-4), else
 * the write is `ValidationFailed`.
 */
import {
  isJsonArray,
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Result } from "effect";

import {
  HELPDESK_CLASS_IDS,
  INCIDENT_FIELD_IDS,
  PROBLEM_FIELD_IDS,
  TICKET_FIELD_IDS,
} from "./helpdesk-ids.ts";
import { derivedAttribute } from "./mapping.ts";
import type {
  AttributeIssue,
  HistoryStep,
  RecordContext,
  SourceKey,
  SourceValues,
  ValueAttribute,
  WriteTarget,
} from "./mapping.ts";
import { STATUS_SOURCES, tmf621StatusOf } from "./tmf621-status.ts";

const F = TICKET_FIELD_IDS;

type Written = Result.Result<ReadonlyMap<SourceKey, JsonValue>, AttributeIssue>;

const invalid = (message: string): Written =>
  Result.fail({ kind: "invalidValue", message });

const storedValue = (values: SourceValues, source: SourceKey): JsonValue =>
  values.get(source)?.value ?? null;

/**
 * The items kept in a json field, as rendered: objects only, each with
 * the members the profile requires that STD can fill in (`@type`, and a
 * characteristic's `id`), since a generic write may have stored them
 * without (decision 0035).
 *
 * @param values - The record's readable values.
 * @param source - The json field.
 * @param normalize - Fills an item's defaults.
 * @returns The items.
 */
const storedItems = (
  values: SourceValues,
  source: SourceKey,
  normalize: (item: JsonObject) => JsonObject
): readonly JsonObject[] => {
  const stored = storedValue(values, source);
  const items = stored !== null && isJsonArray(stored) ? stored : [];

  return items.flatMap((item) =>
    item !== null && isJsonObject(item) ? [normalize(item)] : []
  );
};

/**
 * An item's `@type` when it has none.
 *
 * @param type - The default type.
 * @returns The normalizer.
 */
const typed =
  (type: string) =>
  (item: JsonObject): JsonObject =>
    item["@type"] === undefined ? { "@type": type, ...item } : item;

const present = (items: readonly JsonValue[]): JsonValue | undefined =>
  items.length === 0 ? undefined : items;

const textMember = (item: JsonObject, name: string): string | undefined => {
  const value = item[name];

  return value !== undefined && isJsonString(value) && value !== ""
    ? value
    : undefined;
};

/**
 * The items of an array value: `null` is no item; anything but an array
 * of objects is refused.
 *
 * @param name - The attribute.
 * @param value - The value written.
 * @returns The items, or the issue.
 */
const itemsOf = (
  name: string,
  value: JsonValue
): Result.Result<readonly JsonObject[], AttributeIssue> => {
  const items = value ?? [];

  return isJsonArray(items) && items.every(isJsonObject)
    ? Result.succeed(items)
    : Result.fail({
        kind: "invalidValue",
        message: `${name} is an array of objects.`,
      });
};

// Characteristics (Contracts 11.2, `troubleTicketCharacteristic`).

/** How a mapped characteristic's value is stored and rendered. */
interface MappedCharacteristic {
  readonly name: string;
  readonly field: SourceKey;
  /** The class that declares the field. */
  readonly classId: string;
  readonly type: "integer" | "boolean" | "string";
  /** For an integer stored as a choice key (`urgency`). */
  readonly choiceKeys?: readonly string[];
}

const TICKET = HELPDESK_CLASS_IDS.ticket;

/** The characteristics STD maps onto fields. */
export const MAPPED_CHARACTERISTICS: readonly MappedCharacteristic[] = [
  {
    choiceKeys: ["1", "2", "3"],
    classId: TICKET,
    field: F.urgency,
    name: "urgency",
    type: "integer",
  },
  {
    classId: HELPDESK_CLASS_IDS.incident,
    field: INCIDENT_FIELD_IDS.majorIncident,
    name: "majorIncident",
    type: "boolean",
  },
  { classId: TICKET, field: F.holdReason, name: "holdReason", type: "string" },
  {
    classId: TICKET,
    field: F.resolutionCode,
    name: "resolutionCode",
    type: "string",
  },
  {
    classId: TICKET,
    field: F.resolutionNotes,
    name: "resolutionNotes",
    type: "string",
  },
  {
    classId: HELPDESK_CLASS_IDS.problem,
    field: PROBLEM_FIELD_IDS.knownError,
    name: "knownError",
    type: "boolean",
  },
  {
    classId: HELPDESK_CLASS_IDS.problem,
    field: PROBLEM_FIELD_IDS.workaround,
    name: "workaround",
    type: "string",
  },
  {
    classId: HELPDESK_CLASS_IDS.problem,
    field: PROBLEM_FIELD_IDS.rootCause,
    name: "rootCause",
    type: "string",
  },
];

const CHARACTERISTIC_TYPES = {
  boolean: "BooleanCharacteristic",
  integer: "IntegerCharacteristic",
  string: "StringCharacteristic",
} as const;

const renderMapped = (
  mapped: MappedCharacteristic,
  values: SourceValues
): JsonObject | undefined => {
  const stored = values.get(mapped.field)?.value ?? null;

  if (stored === null) {
    return undefined;
  }

  const value =
    mapped.choiceKeys === undefined || !isJsonString(stored)
      ? stored
      : Number(stored);

  return {
    "@type": CHARACTERISTIC_TYPES[mapped.type],
    id: mapped.name,
    name: mapped.name,
    value,
    valueType: mapped.type,
  };
};

const storedValueOf = (
  mapped: MappedCharacteristic,
  given: JsonValue = null
): Result.Result<JsonValue, AttributeIssue> => {
  const fail = Result.fail({
    kind: "invalidValue" as const,
    message: `The characteristic ${mapped.name} takes a ${mapped.type} value.`,
  });

  if (given === null) {
    return Result.succeed(null);
  }

  if (mapped.choiceKeys !== undefined) {
    const key = isJsonNumber(given) || isJsonString(given) ? String(given) : "";

    return mapped.choiceKeys.includes(key) ? Result.succeed(key) : fail;
  }

  const fits =
    (mapped.type === "boolean" && isJsonBoolean(given)) ||
    (mapped.type === "string" && isJsonString(given));

  return fits ? Result.succeed(given) : fail;
};

// The `@type` of a json-stored characteristic without one, by its value.
const characteristicTypeOf = (value: JsonValue | undefined): string => {
  if (value !== undefined && value !== null && isJsonBoolean(value)) {
    return "BooleanCharacteristic";
  }

  if (value !== undefined && value !== null && isJsonNumber(value)) {
    return Number.isInteger(value)
      ? "IntegerCharacteristic"
      : "NumberCharacteristic";
  }

  if (value !== undefined && value !== null && isJsonArray(value)) {
    return "ObjectArrayCharacteristic";
  }

  return value !== undefined && value !== null && isJsonObject(value)
    ? "ObjectCharacteristic"
    : "StringCharacteristic";
};

/**
 * A json-stored characteristic with its defaults: `@type` by its value's
 * JSON type, `id` its name (Contracts 11.2: a characteristic without `id`
 * gets one).
 *
 * @param item - The stored characteristic.
 * @returns The characteristic.
 */
const normalizedCharacteristic = (item: JsonObject): JsonObject => {
  const defaults = new Map<string, JsonValue>([
    ["@type", characteristicTypeOf(item.value)],
  ]);

  if (item.name !== undefined) {
    defaults.set("id", item.name);
  }

  const relationships = item.characteristicRelationship;

  const typedRelationships =
    relationships !== undefined &&
    relationships !== null &&
    isJsonArray(relationships)
      ? {
          characteristicRelationship: relationships.map((relationship) =>
            relationship !== null && isJsonObject(relationship)
              ? typed("CharacteristicRelationship")(relationship)
              : relationship
          ),
        }
      : {};

  return { ...Object.fromEntries(defaults), ...item, ...typedRelationships };
};

/**
 * Whether a characteristic's `characteristicRelationship` items each carry
 * `id` and `relationshipType` (TMF621 CP v5.0.0 pp.3-4; OAS
 * `CharacteristicRelationship_FVO`).
 *
 * @param value - The member, if any.
 * @returns True when absent or valid.
 */
const relationshipsValid = (value: JsonValue | undefined): boolean =>
  value === undefined ||
  (value !== null &&
    isJsonArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        isJsonObject(item) &&
        textMember(item, "id") !== undefined &&
        textMember(item, "relationshipType") !== undefined
    ));

const writeCharacteristics = (
  value: JsonValue,
  current: SourceValues | undefined,
  target: WriteTarget
): Written => {
  const items = itemsOf("troubleTicketCharacteristic", value);

  if (Result.isFailure(items)) {
    return Result.fail(items.failure);
  }

  const written = new Map<SourceKey, JsonValue>();
  const kept: JsonObject[] = [];
  const lineage = new Set(target.lineage);

  for (const item of items.success) {
    const name = textMember(item, "name");

    const mapped = MAPPED_CHARACTERISTICS.find(
      (candidate) => candidate.name === name && lineage.has(candidate.classId)
    );

    if (name === undefined) {
      return invalid("A troubleTicketCharacteristic needs a name.");
    }

    if (!relationshipsValid(item.characteristicRelationship)) {
      return invalid(
        "A characteristicRelationship needs an id and a relationshipType."
      );
    }

    if (mapped !== undefined && written.has(mapped.field)) {
      return invalid(`The characteristic ${name} is given twice.`);
    }

    if (mapped === undefined) {
      kept.push(normalizedCharacteristic(item));
    } else {
      const stored = storedValueOf(mapped, item.value);

      if (Result.isFailure(stored)) {
        return Result.fail(stored.failure);
      }

      written.set(mapped.field, stored.success);
    }
  }

  // Strict RFC 7396: a mapped characteristic the array leaves out is
  // cleared, where the caller can read it (a required one then fails
  // validation, naming its field).
  for (const mapped of MAPPED_CHARACTERISTICS) {
    const readable = current?.has(mapped.field) === true;

    if (readable && lineage.has(mapped.classId) && !written.has(mapped.field)) {
      written.set(mapped.field, null);
    }
  }

  written.set(F.characteristic, kept.length === 0 ? null : kept);

  return Result.succeed(written);
};

/** `troubleTicketCharacteristic` (Contracts 11.2). */
export const characteristicAttribute: ValueAttribute = derivedAttribute({
  name: "troubleTicketCharacteristic",
  optionalSources: MAPPED_CHARACTERISTICS.map((mapped) => mapped.field),
  render: (values) =>
    present([
      ...MAPPED_CHARACTERISTICS.flatMap((mapped) => {
        const rendered = renderMapped(mapped, values);

        return rendered === undefined ? [] : [rendered];
      }),
      ...storedItems(values, F.characteristic, normalizedCharacteristic),
    ]),
  sources: [F.characteristic],
  write: writeCharacteristics,
  writes: [F.characteristic],
});

// Relationships (Contracts 11.2, `troubleTicketRelationship`).

/** The relationship types an incident keeps in reference fields. */
const MAPPED_RELATIONSHIPS = [
  { field: INCIDENT_FIELD_IDS.problem, type: "causedBy" },
  { field: INCIDENT_FIELD_IDS.parentIncident, type: "parent" },
] as const;

const renderRelationship = (
  values: SourceValues,
  context: RecordContext,
  field: SourceKey,
  relationshipType: string
): JsonObject | undefined => {
  const reference = values.get(field)?.reference;

  if (reference === undefined) {
    return undefined;
  }

  const target = reference.targetClassId;

  const href =
    target === null ? undefined : context.hrefOf(target, reference.id);

  const item = new Map<string, JsonValue>([
    ["@type", "TroubleTicketRelationship"],
    ["id", reference.id],
    ["relationshipType", relationshipType],
  ]);

  if (href !== undefined) {
    item.set("href", href);
  }

  if (reference.label !== null) {
    item.set("name", reference.label);
  }

  return Object.fromEntries(item);
};

const writeRelationships = (
  value: JsonValue,
  current: SourceValues | undefined,
  target: WriteTarget
): Written => {
  const items = itemsOf("troubleTicketRelationship", value);

  if (Result.isFailure(items)) {
    return Result.fail(items.failure);
  }

  const incident = target.lineage.includes(HELPDESK_CLASS_IDS.incident);
  const written = new Map<SourceKey, JsonValue>();
  const kept: JsonObject[] = [];

  for (const item of items.success) {
    const id = textMember(item, "id");
    const type = textMember(item, "relationshipType");

    const mapped = MAPPED_RELATIONSHIPS.find(
      (candidate) => incident && candidate.type === type
    );

    if (id === undefined || type === undefined) {
      return invalid(
        "A troubleTicketRelationship needs an id and a relationshipType."
      );
    }

    if (mapped !== undefined && written.has(mapped.field)) {
      return invalid(`An incident has one ${type} relationship.`);
    }

    if (mapped === undefined) {
      kept.push(typed("TroubleTicketRelationship")(item));
    } else {
      written.set(mapped.field, id);
    }
  }

  // A mapped relationship the array leaves out is removed, where the
  // caller can read it (an unreadable field is never named).
  for (const mapped of MAPPED_RELATIONSHIPS) {
    const readable = current?.has(mapped.field) === true;

    if (incident && readable && !written.has(mapped.field)) {
      written.set(mapped.field, null);
    }
  }

  written.set(F.ticketRelationship, kept.length === 0 ? null : kept);

  return Result.succeed(written);
};

/** `troubleTicketRelationship` (Contracts 11.2). */
export const relationshipAttribute: ValueAttribute = derivedAttribute({
  name: "troubleTicketRelationship",
  optionalSources: MAPPED_RELATIONSHIPS.map((mapped) => mapped.field),
  render: (values, context) =>
    present([
      ...MAPPED_RELATIONSHIPS.flatMap((mapped) => {
        const rendered = renderRelationship(
          values,
          context,
          mapped.field,
          mapped.type
        );

        return rendered === undefined ? [] : [rendered];
      }),
      ...storedItems(
        values,
        F.ticketRelationship,
        typed("TroubleTicketRelationship")
      ),
    ]),
  sources: [F.ticketRelationship],
  write: writeRelationships,
  writes: [F.ticketRelationship],
});

// External identifiers (Contracts 11.2, `externalIdentifier`).

/** The owner of the external identifier that is the ticket's number. */
export const NUMBER_OWNER = "STD";

const numberItem = (number: JsonValue): JsonObject | undefined =>
  number !== null && isJsonString(number)
    ? {
        "@type": "ExternalIdentifier",
        externalIdentifierType: "number",
        id: number,
        owner: NUMBER_OWNER,
      }
    : undefined;

const writeExternalIdentifiers = (
  value: JsonValue,
  current: SourceValues | undefined
): Written => {
  const items = itemsOf("externalIdentifier", value);

  if (Result.isFailure(items)) {
    return Result.fail(items.failure);
  }

  const own = numberItem(
    current === undefined ? null : storedValue(current, F.number)
  );

  const kept: JsonObject[] = [];

  for (const item of items.success) {
    const isNumber =
      item.owner === NUMBER_OWNER && item.externalIdentifierType === "number";

    if (isNumber && (own === undefined || item.id !== own.id)) {
      return invalid("The ticket's number is read-only.");
    }

    if (textMember(item, "id") === undefined) {
      return invalid("An externalIdentifier needs an id.");
    }

    if (!isNumber) {
      kept.push(typed("ExternalIdentifier")(item));
    }
  }

  return Result.succeed(
    new Map([[F.externalIdentifier, kept.length === 0 ? null : kept]])
  );
};

/** `externalIdentifier` (Contracts 11.2). */
export const externalIdentifierAttribute: ValueAttribute = derivedAttribute({
  name: "externalIdentifier",
  render: (values) => {
    const own = numberItem(storedValue(values, F.number));

    return present([
      ...(own === undefined ? [] : [own]),
      ...storedItems(values, F.externalIdentifier, typed("ExternalIdentifier")),
    ]);
  },
  sources: [F.number, F.externalIdentifier],
  write: writeExternalIdentifiers,
  writes: [F.externalIdentifier],
});

// Json-only arrays: attachments and related entities.

/** A json array of value objects whose items need some members. */
interface JsonArraySpec {
  readonly name: string;
  readonly source: SourceKey;
  readonly type: string;
  readonly check: (item: JsonObject) => string | undefined;
  /** Fills a stored item's defaults on render; by default its `@type`. */
  readonly normalize?: (item: JsonObject) => JsonObject;
}

const jsonArrayAttribute = (spec: JsonArraySpec): ValueAttribute =>
  derivedAttribute({
    name: spec.name,
    render: (values) =>
      present(
        storedItems(values, spec.source, spec.normalize ?? typed(spec.type))
      ),
    sources: [spec.source],
    write: (value) => {
      const items = itemsOf(spec.name, value);

      if (Result.isFailure(items)) {
        return Result.fail(items.failure);
      }

      const problem = items.success
        .map((item) => spec.check(item))
        .find((found) => found !== undefined);

      return problem === undefined
        ? Result.succeed(
            new Map([
              [
                spec.source,
                items.success.length === 0
                  ? null
                  : items.success.map((item) => typed(spec.type)(item)),
              ],
            ])
          )
        : invalid(problem);
    },
  });

/**
 * `attachment`: references and URLs only (exclusion E22); each item needs
 * `@type`, `id`, `attachmentType` and `mimeType` (TMF621 CP v5.0.0 p.3;
 * OAS `Attachment_FVO`), and inline `content` is refused.
 */
export const attachmentAttribute: ValueAttribute = jsonArrayAttribute({
  check: (item) => {
    const missing = ["@type", "id", "attachmentType", "mimeType"].filter(
      (member) => textMember(item, member) === undefined
    );

    if (item.content !== undefined) {
      return "An attachment is kept as a reference or URL; inline content is not stored.";
    }

    return missing.length === 0
      ? undefined
      : `An attachment needs ${missing.join(", ")}.`;
  },
  name: "attachment",
  source: F.attachment,
  type: "AttachmentRef",
});

/**
 * `relatedEntity`, kept as given until Step 4 maps configuration items
 * and changes: each item needs `role` and an `entity` with `@type` and
 * `id` (TMF621 CP v5.0.0 p.4; OAS `RelatedEntity_FVO`).
 */
export const relatedEntityAttribute: ValueAttribute = jsonArrayAttribute({
  check: (item) => {
    const { entity } = item;

    const object =
      entity !== undefined && entity !== null && isJsonObject(entity)
        ? entity
        : {};

    const entityOk =
      textMember(object, "@type") !== undefined &&
      textMember(object, "id") !== undefined;

    return textMember(item, "role") !== undefined && entityOk
      ? undefined
      : "A relatedEntity needs a role and an entity with @type and id.";
  },
  name: "relatedEntity",
  // A related entity stored by a generic write may lack its reference's
  // `@type`: `EntityRef`, the generic reference type, is its default.
  normalize: (item) => {
    const { entity } = item;

    const withEntity =
      entity !== undefined && entity !== null && isJsonObject(entity)
        ? { ...item, entity: typed("EntityRef")(entity) }
        : item;

    return typed("RelatedEntity")(withEntity);
  },
  source: F.relatedEntity,
  type: "RelatedEntity",
});

// Status change history (Contracts 11.2, `statusChangeHistory`).

/** The fields whose history `statusChangeHistory` renders from. */
const HISTORY_SOURCES: readonly SourceKey[] = [
  ...STATUS_SOURCES,
  F.statusChangeHistory,
];

/**
 * The status changes recorded in a ticket's history: one `StatusChange`
 * per change entry that gave the ticket a new TMF621 status (its create
 * included), with the entry's time and the status reason then.
 *
 * @param history - The change entries, in version order.
 * @returns Each change and the version it was recorded at.
 */
const recordedChanges = (
  history: readonly HistoryStep[]
): readonly { readonly version: number; readonly item: JsonObject }[] => {
  const state = new Map<SourceKey, { readonly value: JsonValue }>(
    STATUS_SOURCES.map((source) => [source, { value: null }])
  );

  let previous: string | undefined;
  const changes: { version: number; item: JsonObject }[] = [];

  for (const step of history) {
    for (const source of STATUS_SOURCES) {
      const value = step.changes.get(source);

      if (value !== undefined) {
        state.set(source, { value });
      }
    }

    const status = tmf621StatusOf(state);
    const reason = state.get(F.statusReason)?.value ?? null;

    if (status !== undefined && status !== previous) {
      const item = new Map<string, JsonValue>([
        ["@type", "StatusChange"],
        ["status", status],
        ["statusChangeDate", step.occurredAt],
      ]);

      if (reason !== null) {
        item.set("statusChangeReason", reason);
      }

      changes.push({ item: Object.fromEntries(item), version: step.version });
    }

    previous = status;
  }

  return changes;
};

/**
 * Renders `statusChangeHistory`: the value last written through the API,
 * as given, then the status changes recorded from that write on (the
 * whole history when none was written) [judgment, Contracts 11.2].
 *
 * @param values - The ticket's readable values.
 * @param context - Its history.
 * @returns The items.
 */
const renderStatusHistory = (
  values: SourceValues,
  context: RecordContext
): JsonValue | undefined => {
  const history = context.history ?? [];

  const written = history.findLast((step) =>
    step.changes.has(F.statusChangeHistory)
  );

  const recorded = recordedChanges(history).filter(
    (change) => written === undefined || change.version >= written.version
  );

  return present([
    ...storedItems(values, F.statusChangeHistory, typed("StatusChange")),
    ...recorded.map((change) => change.item),
  ]);
};

const writeStatusHistory = (value: JsonValue): Written => {
  const items = itemsOf("statusChangeHistory", value);

  return Result.isFailure(items)
    ? Result.fail(items.failure)
    : Result.succeed(
        new Map([
          [
            F.statusChangeHistory,
            value === null
              ? null
              : items.success.map((item) => typed("StatusChange")(item)),
          ],
        ])
      );
};

/**
 * `statusChangeHistory`: patchable in TMF621 (decision 0021, decision 53);
 * absent when the caller cannot read the status or its sources.
 */
export const statusHistoryAttribute: ValueAttribute = derivedAttribute({
  history: HISTORY_SOURCES,
  name: "statusChangeHistory",
  render: renderStatusHistory,
  sources: HISTORY_SOURCES,
  write: writeStatusHistory,
  writes: [F.statusChangeHistory],
});
