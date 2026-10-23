import type { Expr } from "@std/conditions/ast";
import type { Condition } from "@std/definitions/condition";
import type {
  AccessAction,
  AccessRuleDraft,
} from "@std/definitions/definition";
/**
 * A test-only TMF API mapping (Contracts 11.1, workstream 3T): the shape
 * of TMF621's `troubleTicket` over fixture classes in a local `tmffx`
 * namespace, so the framework is proven end to end before TMF621's own
 * mapping exists (workstream 3I). It is served under its own base path and
 * every response is validated against the pinned TMF621 document
 * (`tmf-oas-contract`).
 *
 * - `tmffx.ticket` (TroubleTicket) with `tmffx.incident` (also
 *   TroubleTicket, chosen by `ticketType: incident`) and a local child
 *   `tmffx.vip` of the incident (its own `@type`, `TmffxVip`, with
 *   `@baseType` `TroubleTicket` and its own attribute `vipLevel`);
 * - `tmffx.note`, a part of the ticket (owner reference `ticket`), as the
 *   `note` array;
 * - `status` derived from `status` and `hold_reason` (a state map with a
 *   write and a filter), `relatedParty` derived from `assigned_to`,
 *   `troubleTicketCharacteristic` stored whole in json.
 *
 * Access (acme's roles): the asset manager (Alice) and admins see every
 * ticket; an employee (Bob) sees only tickets not marked `restricted`
 * (which he cannot write), never their `priority`, and only notes not
 * marked `internal`.
 */
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { standardEvents } from "@std/tmf/events";
import {
  derivedAttribute,
  fieldAttribute,
  jsonAttribute,
  partsAttribute,
  SYSTEM_SOURCES,
} from "@std/tmf/mapping";
import type {
  AttributeIssue,
  SourceKey,
  SourceValues,
  TmfApiMapping,
  TmfResourceMapping,
} from "@std/tmf/mapping";
import type { FieldType } from "@std/values/field-type";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Layer, Result } from "effect";

import { acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { contractAt } from "../../testing/src/tmf-oas-contract.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import {
  addField,
  change,
  createClass,
  createNamespace,
  freshId,
} from "./schema-support.ts";

/** The fixture's base path; validated against TMF621's document. */
export const FIXTURE_BASE = "/tmf-api/stdFixtureTicket/v5" as const;

/** The fixture's resource path. */
export const FIXTURE_TICKETS = `${FIXTURE_BASE}/troubleTicket` as const;

const NAMESPACE = createNamespace("tmffx");

const TICKET = createClass("ticket", { namespaceId: NAMESPACE.id });

/** The fixture's classes. */
export const FX = {
  incident: createClass("incident", {
    namespaceId: NAMESPACE.id,
    parentId: TICKET.id,
  }),
  note: createClass("note", { namespaceId: NAMESPACE.id }),
  ticket: TICKET,
} as const;

/** The local child class of the incident (no mapping names it). */
export const VIP = createClass("vip", {
  namespaceId: NAMESPACE.id,
  parentId: FX.incident.id,
});

/**
 * A child class of the note whose `author` an employee may neither read
 * nor write: an existing locked note is updated as its own class.
 */
export const LOCKED_NOTE = createClass("locked_note", {
  namespaceId: NAMESPACE.id,
  parentId: FX.note.id,
});

const text = (maxLength: number): FieldType => ({ kind: "text", maxLength });

/** The fixture's fields. */
export const FF = {
  assignedTo: addField(FX.ticket.id, "assigned_to", {
    kind: "reference",
    targetClassId: USER_CLASS_ID,
  }),
  characteristic: addField(FX.ticket.id, "characteristic", { kind: "json" }),
  customData: addField(FX.ticket.id, "custom_data", { kind: "json" }),
  description: addField(FX.ticket.id, "description", text(4000), {
    required: true,
  }),
  holdReason: addField(FX.ticket.id, "hold_reason", text(40)),
  name: addField(FX.ticket.id, "name", text(160)),
  noteAuthor: addField(FX.note.id, "author", text(120)),
  noteInternal: addField(
    FX.note.id,
    "internal",
    { kind: "boolean" },
    {
      default: false,
    }
  ),
  notePosition: addField(FX.note.id, "position", { kind: "integer" }),
  noteText: addField(FX.note.id, "text", text(4000), { required: true }),
  noteTicket: addField(FX.note.id, "ticket", {
    aggregate: true,
    kind: "reference",
    targetClassId: FX.ticket.id,
  }),
  priority: addField(FX.ticket.id, "priority", text(40)),
  restricted: addField(
    FX.ticket.id,
    "restricted",
    { kind: "boolean" },
    {
      default: false,
    }
  ),
  severity: addField(FX.ticket.id, "severity", text(40)),
  status: addField(FX.ticket.id, "status", text(40), {
    default: "new",
  }),
  statusReason: addField(FX.ticket.id, "status_reason", text(200)),
  ticketType: addField(FX.ticket.id, "ticket_type", text(40)),
  urgency: addField(FX.incident.id, "urgency", { kind: "integer" }),
  vipLevel: addField(VIP.id, "vip_level", { kind: "integer" }),
} as const;

