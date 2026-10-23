/**
 * The access layer's answers to the save pipeline (Contracts 3.2, 3.4, 3.6,
 * 3.9), for the `Actor` of the request: the real `WriteAccess`.
 *
 * Every decision about a record is made by Postgres, over the same
 * relation (`recordRelation`) and the same compiled predicates as reads
 * (`read-view.ts`, `access-sql.ts`), so reads and writes share one
 * evaluator:
 *
 * - `visibility`: the record's row visibility and, per field of its
 *   concrete class, whether the caller can read it on this record; in the
 *   statements right after the root lock, before the version check, so an
 *   invisible record is `NotFound` exactly like an unknown ID.
 * - `checkExisting` and `checkProposed`: the record rule for the action and
 *   the field rule (`update`, or `create` on create) of every written or
 *   supplied field, evaluated on the stored row: before the write for the
 *   existing state, after the row writes for the proposed state (the
 *   pipeline then rolls back on `NotAllowed`).
 * - `visibleTargets`: reference targets under the target class's
 *   visibility and the field's allowed-records condition in the caller's
 *   view (decision 0020), so a hidden target, or one outside the
 *   condition, is `InvalidReference` like a missing one.
 * - `project`: the response through the endpoint's read view (`getRecord`);
 *   a record the caller can no longer see is only `{ id, version }`.
 * - `nameable`: the fields of the endpoint's lineage that the caller can
 *   read or write there.
 * - `ownerDecisions`: for the owners of a part being written, visibility
 *   and the record rule for `update` on each, in one statement (decision
 *   0039).
 */
import type { FieldAction } from "@std/access/rules";
import { NotAllowed } from "@std/api/errors/not-allowed";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import {
  identSql,
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { AccessAction } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Clock, Effect, Layer, Option } from "effect";

import { Actor } from "../auth/actor.ts";
import type { ActingUser } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { fieldPredicate, recordPredicate } from "./access-sql.ts";
import type { AccessContext } from "./access-sql.ts";
import { compileAllowedRecords, filterClassView } from "./read-query.ts";
import { getRecord } from "./read-records.ts";
import { makeReadScope } from "./read-view.ts";
import type { ReadScope } from "./read-view.ts";
import {
  isNameable,
  proposedRelation,
  readableOnProposal,
  readableOnRecord,
  truthColumn,
} from "./record-access.ts";
import { recordRelation } from "./relation.ts";
import { readRows } from "./sql-run.ts";
import { WriteAccess } from "./write-access.ts";
import type {
  OwnerDecision,
  ProposedCheck,
  WriteAccessApi,
} from "./write-access.ts";

const ALIAS = "r";

const byId = (snapshot: ConfigSnapshot, classId: DefinitionId, id: string) =>
  sql`FROM ${recordRelation(snapshot, classId)} AS ${identSql(ALIAS)}
WHERE ${identSql(ALIAS, "id")} = ${textParameter(id, "uuid")}`;

/** What the checks of one action on one record need. */
interface RuleCheck {
  readonly snapshot: ConfigSnapshot;
  readonly classId: DefinitionId;
  readonly source:
    | { readonly id: string }
    | { readonly candidate: SqlFragment };
  readonly action: AccessAction;
  readonly fieldAction: FieldAction;
  readonly written: ReadonlySet<DefinitionId>;
}

// The proposed-state check: the action's record rule and the same action
// for each written or supplied field.
const proposedCheck = (input: ProposedCheck): RuleCheck => ({
  action: input.action,
  classId: input.classId,
  fieldAction: input.action,
  snapshot: input.snapshot,
  source: { id: input.id },
  written: input.written,
});

/** What the rule-based access layer reads besides the acting user. */
interface RuleAccessDeps {
  readonly catalog: Catalog["Service"];
  readonly timeZone: string;
  /** The instant access-rule conditions resolve `now` with. */
  readonly now: number;
}

