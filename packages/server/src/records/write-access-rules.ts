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
 *   visibility, so a hidden target is `InvalidReference` like a missing one.
 * - `project`: the response through the endpoint's read view (`getRecord`);
 *   a record the caller can no longer see is only `{ id, version }`.
 * - `nameable`: the fields of the endpoint's lineage that the caller can
 *   read or write there.
 */
import type { FieldAction } from "@std/access/rules";
import { NotAllowed } from "@std/api/errors/not-allowed";
import {
  arrayParameter,
  identSql,
  joinSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { AccessAction } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Clock, Effect, Layer, Option } from "effect";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { fieldPredicate, recordPredicate } from "./access-sql.ts";
import type { AccessContext } from "./access-sql.ts";
import { filterClassView } from "./read-query.ts";
import { getRecord } from "./read-records.ts";
import { makeReadScope } from "./read-view.ts";
import {
  isNameable,
  readableOnProposal,
  readableOnRecord,
  truthColumn,
} from "./record-access.ts";
import { recordRelation } from "./relation.ts";
import { readRows } from "./sql-run.ts";
import { WriteAccess } from "./write-access.ts";
import type { ProposedCheck } from "./write-access.ts";

const ALIAS = "r";

const byId = (snapshot: ConfigSnapshot, classId: DefinitionId, id: string) =>
  sql`FROM ${recordRelation(snapshot, classId)} AS ${identSql(ALIAS)}
WHERE ${identSql(ALIAS, "id")} = ${textParameter(id, "uuid")}`;

/** What the checks of one action on one record need. */
interface RuleCheck {
  readonly snapshot: ConfigSnapshot;
  readonly classId: DefinitionId;
  readonly id: string;
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
  id: input.id,
  snapshot: input.snapshot,
  written: input.written,
});

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

    const context: AccessContext = {
      me: actor.userId,
      now,
      timeZone: settings.timeZone,
    };

    const scopeOf = (snapshot: ConfigSnapshot) =>
      makeReadScope(snapshot, actor, context);

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
${byId(check.snapshot, check.classId, check.id)}`
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
          id: input.record.id,
          snapshot: input.snapshot,
          written: input.written,
        }),
      checkProposed: (input) => allowed(proposedCheck(input)),
      conditionView: (snapshot) => filterClassView(scopeOf(snapshot)),
      nameable: (input) => {
        const scope = scopeOf(input.snapshot);

        return input.snapshot
          .fields(input.endpointClassId)
          .filter((field) =>
            isNameable(scope, input.endpointClassId, input.action, field.id)
          );
      },
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
          if (input.ids.length === 0) {
            return new Set<string>();
          }

          const view = scopeOf(input.snapshot).view(input.targetClassId);

          const rows = yield* readRows(
            sql`SELECT ${identSql(ALIAS, "id")}::text AS "id"
FROM ${recordRelation(input.snapshot, input.targetClassId)} AS ${identSql(ALIAS)}
WHERE ${identSql(ALIAS, "id")} = ANY(${arrayParameter(input.ids, "uuid")})
  AND ${view.visibility(ALIAS)}`
          );

          const visible: ReadonlySet<string> = new Set(
            rows.flatMap((row) =>
              row.id === null || row.id === undefined ? [] : [row.id]
            )
          );

          return visible;
        }
      ),
    });
  })
);