// The TMF621-like state map (Contracts 11.2's table for incidents).
const AWAITING_CALLER = "awaiting_caller";

const READ_STATES: ReadonlyMap<string, string> = new Map([
  ["new", "acknowledged"],
  ["in_progress", "inProgress"],
  ["resolved", "resolved"],
  ["closed", "closed"],
  ["canceled", "cancelled"],
]);

const WRITE_STATES: ReadonlyMap<string, string> = new Map(
  [...READ_STATES].map(([stored, tmf]) => [tmf, stored])
);

const stateOf = (values: SourceValues): JsonValue | undefined => {
  const status = values.get(FF.status.id)?.value;
  const hold = values.get(FF.holdReason.id)?.value;

  if (status === "on_hold") {
    return hold === AWAITING_CALLER ? "pending" : "held";
  }

  return status !== undefined && isJsonString(status)
    ? READ_STATES.get(status)
    : undefined;
};

const writeState = (
  value: JsonValue,
  current: SourceValues | undefined
): Result.Result<ReadonlyMap<SourceKey, JsonValue>, AttributeIssue> => {
  const hold = current?.get(FF.holdReason.id)?.value ?? null;

  if (value === "pending") {
    return Result.succeed(
      new Map<SourceKey, JsonValue>([
        [FF.status.id, "on_hold"],
        [FF.holdReason.id, AWAITING_CALLER],
      ])
    );
  }

  if (value === "held") {
    return Result.succeed(
      new Map<SourceKey, JsonValue>([
        [FF.status.id, "on_hold"],
        [
          FF.holdReason.id,
          hold === null || hold === AWAITING_CALLER ? "awaiting_vendor" : hold,
        ],
      ])
    );
  }

  const stored = isJsonString(value) ? WRITE_STATES.get(value) : undefined;

  return stored === undefined
    ? Result.fail({
        kind: "invalidValue",
        message: "status is one of the TMF621 states STD maps.",
      })
    : Result.succeed(
        new Map<SourceKey, JsonValue>([
          [FF.status.id, stored],
          [FF.holdReason.id, null],
        ])
      );
};

const at = (field: string) => ({ path: [field] });

const filterState = (
  comparison: string,
  values: readonly string[]
): Result.Result<Expr, AttributeIssue> => {
  if (comparison !== "eq") {
    return Result.fail({
      kind: "notSupported",
      message: "status takes equality only.",
    });
  }

  const atoms = values.map((value): Expr => {
    if (value === "pending" || value === "held") {
      return {
        args: [
          { left: at(FF.status.id), op: "eq", right: { value: "on_hold" } },
          value === "pending"
            ? {
                left: at(FF.holdReason.id),
                op: "eq",
                right: { value: AWAITING_CALLER },
              }
            : {
                arg: {
                  left: at(FF.holdReason.id),
                  op: "eq",
                  right: { value: AWAITING_CALLER },
                },
                op: "not",
              },
        ],
        op: "and",
      };
    }

    const stored = WRITE_STATES.get(value);

    return stored === undefined
      ? { op: "false" }
      : { left: at(FF.status.id), op: "eq", right: { value: stored } };
  });

  return Result.succeed({ args: atoms, op: "or" });
};

// `relatedParty` from `assigned_to`: one item, role `assignee`.
const renderParties = (values: SourceValues): JsonValue | undefined => {
  const reference = values.get(FF.assignedTo.id)?.reference;

  if (reference === undefined) {
    return undefined;
  }

  const party = new Map<string, JsonValue>([
    ["@type", "PartyRef"],
    ["id", reference.id],
  ]);

  if (reference.label !== null) {
    party.set("name", reference.label);
  }

  return [
    {
      "@type": "RelatedPartyRefOrPartyRoleRef",
      partyOrPartyRole: Object.fromEntries(party),
      role: "assignee",
    },
  ];
};

