/**
 * Test-fixture aggregates for the aggregates workstream (Contracts 4.9,
 * 4.10, 14.4), in the local `site` namespace, never in a shipped set:
 *
 * - `ag_ticket` owns `ag_note` (two levels): a part-only change;
 * - `ag_request` owns `ag_item`, which owns `ag_item_approval` (three
 *   levels, the shape of 14.4's request, item and item approval);
 * - `ag_change` owns `ag_change_approval` (the shape of 14.4's change,
 *   with rounds), and `ag_authority` lists who approves a change type;
 * - `ag_loop` owns `ag_loop_part`, whose rule never settles.
 *
 * The rules follow 14.4's shipped rules for those shapes, written with the
 * fixture's own fields. Every record goes through the record service with
 * every record visible and allowed, and the record-rule hooks.
 */
import { InvalidTransition } from "@std/api/errors/invalid-transition";
import type { Condition } from "@std/definitions/condition";
import type { RuleAction, RuleValue } from "@std/definitions/rule-definition";
import type { FieldType } from "@std/values/field-type";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";

import { Actor } from "../src/auth/actor.ts";
import { InstanceSettings } from "../src/config/instance-settings.ts";
import { RecordRuleSaveHooks } from "../src/hooks/record-rule-hooks.ts";
import { ChangeCauseSchema } from "../src/records/change-entry.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import type { SaveResult } from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { actorOf, setUpAcme, USERS } from "./records-support.ts";
import {
  addField,
  addIndex,
  addRecordRule,
  change,
  createClass,
  ensureSite,
  freshId,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { waitUntil } from "./support.ts";

/** The fixture's classes. */
export const C = {
  authority: createClass("ag_authority"),
  change: createClass("ag_change"),
  changeApproval: createClass("ag_change_approval"),
  item: createClass("ag_item"),
  itemApproval: createClass("ag_item_approval"),
  loop: createClass("ag_loop"),
  loopPart: createClass("ag_loop_part"),
  note: createClass("ag_note"),
  request: createClass("ag_request"),
  ticket: createClass("ag_ticket"),
} as const;

const text = (maxLength = 60): FieldType => ({ kind: "text", maxLength });
const INTEGER: FieldType = { kind: "integer" };

/**
 * The reference type identifying a part's aggregate owner.
 * @param targetClassId - The owner's class.
 * @returns The owner reference type.
 */
export const owner = (targetClassId: string): FieldType => ({
  aggregate: true,
  kind: "reference",
  targetClassId,
});

/** The fixture's fields. */
export const F = {
  approvalApprover: addField(C.changeApproval.id, "approver", text()),
  approvalChange: addField(C.changeApproval.id, "change", owner(C.change.id)),
  approvalRound: addField(C.changeApproval.id, "round", INTEGER),
  approvalState: addField(C.changeApproval.id, "state", text()),
  approvalTouches: addField(C.changeApproval.id, "touches", INTEGER),
  authorityApprover: addField(C.authority.id, "approver", text()),
  authorityType: addField(C.authority.id, "change_type", text()),
  changeEnd: addField(C.change.id, "planned_end", text()),
  changeName: addField(C.change.id, "name", text()),
  changeRound: addField(C.change.id, "approval_round", INTEGER),
  changeStart: addField(C.change.id, "planned_start", text()),
  changeStatus: addField(C.change.id, "status", text()),
  changeTouches: addField(C.change.id, "touches", INTEGER),
  changeType: addField(C.change.id, "change_type", text()),
  itemApprovalItem: addField(C.itemApproval.id, "item", owner(C.item.id)),
  itemApprovalRound: addField(C.itemApproval.id, "round", INTEGER),
  itemApprovalState: addField(C.itemApproval.id, "state", text()),
  itemName: addField(C.item.id, "name", text()),
  itemNeeds: addField(C.item.id, "needs_approval", { kind: "boolean" }),
  itemOutcome: addField(C.item.id, "outcome", text()),
  itemRequest: addField(C.item.id, "request", owner(C.request.id)),
  itemRound: addField(C.item.id, "approval_round", INTEGER),
  itemState: addField(C.item.id, "state", text()),
  loopCount: addField(C.loop.id, "count", INTEGER),
  loopPartCount: addField(C.loopPart.id, "count", INTEGER),
  loopPartLoop: addField(C.loopPart.id, "loop", owner(C.loop.id)),
  noteBody: addField(C.note.id, "body", text(200)),
  noteTicket: addField(C.note.id, "ticket", owner(C.ticket.id)),
  requestName: addField(C.request.id, "name", text()),
  requestStatus: addField(C.request.id, "status", text()),
  ticketCode: addField(C.ticket.id, "code", text()),
  ticketFlag: addField(C.ticket.id, "flag", text()),
  ticketLevel: addField(C.ticket.id, "level", INTEGER),
  ticketLink: addField(C.ticket.id, "link", {
    kind: "reference",
    targetClassId: C.request.id,
  }),
  ticketName: addField(C.ticket.id, "name", text(), { required: true }),
  ticketPeer: addField(C.ticket.id, "peer", {
    kind: "reference",
    targetClassId: C.ticket.id,
  }),
  ticketResult: addField(C.ticket.id, "result", INTEGER),
  ticketStatus: addField(C.ticket.id, "status", text()),
} as const;

/** The fixture's quoted tables. */
export const TABLE = {
  change: '"site"."ag_change"',
  changeApproval: '"site"."ag_change_approval"',
  item: '"site"."ag_item"',
  itemApproval: '"site"."ag_item_approval"',
  loop: '"site"."ag_loop"',
  loopPart: '"site"."ag_loop_part"',
  note: '"site"."ag_note"',
  request: '"site"."ag_request"',
  ticket: '"site"."ag_ticket"',
} as const;

// Condition builders over field IDs.

/**
 * A path to a field.
 * @param field - The field.
 * @param extra - `image` or `scope`.
 * @returns The path.
 */
export const at = (
  field: { readonly id: string },
  extra: {
    readonly image?: "previous";
    readonly scope?: "owner" | "record";
  } = {}
) => ({ path: [field.id], ...extra });

/**
 * `field = value`.
 * @param field - The field.
 * @param value - A literal.
 * @returns The condition.
 */
export const eq = (
  field: { readonly id: string },
  value: JsonValue
): Condition => ({
  left: at(field),
  op: "eq",
  right: { value },
});

/**
 * `field in (values)`.
 * @param field - The field.
 * @param list - Literals.
 * @param image - `previous` to read the start image.
 * @returns The condition.
 */
export const oneOf = (
  field: { readonly id: string },
  list: readonly JsonValue[],
  image?: "previous"
): Condition => ({
  left: image === undefined ? at(field) : at(field, { image }),
  op: "in",
  right: list.map((value) => ({ value })),
});

/**
 * Every condition.
 * @param args - The conditions.
 * @returns `and`.
 */
export const all = (...args: Condition[]): Condition => ({ args, op: "and" });

/**
 * Some condition.
 * @param args - The conditions.
 * @returns `or`.
 */
export const any = (...args: Condition[]): Condition => ({ args, op: "or" });

/**
 * The negation.
 * @param arg - A condition.
 * @returns `not`.
 */
export const not = (arg: Condition): Condition => ({ arg, op: "not" });

/**
 * `anyPart(class, where)`.
 * @param classId - The part class.
 * @param where - On each part.
 * @returns The quantifier.
 */
export const anyPart = (classId: string, where: Condition): Condition => ({
  class: classId,
  op: "anyPart",
  where,
});

/**
 * `allParts(class, where)`.
 * @param classId - The part class.
 * @param where - On each part.
 * @returns The quantifier.
 */
export const allParts = (classId: string, where: Condition): Condition => ({
  class: classId,
  op: "allParts",
  where,
});

/**
 * A literal value.
 * @param value - Its JSON.
 * @returns The rule value.
 */
export const literal = (value: JsonValue): RuleValue => ({ value });

/**
 * `set` of literal or computed values.
 * @param entries - Fields and values.
 * @returns The action.
 */
export const set = (
  ...entries: readonly (readonly [{ readonly id: string }, RuleValue])[]
): RuleAction => ({
  type: "set",
  values: entries.map(([field, value]) => ({ fieldId: field.id, value })),
});

/**
 * `setParts` on the owner's parts of a class matching `where`.
 * @param classId - The part class.
 * @param where - The condition, or null.
 * @param entries - Fields and values.
 * @returns The action.
 */
export const setParts = (
  classId: string,
  where: Condition | null,
  ...entries: readonly (readonly [{ readonly id: string }, RuleValue])[]
): RuleAction => ({
  classId,
  type: "setParts",
  values: entries.map(([field, value]) => ({ fieldId: field.id, value })),
  where,
});

/**
 * An aggregate rule.
 * @param classId - Its class.
 * @param name - Its name.
 * @param order - Its order.
 * @param condition - Its condition.
 * @param actions - Its actions.
 * @param once - Whether it fires at most once per owner and transaction.
 * @returns The operation and the rule ID.
 */
export const aggregateRule = (
  classId: string,
  name: string,
  order: number,
  condition: Condition | null,
  actions: readonly RuleAction[],
  once = false
) =>
  addRecordRule(classId, {
    actions: [...actions],
    condition,
    name,
    once,
    operations: [],
    order,
    phase: "aggregate",
    ruleKind: null,
  });

// 14.4's change rules, for the fixture's change.

const changeCurrent: Condition = {
  left: at(F.approvalRound),
  op: "eq",
  right: at(F.changeRound, { scope: "owner" }),
};

const changeOpen = oneOf(F.approvalState, ["requested", "approved"]);

const plannedChanged = any(
  { arg: at(F.changeStart), op: "changed" },
  { arg: at(F.changeEnd), op: "changed" }
);

const invalidate = (
  changeType: string,
  status: string,
  name: string,
  order: number
) =>
  aggregateRule(
    C.change.id,
    name,
    order,
    all(
      oneOf(F.changeStatus, ["authorize", "scheduled"], "previous"),
      eq(F.changeType, changeType),
      plannedChanged
    ),
    [
      setParts(C.changeApproval.id, all(changeCurrent, changeOpen), [
        F.approvalState,
        literal("cancelled"),
      ]),
      set([F.changeStatus, literal(status)]),
    ],
    true
  );

/** The change's aggregate rules, in 14.4's order. */
export const CHANGE_RULES = {
  approve: aggregateRule(
    C.change.id,
    "approve",
    60,
    all(
      eq(F.changeStatus, "authorize"),
      anyPart(C.changeApproval.id, changeCurrent),
      allParts(
        C.changeApproval.id,
        any(not(changeCurrent), eq(F.approvalState, "approved"))
      )
    ),
    [set([F.changeStatus, literal("scheduled")])]
  ),
  createRound: aggregateRule(
    C.change.id,
    "create_round",
    40,
    all(
      eq(F.changeStatus, "authorize"),
      not(eq(F.changeType, "standard")),
      not(
        anyPart(
          C.changeApproval.id,
          all(
            changeCurrent,
            oneOf(F.approvalState, ["requested", "approved", "rejected"])
          )
        )
      )
    ),
    [
      set([F.changeRound, { increment: F.changeRound.id }]),
      {
        classId: C.changeApproval.id,
        forEach: {
          classId: C.authority.id,
          where: {
            left: at(F.authorityType),
            op: "eq",
            right: at(F.changeType, { scope: "record" }),
          },
        },
        type: "createParts",
        values: [
          {
            fieldId: F.approvalApprover.id,
            value: {
              copy: { fieldId: F.authorityApprover.id, from: "source" },
            },
          },
          {
            fieldId: F.approvalRound.id,
            value: { copy: { fieldId: F.changeRound.id, from: "owner" } },
          },
          { fieldId: F.approvalState.id, value: literal("requested") },
        ],
      },
    ]
  ),
  invalidateEmergency: invalidate(
    "emergency",
    "authorize",
    "invalidate_emergency",
    20
  ),
  invalidateNormal: invalidate("normal", "assess", "invalidate_normal", 10),
  leaveAuthorize: aggregateRule(
    C.change.id,
    "leave_authorize",
    30,
    all(
      {
        left: at(F.changeStatus, { image: "previous" }),
        op: "eq",
        right: { value: "authorize" },
      },
      oneOf(F.changeStatus, ["assess", "canceled"]),
      anyPart(C.changeApproval.id, all(changeCurrent, changeOpen))
    ),
    [
      setParts(C.changeApproval.id, all(changeCurrent, changeOpen), [
        F.approvalState,
        literal("cancelled"),
      ]),
    ]
  ),
  reject: aggregateRule(
    C.change.id,
    "reject",
    50,
    all(
      eq(F.changeStatus, "authorize"),
      anyPart(
        C.changeApproval.id,
        all(changeCurrent, eq(F.approvalState, "rejected"))
      )
    ),
    [
      set([F.changeStatus, literal("rejected")]),
      setParts(
        C.changeApproval.id,
        all(changeCurrent, eq(F.approvalState, "requested")),
        [F.approvalState, literal("cancelled")]
      ),
    ]
  ),
} as const;

/** The message of the system-transition guards. */
export const SYSTEM_ONLY = "Only settling makes this transition.";

/**
 * The spies and guards of 4.9's `aggregate-finalize`: a `derive` rule on
 * the change and its approvals that counts its runs in `touches`, and a
 * `guard` on each that refuses a user's write of a system transition
 * (`scheduled`, `cancelled`). Neither may run on a save settling persists.
 */
export const SPY_RULES = {
  approvalDerive: addRecordRule(C.changeApproval.id, {
    actions: [set([F.approvalTouches, { increment: F.approvalTouches.id }])],
    name: "approval_spy",
    operations: ["create", "update"],
    ruleKind: "derive",
  }),
  approvalGuard: addRecordRule(C.changeApproval.id, {
    actions: [
      { code: "InvalidTransition", message: SYSTEM_ONLY, type: "refuse" },
    ],
    condition: all(
      { arg: at(F.approvalState), op: "changed" },
      eq(F.approvalState, "cancelled")
    ),
    name: "approval_guard",
    operations: ["update"],
    ruleKind: "guard",
  }),
  changeDerive: addRecordRule(C.change.id, {
    actions: [set([F.changeTouches, { increment: F.changeTouches.id }])],
    name: "change_spy",
    operations: ["create", "update"],
    ruleKind: "derive",
  }),
  changeGuard: addRecordRule(C.change.id, {
    actions: [
      { code: "InvalidTransition", message: SYSTEM_ONLY, type: "refuse" },
    ],
    condition: all(
      { arg: at(F.changeStatus), op: "changed" },
      eq(F.changeStatus, "scheduled")
    ),
    name: "change_guard",
    operations: ["update"],
    ruleKind: "guard",
  }),
} as const;

/** The message of the local scheduling invariant. */
export const NEEDS_PLAN = "A scheduled change needs its planned start and end.";

/**
 * 4.9's local invariant "`planned_start` and `planned_end` are set when
 * `status` is `scheduled`", on changes named `inv-…` only.
 */
export const PLAN_INVARIANT = addRecordRule(C.change.id, {
  actions: [{ code: "RuleRefused", message: NEEDS_PLAN, type: "refuse" }],
  condition: all(
    { left: at(F.changeName), op: "startsWith", right: "inv-" },
    eq(F.changeStatus, "scheduled"),
    any(
      { arg: at(F.changeStart), op: "empty" },
      { arg: at(F.changeEnd), op: "empty" }
    )
  ),
  name: "plan_invariant",
  operations: ["create", "update"],
  ruleKind: "invariant",
});

// 14.4's request rules, for the fixture's request, item and item approval.

const itemCurrent: Condition = {
  left: at(F.itemApprovalRound),
  op: "eq",
  right: at(F.itemRound, { scope: "owner" }),
};

/** The request's and item's aggregate rules. */
export const REQUEST_RULES = {
  acceptItems: aggregateRule(
    C.request.id,
    "accept_items",
    20,
    all(
      anyPart(C.item.id, eq(F.itemState, "awaiting_approval")),
      allParts(
        C.item.id,
        any(
          not(eq(F.itemState, "awaiting_approval")),
          eq(F.itemOutcome, "approved")
        )
      )
    ),
    [
      setParts(C.item.id, eq(F.itemState, "awaiting_approval"), [
        F.itemState,
        literal("new"),
      ]),
    ]
  ),
  deriveApproved: aggregateRule(
    C.request.id,
    "derive_approved",
    31,
    all(
      oneOf(F.requestStatus, ["submitted", "awaiting_approval"]),
      not(anyPart(C.item.id, eq(F.itemState, "awaiting_approval"))),
      anyPart(C.item.id, eq(F.itemState, "new"))
    ),
    [set([F.requestStatus, literal("approved")])]
  ),
  deriveAwaiting: aggregateRule(
    C.request.id,
    "derive_awaiting",
    30,
    all(
      oneOf(F.requestStatus, ["submitted", "awaiting_approval", "approved"]),
      anyPart(C.item.id, eq(F.itemState, "awaiting_approval"))
    ),
    [set([F.requestStatus, literal("awaiting_approval")])]
  ),
  itemApprove: aggregateRule(
    C.item.id,
    "item_approve",
    20,
    all(
      eq(F.itemState, "awaiting_approval"),
      eq(F.itemOutcome, "pending"),
      anyPart(C.itemApproval.id, itemCurrent),
      allParts(
        C.itemApproval.id,
        any(not(itemCurrent), eq(F.itemApprovalState, "approved"))
      )
    ),
    [set([F.itemOutcome, literal("approved")])]
  ),
  itemCreateRound: aggregateRule(
    C.item.id,
    "item_create_round",
    10,
    all(
      eq(F.itemState, "awaiting_approval"),
      eq(F.itemOutcome, "pending"),
      not(
        anyPart(
          C.itemApproval.id,
          all(
            itemCurrent,
            oneOf(F.itemApprovalState, ["requested", "approved", "rejected"])
          )
        )
      )
    ),
    [
      set([F.itemRound, { increment: F.itemRound.id }]),
      {
        classId: C.itemApproval.id,
        forEach: null,
        type: "createParts",
        values: [
          {
            fieldId: F.itemApprovalRound.id,
            value: { copy: { fieldId: F.itemRound.id, from: "owner" } },
          },
          { fieldId: F.itemApprovalState.id, value: literal("requested") },
        ],
      },
    ]
  ),
  submitItems: aggregateRule(
    C.request.id,
    "submit_items",
    10,
    all(
      eq(F.requestStatus, "submitted"),
      anyPart(C.item.id, eq(F.itemState, "draft"))
    ),
    [
      setParts(
        C.item.id,
        all(eq(F.itemState, "draft"), eq(F.itemNeeds, true)),
        [F.itemState, literal("awaiting_approval")],
        [F.itemOutcome, literal("pending")]
      ),
      setParts(
        C.item.id,
        eq(F.itemState, "draft"),
        [F.itemState, literal("awaiting_approval")],
        [F.itemOutcome, literal("approved")]
      ),
    ]
  ),
} as const;

/**
 * A rule that never settles once its owner has parts: it changes the
 * owner and its parts every pass.
 */
export const LOOP_RULE = aggregateRule(
  C.loop.id,
  "loop",
  10,
  anyPart(C.loopPart.id, { op: "true" }),
  [
    set([F.loopCount, { increment: F.loopCount.id }]),
    setParts(C.loopPart.id, null, [
      F.loopPartCount,
      { copy: { fieldId: F.loopCount.id, from: "owner" } },
    ]),
  ]
);

const approvedNow = (prefix: string): Condition =>
  all(
    { arg: at(F.requestStatus), op: "changed" },
    eq(F.requestStatus, "approved"),
    { left: at(F.requestName), op: "startsWith", right: prefix }
  );

/** A request ID no record has. */
export const ABSENT_REQUEST = "00000000-0000-4000-8000-0000000000aa";

const noteBody = (body: string): Condition =>
  anyPart(C.note.id, eq(F.noteBody, body));

/**
 * The ticket's aggregate rules, fired only by notes with a marker body:
 *
 * - `linkSeen` (order 5): a note whose ticket, followed through its owner
 *   reference, is approved sets the ticket's flag. It runs before
 *   `approve`, so it sees the approval only in the next pass, through the
 *   ticket's settling image, never a stale database read (finding 4).
 * - `approve` (order 10): a note `approve` approves the ticket.
 * - `clearName` (order 50): a note `clear-name` clears the ticket's
 *   required name, which persisting refuses.
 */
export const TICKET_RULES = {
  approve: aggregateRule(
    C.ticket.id,
    "approve_ticket",
    10,
    noteBody("approve"),
    [set([F.ticketStatus, literal("approved")])]
  ),
  clearName: aggregateRule(
    C.ticket.id,
    "clear_name",
    50,
    noteBody("clear-name"),
    [set([F.ticketName, literal(null)])]
  ),
  linkSeen: aggregateRule(
    C.ticket.id,
    "link_seen",
    5,
    anyPart(C.note.id, {
      left: { path: [F.noteTicket.id, F.ticketStatus.id] },
      op: "eq",
      right: { value: "approved" },
    }),
    [set([F.ticketFlag, literal("linked")])]
  ),
} as const;

/**
 * Review round 2's ticket rules: system writes that name a missing
 * reference target (`badLink`) or a value another ticket's unique code
 * already has (`dupCode`); and the probe, which sets level 10 once, which
 * the derive rules below take to 20 and read back through the ticket's
 * peer.
 */
export const PROBE_RULES = {
  badLink: aggregateRule(C.ticket.id, "bad_link", 60, noteBody("bad-link"), [
    set([F.ticketLink, literal(ABSENT_REQUEST)]),
  ]),
  dupCode: aggregateRule(C.ticket.id, "dup_code", 61, noteBody("dup-code"), [
    set([F.ticketCode, literal("DUP")]),
  ]),
  probe: aggregateRule(
    C.ticket.id,
    "probe",
    62,
    noteBody("probe"),
    [set([F.ticketLevel, literal(10)])],
    true
  ),
} as const;

/** The unique index on the ticket's code. */
export const TICKET_CODE_INDEX = addIndex(C.ticket.id, [F.ticketCode.id], true);

/**
 * The derive rules of the probe (review round 2): `a` takes a level of 10
 * to 20; `b`, after it, sets the result when the ticket's peer (the
 * ticket itself) has level 20, which only the image `a` writes shows.
 */
export const PROBE_DERIVE = {
  a: addRecordRule(C.ticket.id, {
    actions: [set([F.ticketLevel, literal(20)])],
    condition: eq(F.ticketLevel, 10),
    name: "probe_a",
    operations: ["create", "update"],
    order: 1,
    ruleKind: "derive",
  }),
  b: addRecordRule(C.ticket.id, {
    actions: [set([F.ticketResult, literal(1)])],
    condition: {
      left: { path: [F.ticketPeer.id, F.ticketLevel.id] },
      op: "eq",
      right: { value: 20 },
    },
    name: "probe_b",
    operations: ["create", "update"],
    order: 2,
    ruleKind: "derive",
  }),
} as const;

/**
 * `after` rules on the request's aggregate save (4.9 step 3, cascades):
 * a request named `cascade-…` that becomes approved adds a note to the
 * ticket named `cascade-target`, another aggregate, which is finalized
 * in turn; one named `bad-…` rewrites its own items, which this
 * transaction already persisted.
 */
export const CASCADE_RULES = {
  bad: addRecordRule(C.request.id, {
    actions: [
      {
        forEach: {
          classId: C.item.id,
          where: {
            left: at(F.itemRequest),
            op: "eq",
            right: { path: [], scope: "record" },
          },
        },
        target: "self",
        type: "updateEach",
        values: [{ fieldId: F.itemName.id, value: literal("rewritten") }],
      },
    ],
    condition: approvedNow("bad-"),
    name: "bad_rewrite",
    operations: ["update"],
    phase: "after",
    ruleKind: null,
  }),
  note: addRecordRule(C.request.id, {
    actions: [
      {
        classId: C.note.id,
        forEach: {
          classId: C.ticket.id,
          where: eq(F.ticketName, "cascade-target"),
        },
        type: "createEach",
        values: [
          {
            fieldId: F.noteTicket.id,
            value: { copy: { fieldId: null, from: "source" } },
          },
          { fieldId: F.noteBody.id, value: literal("from a request") },
        ],
      },
    ],
    condition: approvedNow("cascade-"),
    name: "cascade_note",
    operations: ["update"],
    phase: "after",
    ruleKind: null,
  }),
} as const;

/**
 * The record-service layer of the aggregate tests.
 * @returns The layer.
 */
export const aggregatesTestLayer = () =>
  Layer.mergeAll(
    WriteAccess.allowAll,
    RecordRuleSaveHooks,
    WriteOnlyValues.unavailable,
    Layer.succeed(Actor, actorOf(USERS.alice))
  ).pipe(
    Layer.provideMerge(Layer.merge(InstanceSettings.layer, schemaTestLayer()))
  );

/** The ID of the subscription on tickets (updates and deletes). */
export const TICKET_WATCH = freshId();

/**
 * Loads acme and creates the fixture's classes, fields and rules, and a
 * subscription on tickets.
 */
export const setUpAggregates = Effect.gen(function* setUpAggregates() {
  yield* setUpAcme;
  yield* ensureSite;
  yield* change([
    ...Object.values(C).map((entry) => entry.op),
    ...Object.values(F).map((entry) => entry.op),
    TICKET_CODE_INDEX.op,
  ]);
  yield* change([
    ...Object.values(CHANGE_RULES).map((rule) => rule.op),
    ...Object.values(REQUEST_RULES).map((rule) => rule.op),
    ...Object.values(SPY_RULES).map((rule) => rule.op),
    PLAN_INVARIANT.op,
    LOOP_RULE.op,
    ...Object.values(CASCADE_RULES).map((rule) => rule.op),
    ...Object.values(TICKET_RULES).map((rule) => rule.op),
    ...Object.values(PROBE_RULES).map((rule) => rule.op),
    ...Object.values(PROBE_DERIVE).map((rule) => rule.op),
    {
      definition: {
        classId: C.ticket.id,
        condition: null,
        deadLetter: "block",
        enabled: true,
        id: TICKET_WATCH,
        identityId: USERS.alice,
        kind: "subscription",
        maxAttempts: 10,
        name: "ag_ticket_watch",
        operations: ["create", "update", "delete"],
        owner: { layer: "local" },
        protected: false,
      },
      op: "createSubscription",
    },
  ]);
});

/**
 * The values of a saved record.
 * @param saved - A save's result.
 * @returns Its values by field name.
 */
export const valuesOf = (saved: SaveResult): JsonObject => {
  const found = saved.record?.values;

  return found !== undefined && isJsonObject(found) ? found : {};
};

/**
 * Creates a record through its class's endpoint.
 * @param classId - The class.
 * @param body - The body.
 * @returns The save.
 */
export const create = (classId: string, body: JsonObject) =>
  createRecord({ body, endpointClassId: classId });

/**
 * The current version of a record (0 when it is gone).
 * @param table - Its root table.
 * @param id - Its ID.
 * @returns The version.
 */
export const versionOf = (table: string, id: string) =>
  values(`SELECT version::text AS value FROM ${table} WHERE id = $1::uuid`, [
    id,
  ]).pipe(Effect.map(([value]) => Number(value ?? 0)));

/**
 * Updates a record at its current version.
 * @param classId - Its class.
 * @param table - Its root table.
 * @param id - Its ID.
 * @param body - The body.
 * @returns The save.
 */
export const update = Effect.fn("Aggregates.update")(function* update(
  classId: string,
  table: string,
  id: string,
  body: JsonObject
) {
  return yield* updateRecord({
    body,
    endpointClassId: classId,
    expectedVersion: yield* versionOf(table, id),
    id,
  });
});

/** One change entry of a record. */
const EntrySchema = Schema.Struct({
  actor: Schema.String,
  cause: ChangeCauseSchema,
  changeId: Schema.String,
  /** The changed fields' IDs, sorted, comma separated. */
  fields: Schema.String,
  kind: Schema.String,
  operation: Schema.String,
  version: Schema.Int,
});

/** One change entry of a record. */
export type Entry = typeof EntrySchema.Type;

const decodeEntry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EntrySchema)
);

