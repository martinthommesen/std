/**
 * TMF621's `status` over the helpdesk's ITIL states (Contracts 11.2, 14.2,
 * 14.3; decision 0035). `status` is a closed enumeration of eight values
 * (TMF621 OAS v5.0.1 `TroubleTicketStatusType`), so STD renders only these
 * and maps its states onto them:
 *
 * | TMF621 | Read from | Written as |
 * | --- | --- | --- |
 * | `acknowledged` | `new`, `assess` | `new`; a problem in `new` or `assess` keeps its state |
 * | `inProgress` | `in_progress`, `root_cause_analysis`, `fix_in_progress` | `in_progress`; a problem `root_cause_analysis` unless it is in that group |
 * | `pending` | `on_hold` with hold reason `awaiting_caller` | `on_hold` + `awaiting_caller` |
 * | `held` | `on_hold` with any other or no hold reason; a plain ticket's `awaiting_approval` | `on_hold`, keeping a hold reason other than `awaiting_caller`, else `awaiting_vendor` |
 * | `resolved`, `closed` | the same | the same |
 * | `cancelled` | `canceled` | `canceled` |
 * | `rejected` | `canceled` with status reason `rejected` | `canceled` + reason `rejected` |
 *
 * A write that leaves `on_hold` clears the hold reason, and one that
 * leaves `rejected` clears the `rejected` reason, both only as defaults
 * (`softWrites`): a `holdReason` characteristic or a `statusChangeReason`
 * in the same body wins. `pending` and `rejected` are what their reason
 * says, so their reason is no default: another value in the same body is
 * a contradiction.
 *
 * Plain `helpdesk.ticket` records (neither incident nor problem) are
 * written as incidents are; their legacy `awaiting_approval` reads as
 * `held` [judgment, decision 0035].
 */
import type { Expr } from "@std/conditions/ast";
import { isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Result } from "effect";

import { HELPDESK_CLASS_IDS, TICKET_FIELD_IDS } from "./helpdesk-ids.ts";
import type {
  AttributeIssue,
  FilterComparison,
  SourceKey,
  SourceValues,
  WriteTarget,
  SortValue,
} from "./mapping.ts";

/** TMF621's status values (OAS v5.0.1 `TroubleTicketStatusType`). */
export const TMF621_STATUSES = [
  "acknowledged",
  "rejected",
  "pending",
  "held",
  "inProgress",
  "cancelled",
  "closed",
  "resolved",
] as const;

/** One TMF621 status. */
export type Tmf621Status = (typeof TMF621_STATUSES)[number];

const F = TICKET_FIELD_IDS;

/** The hold reason that makes an `on_hold` ticket `pending`. */
export const AWAITING_CALLER = "awaiting_caller";

/** The hold reason `held` writes when the ticket has no other. */
export const AWAITING_VENDOR = "awaiting_vendor";

/** The status reason that makes a `canceled` ticket `rejected`. */
export const REJECTED_REASON = "rejected";

const ON_HOLD = "on_hold";
const CANCELED = "canceled";

/** The ITIL states each TMF621 status reads from, `on_hold` aside. */
const READ_GROUPS: Readonly<Record<Tmf621Status, readonly string[]>> = {
  acknowledged: ["new", "assess"],
  cancelled: [CANCELED],
  closed: ["closed"],
  held: ["awaiting_approval"],
  inProgress: ["in_progress", "root_cause_analysis", "fix_in_progress"],
  pending: [],
  rejected: [],
  resolved: ["resolved"],
};

const STATUS_SET: ReadonlySet<string> = new Set(TMF621_STATUSES);

const isStatus = (value: string): value is Tmf621Status =>
  STATUS_SET.has(value);

const textOf = (values: SourceValues, source: SourceKey): string | null => {
  const value = values.get(source)?.value ?? null;

  return value !== null && isJsonString(value) ? value : null;
};

/** The fields `status` is derived from (Contracts 12.1 trigger fields). */
export const STATUS_SOURCES: readonly SourceKey[] = [
  F.status,
  F.holdReason,
  F.statusReason,
];

/** Order by the exposed TMF status, including its reason-dependent states. */
export const TMF621_STATUS_SORT: SortValue = {
  cases: [
    {
      result: { value: "pending" },
      when: { [F.status]: ON_HOLD, [F.holdReason]: AWAITING_CALLER },
    },
    { result: { value: "held" }, when: { [F.status]: ON_HOLD } },
    {
      result: { value: "rejected" },
      when: { [F.status]: CANCELED, [F.statusReason]: REJECTED_REASON },
    },
    { result: { value: "cancelled" }, when: { [F.status]: CANCELED } },
    ...TMF621_STATUSES.flatMap((status) =>
      READ_GROUPS[status].map((stored) => ({
        result: { value: status },
        when: { [F.status]: stored },
      }))
    ),
  ],
  otherwise: { value: null },
};

/**
 * The TMF621 status of a ticket's values, or undefined when one of its
 * sources is not readable or the state has no TMF621 status.
 *
 * @param values - The ticket's readable values.
 * @returns The status.
 */
export const tmf621StatusOf = (
  values: SourceValues
): Tmf621Status | undefined => {
  if (!STATUS_SOURCES.every((source) => values.has(source))) {
    return undefined;
  }

  const status = textOf(values, F.status);

  if (status === ON_HOLD) {
    return textOf(values, F.holdReason) === AWAITING_CALLER
      ? "pending"
      : "held";
  }

  if (status === CANCELED) {
    return textOf(values, F.statusReason) === REJECTED_REASON
      ? "rejected"
      : "cancelled";
  }

  return TMF621_STATUSES.find((candidate) =>
    READ_GROUPS[candidate].includes(status ?? "")
  );
};