const writeParties = (
  value: JsonValue
): Result.Result<ReadonlyMap<SourceKey, JsonValue>, AttributeIssue> => {
  const items = value ?? [];

  if (!isJsonArray(items)) {
    return Result.fail({
      kind: "invalidValue",
      message: "relatedParty is an array.",
    });
  }

  const assignee = items.find(
    (item) => isJsonObject(item) && item.role === "assignee"
  );

  const party =
    assignee !== undefined && isJsonObject(assignee)
      ? assignee.partyOrPartyRole
      : undefined;

  const id = party !== undefined && isJsonObject(party) ? party.id : null;

  return Result.succeed(
    new Map<SourceKey, JsonValue>([[FF.assignedTo.id, id ?? null]])
  );
};

/** The fixture's `troubleTicket` resource. */
export const FIXTURE_RESOURCE: TmfResourceMapping = {
  attributes: [
    fieldAttribute("name", FF.name.id),
    fieldAttribute("description", FF.description.id, {
      requiredOnCreate: true,
    }),
    fieldAttribute("severity", FF.severity.id),
    fieldAttribute("ticketType", FF.ticketType.id),
    fieldAttribute("priority", FF.priority.id),
    derivedAttribute({
      filter: { build: filterState, kind: "custom" },
      name: "status",
      render: stateOf,
      sources: [FF.status.id, FF.holdReason.id],
      write: writeState,
    }),
    derivedAttribute({
      name: "relatedParty",
      render: renderParties,
      sources: [FF.assignedTo.id],
      write: writeParties,
    }),
    jsonAttribute("troubleTicketCharacteristic", FF.characteristic.id),
    fieldAttribute("creationDate", SYSTEM_SOURCES.createdAt, {
      readOnly: true,
    }),
    fieldAttribute("lastUpdate", SYSTEM_SOURCES.updatedAt, { readOnly: true }),
    fieldAttribute("urgency", FF.urgency.id),
    fieldAttribute("restricted", FF.restricted.id),
    jsonAttribute("customData", FF.customData.id),
    fieldAttribute("statusChangeReason", FF.statusReason.id),
    partsAttribute("note", {
      attributes: [
        fieldAttribute("text", FF.noteText.id, { requiredOnCreate: true }),
        fieldAttribute("author", FF.noteAuthor.id),
        fieldAttribute("date", SYSTEM_SOURCES.createdAt, { readOnly: true }),
      ],
      classId: FX.note.id,
      orderField: FF.notePosition.id,
      ownerField: FF.noteTicket.id,
      type: "Note",
    }),
  ],
  classId: FX.ticket.id,
  createClass: (body, byType) =>
    Result.succeed(body.ticketType === "incident" ? FX.incident.id : byType),
  // TMF621 v5.0.1's declared statuses (checked against the document in
  // `tmf-oas-contract`).
  declaredStatuses: {
    create: [201, 202, 400, 401, 403, 404, 405, 409, 500, 501, 503],
    delete: [202, 204, 400, 401, 403, 404, 405, 409, 500, 501, 503],
    list: [200, 400, 401, 403, 404, 405, 500, 501, 503],
    patch: [200, 202, 400, 401, 403, 404, 405, 409, 500, 501, 503],
    retrieve: [200, 400, 401, 403, 404, 405, 500, 501, 503],
  },
  events: standardEvents({
    status: { sources: [FF.status.id, FF.holdReason.id] },
    type: "TroubleTicket",
  }),
  name: "troubleTicket",
  operations: ["list", "retrieve", "create", "patch", "delete"],
  type: "TroubleTicket",
  types: [
    { classId: FX.ticket.id, createTarget: true, type: "TroubleTicket" },
    { classId: FX.incident.id, createTarget: false, type: "TroubleTicket" },
  ],
};

/** The fixture API. */
export const FIXTURE_API: TmfApiMapping = {
  basePath: FIXTURE_BASE,
  resources: [FIXTURE_RESOURCE],
  spec: "TMF621",
};

const accessRule = (
  classId: string,
  roleIds: readonly string[],
  rule: {
    readonly actions: readonly AccessAction[];
    readonly effect?: "allow" | "deny";
    readonly fields?: "*" | readonly string[];
    readonly condition?: Condition;
  }
): AccessRuleDraft => ({
  actions: rule.actions,
  active: true,
  classId,
  condition: rule.condition ?? null,
  description: null,
  effect: rule.effect ?? "allow",
  id: freshId(),
  kind: "accessRule",
  name: null,
  owner: { layer: "local" },
  protected: false,
  roleIds,
  target:
    rule.fields === undefined
      ? { kind: "records" }
      : { fields: rule.fields, kind: "fields" },
});