/**
 * The change entries of a record, in version order.
 * @param id - The record.
 * @returns The entries.
 */
export const entriesOf = (id: string) =>
  values(
    `SELECT json_build_object(
       'version', record_version, 'kind', kind,
       'fields', (SELECT coalesce(string_agg(k, ',' ORDER BY k), '')
                  FROM jsonb_object_keys(fields) AS k),
       'cause', cause, 'actor', actor_id::text,
       'operation', operation_id::text, 'changeId', id::text)::text AS value
     FROM core."change" WHERE record_id = $1::uuid ORDER BY record_version`,
    [id]
  ).pipe(
    // oxlint-disable-next-line github/array-foreach, unicorn/no-array-method-this-argument -- Effect.forEach, not Array.prototype.forEach
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeEntry(row))),
    Effect.orDie
  );

/**
 * The versions of records of one table, in ID order.
 * @param table - Their root table.
 * @param ids - The records, in ID order.
 * @returns Their versions.
 */
export const versionsOf = (table: string, ids: readonly string[]) =>
  values(
    `SELECT version::text AS value FROM ${table}
     WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [`{${ids.join(",")}}`]
  ).pipe(Effect.map((rows) => rows.map(Number)));

/**
 * Counts rows.
 * @param sqlText - A query returning one `value`.
 * @param params - Its parameters.
 * @returns The number.
 */
export const count = (sqlText: string, params: readonly unknown[] = []) =>
  values(sqlText, params).pipe(Effect.map(([value]) => Number(value)));

/**
 * The text field of a record.
 * @param table - The table.
 * @param column - The column.
 * @param id - The record.
 * @returns Its value, or "" when empty.
 */
export const columnOf = (table: string, column: string, id: string) =>
  values(
    `SELECT coalesce(${column}::text, '') AS value FROM ${table} WHERE id = $1::uuid`,
    [id]
  ).pipe(Effect.map(([value]) => value ?? ""));

/**
 * Waits until another session of this database waits for a lock.
 * @returns Nothing, once one waits.
 */
export const someoneWaits = waitUntil(
  values(
    `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
     AND wait_event_type = 'Lock'`
  ).pipe(Effect.map(([value]) => value !== "0")),
  "20 seconds"
).pipe(Effect.orDie);

/**
 * Whether an error is the refusal of a guard on a system transition.
 * @param error - A save's error.
 * @returns True for that `InvalidTransition`.
 */
export const isSystemOnly = (error: { readonly _tag: string }): boolean =>
  error instanceof InvalidTransition && error.message === SYSTEM_ONLY;
