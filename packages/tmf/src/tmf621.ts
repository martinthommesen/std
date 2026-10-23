/**
 * TMF621 Trouble Ticket v5.0.1 over the helpdesk set v3 (Contracts 11.2;
 * decisions 0021, 0034 and 0035): `troubleTicket` over `helpdesk.ticket`
 * and its subtree (`helpdesk.incident`, `helpdesk.problem`, local
 * classes), and `troubleTicketSpecification` over
 * `helpdesk.ticket_specification`, at the pinned base path
 * `/tmf-api/troubleTicket/v5`.
 *
 * - `@type` is `TroubleTicket` for the shipped classes; the ITIL class is
 *   `ticketType` (`incident`, `problem`), and any other value makes a
 *   plain ticket with its `ticket_type` (decision 0021, decision 40).
 * - `severity` and `priority` are free text over `impact` and `priority`
 *   (`tmf621-labels.ts`); `status` maps the ITIL state models
 *   (`tmf621-status.ts`); the value-object arrays mix fields and json
 *   (`tmf621-arrays.ts`).
 * - `note` and `relatedParty` are arrays of aggregate parts
 *   (`helpdesk.ticket_note`, `helpdesk.ticket_party`), merged by strict RFC
 *   7396 (decision 0021, decision 41); `relatedParty`'s `reporter` and
 *   `assignee` are the ticket's `caller` and `assigned_to` (the assignee
 *   rendered as the user's individual, Contracts 11.3).
 * - Events: Create, AttributeValueChange, StatusChange (the TMF status
 *   changed), Resolved (entered `resolved`), InformationRequired (entered
 *   `pending`) and Delete, for the hubs of workstream 3H (Contracts 12).
 */
import type { Expr } from "@std/conditions/ast";
import { PARTY_CLASS_IDS, USER_FIELD_IDS } from "@std/definitions/well-known";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Result } from "effect";

import { changedAny, standardEvents } from "./events.ts";
import {
  HELPDESK_CLASS_IDS,
  INCIDENT_FIELD_IDS,
  NOTE_FIELD_IDS,
  PARTY_LINK_FIELD_IDS,
  SPECIFICATION_FIELD_IDS,
  TICKET_FIELD_IDS,
} from "./helpdesk-ids.ts";
import {
  derivedAttribute,
  fieldAttribute,
  jsonAttribute,
  partsAttribute,
  pathSource,
  referenceAttribute,
  referenceLabelAttribute,
  SYSTEM_SOURCES,
} from "./mapping.ts";
import type {
  AttributeIssue,
  ChangeView,
  EventRule,
  FilterComparison,
  FilterContext,
  OwnerItem,
  RecordContext,
  ReferenceValue,
  SourceKey,
  SourceValues,
  TmfApiMapping,
  TmfOperation,
  TmfResourceMapping,
  WriteTarget,
} from "./mapping.ts";
import {
  attachmentAttribute,
  characteristicAttribute,
  externalIdentifierAttribute,
  relatedEntityAttribute,
  relationshipAttribute,
  statusHistoryAttribute,
} from "./tmf621-arrays.ts";
import {
  labelledChoiceAttribute,
  PRIORITY_LABELS,
  SEVERITY_LABELS,
} from "./tmf621-labels.ts";
import {
  filterTmf621Status,
  softStatusWrites,
  STATUS_SOURCES,
  tmf621StatusOf,
  writeTmf621Status,
} from "./tmf621-status.ts";

const C = HELPDESK_CLASS_IDS;
const F = TICKET_FIELD_IDS;

/** The pinned base path (Contracts 11.1; `pins.json`). */
export const TMF621_BASE_PATH = "/tmf-api/troubleTicket/v5" as const;

/** The TMF type of every shipped ticket class. */
export const TROUBLE_TICKET = "TroubleTicket";

/**
 * TMF621 v5.0.1's declared statuses of the resource operations, the same
 * for `troubleTicket` and `troubleTicketSpecification` (checked against
 * the document in `tmf-oas-contract`).
 */