/**
 * The ITIL state each TMF621 status writes, unless a problem keeps a state
 * of the status's group (`stateFor`).
 */
const WRITTEN_STATES: Readonly<Record<Tmf621Status, string>> = {
  acknowledged: "new",
  cancelled: CANCELED,
  closed: "closed",
  held: ON_HOLD,
  inProgress: "in_progress",
  pending: ON_HOLD,
  rejected: CANCELED,
  resolved: "resolved",
};

/** What a problem's `inProgress` writes outside its group (Contracts 11.2). */
const PROBLEM_IN_PROGRESS = "root_cause_analysis";

const isProblem = (target: WriteTarget): boolean =>
  target.lineage.includes(HELPDESK_CLASS_IDS.problem);

/**
 * The ITIL state a TMF621 status writes, given the current state and the
 * record's class.
 *
 * @param status - The TMF621 status.
 * @param current - The current state, if any.
 * @param target - The record's class.
 * @returns The state.
 */
const stateFor = (
  status: Tmf621Status,
  current: string | null,
  target: WriteTarget
): string => {
  const problem = isProblem(target);
  const inGroup = current !== null && READ_GROUPS[status].includes(current);

  if (problem && inGroup) {
    return current;
  }

  return problem && status === "inProgress"
    ? PROBLEM_IN_PROGRESS
    : WRITTEN_STATES[status];
};

/**
 * The fields a TMF621 status writes (`status` and, as the table above
 * says, the hold reason and status reason).
 *
 * @param value - The TMF621 value.
 * @param current - The caller's current values on an update.
 * @param target - The record's class.
 * @returns The field values, or the issue.
 */
export const writeTmf621Status = (
  value: JsonValue,
  current: SourceValues | undefined,
  target: WriteTarget
): Result.Result<ReadonlyMap<SourceKey, JsonValue>, AttributeIssue> => {
  if (value === null || !isJsonString(value) || !isStatus(value)) {
    return Result.fail({
      kind: "invalidValue",
      message: `status is one of ${TMF621_STATUSES.join(", ")}.`,
    });
  }

  const state = current === undefined ? null : textOf(current, F.status);
  const hold = current === undefined ? null : textOf(current, F.holdReason);
  const reason = current === undefined ? null : textOf(current, F.statusReason);

  const written = new Map<SourceKey, JsonValue>([
    [F.status, stateFor(value, state, target)],
  ]);

  if (value === "pending") {
    written.set(F.holdReason, AWAITING_CALLER);
  } else if (value === "held") {
    written.set(
      F.holdReason,
      hold === null || hold === AWAITING_CALLER ? AWAITING_VENDOR : hold
    );
  } else {
    written.set(F.holdReason, null);
  }

  if (value === "rejected") {
    written.set(F.statusReason, REJECTED_REASON);
  } else if (reason === REJECTED_REASON) {
    written.set(F.statusReason, null);
  }

  return Result.succeed(written);
};

/**
 * The fields a TMF621 status writes only as a default (`softWrites`): the
 * hold reason and status reason, except where the status is what its
 * reason says (`pending`'s hold reason, `rejected`'s status reason).
 *
 * @param value - The TMF621 value.
 * @returns The fields.
 */
export const softStatusWrites = (value: JsonValue): readonly SourceKey[] => {
  if (value === "pending") {
    return [F.statusReason];
  }

  return value === "rejected" ? [F.holdReason] : [F.holdReason, F.statusReason];
};

const at = (source: SourceKey) => ({ path: [source] });

const eq = (source: SourceKey, value: string): Expr => ({
  left: at(source),
  op: "eq",
  right: { value },
});

const not = (arg: Expr): Expr => ({ arg, op: "not" });

const and = (...args: readonly Expr[]): Expr => ({ args, op: "and" });

const stateIn = (states: readonly string[]): Expr =>
  states.length === 0
    ? { op: "false" }
    : {
        left: at(F.status),
        op: "in",
        right: states.map((value) => ({ value })),
      };

/**
 * The condition of one TMF621 status, so a filter selects exactly the
 * tickets whose rendered status it names (`tmf-filter-equivalence`).
 *
 * @param status - The status.
 * @returns The condition (paths are source keys).
 */
export const tmf621StatusCondition = (status: Tmf621Status): Expr => {
  const special: Partial<Record<Tmf621Status, Expr>> = {
    cancelled: and(
      eq(F.status, CANCELED),
      not(eq(F.statusReason, REJECTED_REASON))
    ),
    held: {
      args: [
        and(eq(F.status, ON_HOLD), not(eq(F.holdReason, AWAITING_CALLER))),
        stateIn(READ_GROUPS.held),
      ],
      op: "or",
    },
    pending: and(eq(F.status, ON_HOLD), eq(F.holdReason, AWAITING_CALLER)),
    rejected: and(eq(F.status, CANCELED), eq(F.statusReason, REJECTED_REASON)),
  };

  return special[status] ?? stateIn(READ_GROUPS[status]);
};

/**
 * A `status` filter: equality, each value one status (an unknown value
 * matches nothing), ORed.
 *
 * @param comparison - The comparison.
 * @param values - The values.
 * @returns The condition, or the issue.
 */
export const filterTmf621Status = (
  comparison: FilterComparison,
  values: readonly string[]
): Result.Result<Expr, AttributeIssue> =>
  comparison === "eq"
    ? Result.succeed({
        args: values.map((value): Expr =>
          isStatus(value) ? tmf621StatusCondition(value) : { op: "false" }
        ),
        op: "or",
      })
    : Result.fail({
        kind: "notSupported",
        message: "status takes equality only.",
      });