const ALL: readonly AccessAction[] = ["read", "create", "update", "delete"];

/**
 * Creates the fixture's classes, fields and access rules (after the acme
 * fixture, whose roles they name).
 */
export const setUpTmfFixture = Effect.gen(function* setUpTmfFixture() {
  yield* change([
    NAMESPACE.op,
    FX.ticket.op,
    FX.incident.op,
    FX.note.op,
    VIP.op,
    LOCKED_NOTE.op,
    ...Object.values(FF).map((entry) => entry.op),
  ]);

  const snapshot = yield* (yield* Catalog).refresh;
  const manager = snapshot.roleByName("asset_manager")?.id ?? "";
  const employee = snapshot.roleByName("employee")?.id ?? "";
  const both = [manager, employee];

  const open: Condition = {
    left: { path: [FF.restricted.id] },
    op: "eq",
    right: { value: false },
  };

  const writable = [
    FF.name.id,
    FF.description.id,
    FF.severity.id,
    FF.ticketType.id,
    FF.status.id,
    FF.holdReason.id,
    FF.assignedTo.id,
    FF.characteristic.id,
    FF.customData.id,
  ];

  const rules: AccessRuleDraft[] = [
    accessRule(FX.ticket.id, [manager], { actions: ALL }),
    accessRule(FX.ticket.id, [manager], {
      actions: ["read", "create", "update"],
      fields: "*",
    }),
    accessRule(FX.ticket.id, [employee], { actions: ALL, condition: open }),
    accessRule(FX.ticket.id, [employee], { actions: ["read"], fields: "*" }),
    accessRule(FX.ticket.id, [employee], {
      actions: ["create", "update"],
      fields: writable,
    }),
    accessRule(FX.ticket.id, [employee], {
      actions: ["read"],
      effect: "deny",
      fields: [FF.priority.id],
    }),
    accessRule(FX.incident.id, both, {
      actions: ["read", "create", "update"],
      fields: "*",
    }),
    accessRule(VIP.id, both, {
      actions: ["read", "create", "update"],
      fields: "*",
    }),
    accessRule(FX.note.id, [manager], { actions: ALL }),
    accessRule(FX.note.id, [employee], {
      actions: ALL,
      condition: {
        left: { path: [FF.noteInternal.id] },
        op: "eq",
        right: { value: false },
      },
    }),
    accessRule(FX.note.id, both, {
      actions: ["read", "create", "update"],
      fields: "*",
    }),
    accessRule(LOCKED_NOTE.id, both, {
      actions: ["read", "create", "update"],
      fields: "*",
    }),
    accessRule(LOCKED_NOTE.id, [employee], {
      actions: ["read", "create", "update"],
      effect: "deny",
      fields: [FF.noteAuthor.id],
    }),
    // The manager reads a locked note's position but may neither create
    // nor update it: nameable, not writable (decision 0033).
    accessRule(LOCKED_NOTE.id, [manager], {
      actions: ["create", "update"],
      effect: "deny",
      fields: [FF.notePosition.id],
    }),
    // The manager does not read the position of a note whose text is
    // "masked position": a conditional mask on that record only.
    accessRule(FX.note.id, [manager], {
      actions: ["read"],
      condition: {
        left: { path: [FF.noteText.id] },
        op: "eq",
        right: { value: "masked position" },
      },
      effect: "deny",
      fields: [FF.notePosition.id],
    }),
    // Employees may write a note's position but not read it: they cannot
    // see the order it stores, so they may not reorder (decision 0033).
    accessRule(FX.note.id, [employee], {
      actions: ["read"],
      effect: "deny",
      fields: [FF.notePosition.id],
    }),
  ];

  yield* change(
    rules.map((definition) => ({ definition, op: "createAccessRule" }))
  );
});

/**
 * The acme fixture, the TMF fixture's classes and rules, and an HTTP
 * client that also serves the fixture API and checks its responses
 * against TMF621's document.
 *
 * @returns The layer.
 */
export const tmfTestLayer = () =>
  TestHttpClient.layerWith({
    contracts: [contractAt("TMF621", FIXTURE_BASE)],
    tmfApis: [FIXTURE_API],
  }).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(setUpTmfFixture).pipe(
        Layer.provideMerge(acmeTestLayer())
      )
    )
  );