const DECLARED_STATUSES: Readonly<Record<TmfOperation, readonly number[]>> = {
  create: [201, 202, 400, 401, 403, 404, 405, 409, 500, 501, 503],
  delete: [202, 204, 400, 401, 403, 404, 405, 409, 500, 501, 503],
  list: [200, 400, 401, 403, 404, 405, 500, 501, 503],
  patch: [200, 202, 400, 401, 403, 404, 405, 409, 500, 501, 503],
  retrieve: [200, 400, 401, 403, 404, 405, 500, 501, 503],
};

const OPERATIONS: readonly TmfOperation[] = [
  "list",
  "retrieve",
  "create",
  "patch",
  "delete",
];

// ticketType (Contracts 11.2; decision 0021, decision 40).

/** The `ticketType` of a plain ticket without a `ticket_type`. */
export const PLAIN_TICKET_TYPE = "ticket";

/** The ITIL classes `ticketType` names, by their value. */
const CLASS_TYPES = [
  { classId: C.incident, type: "incident" },
  { classId: C.problem, type: "problem" },
] as const;

const classTypeOf = (text: string) =>
  CLASS_TYPES.find((entry) => entry.type === text.trim().toLowerCase());

const lineageType = (lineage: readonly string[]) =>
  CLASS_TYPES.find((entry) => lineage.includes(entry.classId));

const textOf = (values: SourceValues, source: SourceKey): string | null => {
  const value = values.get(source)?.value ?? null;

  return value !== null && isJsonString(value) ? value : null;
};

const renderTicketType = (
  values: SourceValues,
  context: RecordContext
): JsonValue | undefined => {
  const own = lineageType(context.lineage);
  const stored = textOf(values, F.ticketType);

  if (own !== undefined) {
    return own.type;
  }

  return stored === null || stored === "" ? PLAIN_TICKET_TYPE : stored;
};

const writeTicketType = (
  value: JsonValue,
  _current: SourceValues | undefined,
  target: WriteTarget
): Result.Result<ReadonlyMap<SourceKey, JsonValue>, AttributeIssue> => {
  if (value === null || !isJsonString(value) || value.trim() === "") {
    return Result.fail({
      kind: "invalidValue",
      message: "ticketType is a non-blank string.",
    });
  }

  const own = lineageType(target.lineage);
  const named = classTypeOf(value);

  // A value that would change the concrete class is refused; an ITIL
  // class's own type writes nothing.
  if (own !== undefined || named !== undefined) {
    return own === named
      ? Result.succeed(new Map())
      : Result.fail({
          kind: "invalidValue",
          message:
            "ticketType cannot change a ticket's class (incident, problem or another type).",
        });
  }

  return Result.succeed(new Map([[F.ticketType, value]]));
};

const CLASS_SOURCE = "system:class";

const filterTicketType = (
  comparison: FilterComparison,
  values: readonly string[],
  context: FilterContext
): Result.Result<Expr, AttributeIssue> => {
  if (comparison !== "eq") {
    return Result.fail({
      kind: "notSupported",
      message: "ticketType takes equality only.",
    });
  }

  const classIn = (classId: string): Expr => {
    const names = context.subtreeNamesOf(classId);

    return names.length === 0
      ? { op: "false" }
      : {
          left: { path: [CLASS_SOURCE] },
          op: "in",
          right: names.map((name) => ({ value: name })),
        };
  };

  const plain: Expr = {
    arg: {
      args: CLASS_TYPES.map((entry) => classIn(entry.classId)),
      op: "or",
    },
    op: "not",
  };

  // Values compare as rendered, exactly (decision 0025, D4): an ITIL
  // class's own type also selects plain tickets that a generic write gave
  // that `ticket_type`, which render it too.
  const atoms = values.map((value): Expr => {
    const named = CLASS_TYPES.find((entry) => entry.type === value);

    const stored: Expr = {
      left: { path: [F.ticketType] },
      op: "eq",
      right: { value },
    };

    const plainOfType: Expr = {
      args: [
        plain,
        value === PLAIN_TICKET_TYPE
          ? {
              args: [stored, { arg: { path: [F.ticketType] }, op: "empty" }],
              op: "or",
            }
          : stored,
      ],
      op: "and",
    };

    return named === undefined
      ? plainOfType
      : { args: [classIn(named.classId), plainOfType], op: "or" };
  });

  return Result.succeed({ args: atoms, op: "or" });
};