/**
 * The rule-based access layer for one acting user.
 *
 * @param actor - The acting user.
 * @param deps - The catalog, the instance time zone and `now`.
 * @returns The access layer; `forActor` builds it for another user.
 */
const makeRuleWriteAccess = (
  actor: ActingUser,
  deps: RuleAccessDeps
): WriteAccessApi => {
  const { catalog, now } = deps;
  const settings = { timeZone: deps.timeZone };

  const context: AccessContext = {
    me: actor.userId,
    now,
    timeZone: settings.timeZone,
  };

  const scopes = new WeakMap<ConfigSnapshot, ReadScope>();

  const scopeOf = (snapshot: ConfigSnapshot): ReadScope => {
    const existing = scopes.get(snapshot);

    if (existing !== undefined) {
      return existing;
    }

    const scope = makeReadScope(snapshot, actor, context);
    scopes.set(snapshot, scope);

    return scope;
  };

  const allowed = Effect.fn("WriteAccess.allowed")(function* allowed(
    check: RuleCheck
  ) {
    const classIds = [check.classId];

    const predicates = [
      recordPredicate(
        check.snapshot,
        actor,
        check.action,
        classIds,
        ALIAS,
        context
      ).predicate,
      ...[...check.written].map(
        (fieldId) =>
          fieldPredicate(
            check.snapshot,
            actor,
            check.fieldAction,
            classIds,
            fieldId,
            ALIAS,
            context
          ).predicate
      ),
    ];

    const every = sql`(${joinSql(predicates, " AND ")})`;

    const [row] = yield* readRows(
      sql`SELECT ${truthColumn(every, "allowed")}
${"candidate" in check.source ? check.source.candidate : byId(check.snapshot, check.classId, check.source.id)}`
    );

    if (row?.allowed !== "true") {
      return yield* new NotAllowed();
    }

    return yield* Effect.void;
  });

  return WriteAccess.of({
    checkExisting: (input) =>
      allowed({
        action: input.action,
        classId: input.record.classId,
        fieldAction: "update",
        snapshot: input.snapshot,
        source: { id: input.record.id },
        written: input.written,
      }),
    checkProposed: (input) => allowed(proposedCheck(input)),
    checkProposedImage: (input) =>
      allowed({
        action: input.action,
        classId: input.classId,
        fieldAction: input.action,
        snapshot: input.snapshot,
        source: {
          candidate: sql`FROM ${proposedRelation(input.snapshot, { actorId: actor.userId, classId: input.classId, existing: input.existing, values: input.values })} AS ${identSql(ALIAS)}`,
        },
        written: input.written,
      }),
    conditionView: (snapshot) => filterClassView(scopeOf(snapshot)),
    forActor: (other) => makeRuleWriteAccess(other, deps),
    nameable: (input) => {
      const scope = scopeOf(input.snapshot);

      return input.snapshot
        .fields(input.endpointClassId)
        .filter((field) =>
          isNameable(scope, input.endpointClassId, input.action, field.id)
        );
    },
    ownerDecisions: Effect.fn("WriteAccess.ownerDecisions")(
      function* ownerDecisions(input) {
        const scope = scopeOf(input.snapshot);

        // One branch per owner, each over its concrete class's relation;
        // an owner with no row gives no row and counts as hidden.
        const branches = input.owners.map(
          (owner) =>
            sql`SELECT ${identSql(ALIAS, "id")}::text AS "owner_id", ${truthColumn(
              scope.view(owner.classId, true).visibility(ALIAS),
              "owner_visible"
            )}, ${truthColumn(
              recordPredicate(
                input.snapshot,
                actor,
                "update",
                [owner.classId],
                ALIAS,
                context
              ).predicate,
              "owner_updatable"
            )}
${byId(input.snapshot, owner.classId, owner.id)}`
        );

        const rows =
          branches.length === 0
            ? []
            : yield* readRows(joinSql(branches, "\nUNION ALL\n"));

        const decided = new Map(
          rows.map((row): [string | null | undefined, OwnerDecision] => {
            if (row.owner_visible !== "true") {
              return [row.owner_id, "hidden"];
            }

            return [
              row.owner_id,
              row.owner_updatable === "true" ? "updatable" : "readOnly",
            ];
          })
        );

        const decisions: ReadonlyMap<string, OwnerDecision> = new Map(
          input.owners.map((owner): [string, OwnerDecision] => [
            owner.id,
            decided.get(owner.id) ?? "hidden",
          ])
        );

        return decisions;
      }
    ),
    project: Effect.fn("WriteAccess.project")(function* project(input) {
      const table = input.snapshot.qualifiedNameOf(input.endpointClassId);

      const projected = yield* getRecord({
        id: input.record.id,
        table: table ?? "",
      }).pipe(
        Effect.map((body) => Option.some(body.record)),
        Effect.catchTag("NotFound", () => Effect.succeedNone),
        Effect.catchTags({
          InvalidRequest: Effect.die,
          UnknownField: Effect.die,
          UnknownTable: Effect.die,
        }),
        Effect.provideService(Actor, actor),
        Effect.provideService(Catalog, catalog),
        Effect.provideService(InstanceSettings, settings)
      );

      return Option.getOrElse(projected, () => ({
        id: input.record.id,
        version: input.record.version,
      }));
    }),
    readableOnProposal: (input) =>
      readableOnProposal(scopeOf(input.snapshot), {
        actorId: actor.userId,
        classId: input.classId,
        existing: input.existing,
        values: input.values,
      }),
    visibility: (input) =>
      readableOnRecord(
        scopeOf(input.snapshot),
        input.record.classId,
        input.record.id
      ),
    visibleTargets: Effect.fn("WriteAccess.visibleTargets")(
      function* visibleTargets(input) {
        if (input.targets.length === 0) {
          return new Set<DefinitionId>();
        }

        const scope = scopeOf(input.snapshot);

        const branches = input.targets.map((target) => {
          const view = scope.view(target.targetClassId);

          // Hidden values count as empty in allowed-records conditions
          // (decision 0020), just as for a single target.
          const limit =
            target.allowedRecords === null
              ? undefined
              : compileAllowedRecords(
                  scope,
                  target.targetClassId,
                  target.allowedRecords,
                  ALIAS
                );

          return sql`SELECT ${textParameter(target.fieldId, "uuid")}::text AS "field_id"
FROM ${recordRelation(input.snapshot, target.targetClassId)} AS ${identSql(ALIAS)}${limit === undefined ? rawSql("") : sql` ${limit.joins}`}
WHERE ${identSql(ALIAS, "id")} = ${textParameter(target.id, "uuid")}
  AND ${view.visibility(ALIAS)}${
    limit === undefined
      ? rawSql("")
      : sql`
  AND (${limit.predicate})`
  }`;
        });

        const rows = yield* readRows(joinSql(branches, "\nUNION ALL\n"));

        const visible: ReadonlySet<string> = new Set(
          rows.flatMap((row) =>
            row.field_id === null || row.field_id === undefined
              ? []
              : [row.field_id]
          )
        );

        return visible;
      }
    ),
  });
};

/**
 * The `WriteAccess` of the request's `Actor`, with the access-rule context
 * (`me`, `now`, the instance time zone) fixed for the request.
 */
export const RuleWriteAccess: Layer.Layer<
  WriteAccess,
  never,
  Actor | Catalog | InstanceSettings
> = Layer.effect(
  WriteAccess,
  Effect.gen(function* ruleWriteAccess() {
    const actor = yield* Actor;
    const catalog = yield* Catalog;
    const settings = yield* InstanceSettings;
    const now = yield* Clock.currentTimeMillis;

    return makeRuleWriteAccess(actor, {
      catalog,
      now,
      timeZone: settings.timeZone,
    });
  })
);