/** `ticketType`: required on create, patchable within the class. */
const ticketTypeAttribute = derivedAttribute({
  filter: { build: filterTicketType, kind: "custom" },
  name: "ticketType",
  render: renderTicketType,
  requiredOnCreate: true,
  sort: F.ticketType,
  sources: [F.ticketType],
  write: writeTicketType,
});

/**
 * The class a create makes (Contracts 11.2): `ticketType` `incident` or
 * `problem` makes that class, any other value a plain ticket; a local
 * class's own `@type` makes that class, and `ticketType` must then fit it
 * (checked by the attribute's write against the class's lineage).
 *
 * @param body - The create body.
 * @param byType - The class the body's `@type` names, if any.
 * @returns The class.
 */
const createTicketClass = (
  body: JsonObject,
  byType: string | undefined
): Result.Result<string | undefined, AttributeIssue> => {
  const { ticketType } = body;

  if (byType !== undefined && byType !== C.ticket) {
    return Result.succeed(byType);
  }

  const named =
    ticketType !== undefined && ticketType !== null && isJsonString(ticketType)
      ? classTypeOf(ticketType)
      : undefined;

  return Result.succeed(named?.classId ?? byType);
};

// status (Contracts 11.2; tmf621-status.ts).

const statusAttribute = derivedAttribute({
  filter: { build: filterTmf621Status, kind: "custom" },
  name: "status",
  render: (values) => tmf621StatusOf(values),
  softWrites: softStatusWrites,
  sort: F.status,
  sources: STATUS_SOURCES,
  write: writeTmf621Status,
});

// channel (Contracts 11.2: key ↔ ChannelRef.id, label ↔ name).

/** The shipped labels of the channel choices (decision 0034). */
const CHANNEL_NAMES: ReadonlyMap<string, string> = new Map([
  ["email", "Email"],
  ["phone", "Phone"],
  ["web", "Web"],
  ["monitoring", "Monitoring"],
  ["other", "Other"],
]);

/**
 * A channel's `ChannelRef`: its choice key as `id`, its shipped label as
 * `name`.
 *
 * @param key - The choice key.
 * @returns The reference.
 */
const channelRefOf = (key: string): JsonObject => {
  const channel = new Map<string, JsonValue>([
    ["@type", "ChannelRef"],
    ["id", key],
  ]);

  const name = CHANNEL_NAMES.get(key);

  if (name !== undefined) {
    channel.set("name", name);
  }

  return Object.fromEntries(channel);
};

const channelAttribute = derivedAttribute({
  name: "channel",
  render: (values) => {
    const key = textOf(values, F.channel);

    return key === null ? undefined : channelRefOf(key);
  },
  sort: F.channel,
  sources: [F.channel],
  write: (value) => {
    const id = value !== null && isJsonObject(value) ? value.id : undefined;

    if (value === null) {
      return Result.succeed(new Map([[F.channel, null]]));
    }

    return id !== undefined && isJsonString(id)
      ? Result.succeed(new Map([[F.channel, id]]))
      : Result.fail({
          kind: "invalidValue",
          message: "channel is a ChannelRef with an id.",
        });
  },
});

// relatedParty (Contracts 11.2, 11.3).

/** The TMF632 type of each party class (Contracts 11.3). */
const PARTY_TYPES: ReadonlyMap<string, string> = new Map([
  [PARTY_CLASS_IDS.individual, "Individual"],
  [PARTY_CLASS_IDS.organization, "Organization"],
  [PARTY_CLASS_IDS.party, "Party"],
]);

/** The role of the related party that is the ticket's caller. */
export const REPORTER_ROLE = "reporter";

/** The role of the related party that is the ticket's assignee. */
export const ASSIGNEE_ROLE = "assignee";

const RELATED_PARTY = "RelatedPartyRefOrPartyRoleRef";

/**
 * A `PartyRef` (Contracts 11.3): `id`, the `name` the caller may see and
 * `@referredType` the TMF632 type of the party's class; no `href` until
 * Step 4 serves TMF632.
 *
 * @param id - The party's ID.
 * @param name - Its label, if the caller may see it.
 * @param referredType - Its TMF632 type, if known.
 * @returns The reference.
 */
const partyRef = (
  id: string,
  name: string | null,
  referredType: string | undefined
): JsonObject => {
  const ref = new Map<string, JsonValue>([
    ["@type", "PartyRef"],
    ["id", id],
  ]);

  if (name !== null) {
    ref.set("name", name);
  }

  if (referredType !== undefined) {
    ref.set("@referredType", referredType);
  }

  return Object.fromEntries(ref);
};

const partyRefOf = (
  reference: ReferenceValue,
  context: RecordContext
): JsonObject => {
  const target = reference.targetClassId;

  const referredType =
    target === null
      ? undefined
      : (PARTY_TYPES.get(target) ?? context.typeOf(target));

  return partyRef(reference.id, reference.label, referredType);
};

const relatedPartyItem = (role: string, party: JsonObject): JsonObject => ({
  "@type": RELATED_PARTY,
  partyOrPartyRole: party,
  role,
});

/**
 * The party ID a related party names (`partyOrPartyRole.id`).
 *
 * @param item - The related party.
 * @returns The ID, if it names one.
 */
const partyIdOf = (item: JsonObject): string | undefined => {
  const party = item.partyOrPartyRole;

  const id =
    party !== undefined && party !== null && isJsonObject(party)
      ? party.id
      : undefined;

  return id !== undefined && id !== null && isJsonString(id) ? id : undefined;
};

const noPartyId = (role: string) =>
  Result.fail({
    kind: "invalidValue" as const,
    message: `A ${role} related party needs partyOrPartyRole.id.`,
  });

const ASSIGNEE_INDIVIDUAL = pathSource(F.assignedTo, USER_FIELD_IDS.individual);

/** `reporter` ↔ the ticket's `caller` (a party). */
const reporterItem: OwnerItem = {
  matches: (item) => item.role === REPORTER_ROLE,
  name: REPORTER_ROLE,
  render: (values, context) => {
    const reference = values.get(F.caller)?.reference;

    return reference === undefined
      ? undefined
      : relatedPartyItem(REPORTER_ROLE, partyRefOf(reference, context));
  },
  sources: [F.caller],
  write: (item) => {
    const id = item === null ? null : partyIdOf(item);

    return id === undefined
      ? noPartyId(REPORTER_ROLE)
      : Result.succeed(new Map([[F.caller, id]]));
  },
  writes: [F.caller],
};

/**
 * `assignee` ↔ the ticket's `assigned_to` (a user), rendered as the
 * user's individual and written by it (Contracts 11.2, 11.3).
 */
const assigneeItem: OwnerItem = {
  matches: (item) => item.role === ASSIGNEE_ROLE,
  name: ASSIGNEE_ROLE,
  render: (values) => {
    const individual = textOf(values, ASSIGNEE_INDIVIDUAL);
    const label = values.get(F.assignedTo)?.reference?.label ?? null;

    return individual === null
      ? undefined
      : relatedPartyItem(
          ASSIGNEE_ROLE,
          partyRef(
            individual,
            label,
            PARTY_TYPES.get(PARTY_CLASS_IDS.individual)
          )
        );
  },
  sources: [F.assignedTo, ASSIGNEE_INDIVIDUAL],
  write: (item) => {
    const id = item === null ? null : partyIdOf(item);

    return id === undefined
      ? noPartyId(ASSIGNEE_ROLE)
      : Result.succeed(new Map([[ASSIGNEE_INDIVIDUAL, id]]));
  },
  writes: [ASSIGNEE_INDIVIDUAL],
};

const P = PARTY_LINK_FIELD_IDS;

/** A related party's `partyOrPartyRole`, over `helpdesk.ticket_party.party`. */
const partyOrPartyRoleAttribute = derivedAttribute({
  name: "partyOrPartyRole",
  render: (values, context) => {
    const reference = values.get(P.party)?.reference;

    return reference === undefined ? undefined : partyRefOf(reference, context);
  },
  requiredOnCreate: true,
  sources: [P.party],
  write: (value) => {
    const id =
      value !== null && isJsonObject(value)
        ? partyIdOf({ partyOrPartyRole: value })
        : undefined;

    return id === undefined
      ? Result.fail({
          kind: "invalidValue",
          message: "partyOrPartyRole is a party reference with an id.",
        })
      : Result.succeed(new Map([[P.party, id]]));
  },
});

const relatedPartyAttribute = partsAttribute(
  "relatedParty",
  {
    attributes: [
      fieldAttribute("role", P.role, { requiredOnCreate: true }),
      partyOrPartyRoleAttribute,
    ],
    classId: C.party,
    ownerField: P.ticket,
    type: RELATED_PARTY,
  },
  { ownerItems: [reporterItem, assigneeItem] }
);

// note (Contracts 11.2: author, date, text).

const N = NOTE_FIELD_IDS;

const noteAttribute = partsAttribute("note", {
  attributes: [
    fieldAttribute("text", N.text, { requiredOnCreate: true }),
    referenceLabelAttribute("author", N.author),
    fieldAttribute("date", SYSTEM_SOURCES.createdAt, { readOnly: true }),
  ],
  classId: C.note,
  // A note's author is the acting user (the shipped `note_author` rule):
  // a new note may repeat the caller's own name (decision 0035).
  newItemRendering: (actor) =>
    actor?.label === null || actor?.label === undefined
      ? {}
      : { author: actor.label },
  ownerField: N.ticket,
  type: "Note",
});

// Events (Contracts 11.2, 12).

const statusOfImage = (values: SourceValues | undefined) =>
  values === undefined ? undefined : tmf621StatusOf(values);

const enters =
  (status: string) =>
  (change: ChangeView): boolean =>
    statusOfImage(change.after) === status &&
    statusOfImage(change.before) !== undefined &&
    statusOfImage(change.before) !== status;

/**
 * What a ticket's status events carry: the status with its date and
 * reason (TMF630 v5.0.0 Part 1 §11.6.3 p.203).
 */
const STATUS_PAYLOAD = ["status", "statusChangeDate", "statusChangeReason"];

/** The TroubleTicket event types (TMF621 UG v5.0.1 pp.38-39). */
const TICKET_EVENTS: readonly EventRule[] = [
  ...standardEvents({ type: TROUBLE_TICKET }),
  {
    on: "update",
    payload: STATUS_PAYLOAD,
    triggers: STATUS_SOURCES,
    type: "TroubleTicketStatusChangeEvent",
    when: (change) => {
      const before = statusOfImage(change.before);
      const after = statusOfImage(change.after);

      return (
        before !== undefined &&
        after !== undefined &&
        before !== after &&
        changedAny(change, STATUS_SOURCES)
      );
    },
  },
  {
    on: "update",
    payload: STATUS_PAYLOAD,
    triggers: STATUS_SOURCES,
    type: "TroubleTicketResolvedEvent",
    when: enters("resolved"),
  },
  {
    on: "update",
    payload: STATUS_PAYLOAD,
    triggers: STATUS_SOURCES,
    type: "TroubleTicketInformationRequiredEvent",
    when: enters("pending"),
  },
];

/** TMF621 `troubleTicket` (Contracts 11.2). */
export const TROUBLE_TICKET_RESOURCE: TmfResourceMapping = {
  attributes: [
    fieldAttribute("name", F.shortDescription),
    fieldAttribute("description", F.description, { requiredOnCreate: true }),
    labelledChoiceAttribute({
      key: F.impact,
      label: F.severityLabel,
      labels: SEVERITY_LABELS,
      name: "severity",
      requiredOnCreate: true,
    }),
    labelledChoiceAttribute({
      key: F.priority,
      label: F.priorityLabel,
      labels: PRIORITY_LABELS,
      name: "priority",
      requiredOnCreate: false,
    }),
    ticketTypeAttribute,
    statusAttribute,
    fieldAttribute("statusChangeDate", F.statusChangedAt, { readOnly: true }),
    fieldAttribute("statusChangeReason", F.statusReason),
    statusHistoryAttribute,
    fieldAttribute("creationDate", SYSTEM_SOURCES.createdAt, {
      readOnly: true,
    }),
    fieldAttribute("lastUpdate", SYSTEM_SOURCES.updatedAt, { readOnly: true }),
    fieldAttribute("requestedResolutionDate", F.requestedResolutionAt),
    fieldAttribute("expectedResolutionDate", F.expectedResolutionAt),
    fieldAttribute("resolutionDate", F.resolvedAt),
    channelAttribute,
    noteAttribute,
    relatedPartyAttribute,
    relationshipAttribute,
    relatedEntityAttribute,
    characteristicAttribute,
    externalIdentifierAttribute,
    attachmentAttribute,
    referenceAttribute("troubleTicketSpecification", F.specification, {
      refType: "TroubleTicketSpecificationRef",
    }),
    // An STD extension attribute (decision 0021, decision 44's pattern):
    // TMF621 has no category; the ITIL incident category is shown as is.
    derivedAttribute({
      name: "category",
      optionalSources: [INCIDENT_FIELD_IDS.category],
      render: (values) =>
        values.get(INCIDENT_FIELD_IDS.category)?.value ?? undefined,
      sources: [],
      write: (value) =>
        Result.succeed(new Map([[INCIDENT_FIELD_IDS.category, value]])),
      writes: [],
    }),
  ],
  classId: C.ticket,
  createClass: createTicketClass,
  declaredStatuses: DECLARED_STATUSES,
  events: TICKET_EVENTS,
  name: "troubleTicket",
  operations: OPERATIONS,
  type: TROUBLE_TICKET,
  types: [
    { classId: C.ticket, createTarget: true, type: TROUBLE_TICKET },
    { classId: C.incident, createTarget: false, type: TROUBLE_TICKET },
    { classId: C.problem, createTarget: false, type: TROUBLE_TICKET },
  ],
};

// troubleTicketSpecification (Contracts 11.2; decision 0021, decision 38).

const S = SPECIFICATION_FIELD_IDS;

/** The TMF type of a ticket specification. */
export const TROUBLE_TICKET_SPECIFICATION = "TroubleTicketSpecification";

/** TMF621 `troubleTicketSpecification`, served minimally (decision 38). */
export const TROUBLE_TICKET_SPECIFICATION_RESOURCE: TmfResourceMapping = {
  attributes: [
    fieldAttribute("name", S.name, { requiredOnCreate: true }),
    fieldAttribute("description", S.description),
    fieldAttribute("lifecycleStatus", S.lifecycleStatus),
    fieldAttribute("version", S.version),
    jsonAttribute("relatedParty", S.relatedParty),
    jsonAttribute("attachment", S.attachment),
    jsonAttribute("specCharacteristic", S.characteristicSpecification),
    fieldAttribute("creationDate", SYSTEM_SOURCES.createdAt, {
      readOnly: true,
    }),
    fieldAttribute("lastUpdate", SYSTEM_SOURCES.updatedAt, { readOnly: true }),
  ],
  classId: C.specification,
  declaredStatuses: DECLARED_STATUSES,
  events: standardEvents({
    status: { payload: ["lifecycleStatus"], sources: [S.lifecycleStatus] },
    type: TROUBLE_TICKET_SPECIFICATION,
  }),
  name: "troubleTicketSpecification",
  operations: OPERATIONS,
  type: TROUBLE_TICKET_SPECIFICATION,
  types: [
    {
      classId: C.specification,
      createTarget: true,
      type: TROUBLE_TICKET_SPECIFICATION,
    },
  ],
};

/** TMF621 Trouble Ticket (Contracts 11.1, 11.2). */
export const TMF621_API: TmfApiMapping = {
  basePath: TMF621_BASE_PATH,
  // The statuses TMF621 v5.0.1 declares explicitly for its hub operations
  // (Contracts 12.2), for workstream 3H.
  hubStatuses: { create: [201], delete: [204], retrieve: [200] },
  resources: [TROUBLE_TICKET_RESOURCE, TROUBLE_TICKET_SPECIFICATION_RESOURCE],
  spec: "TMF621",
};
