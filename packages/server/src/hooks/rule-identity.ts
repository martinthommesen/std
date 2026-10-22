/**
 * Who a rule's nested saves run as (Contracts 4.1, 4.10, decision 0022):
 *
 * - an `after` rule without `runAs`: the acting user, so access rules
 *   apply to its writes exactly as to the user's own;
 * - an `after` rule with `runAs`, or an `afterCommit` rule (its
 *   subscription's identity): that user, with the roles they hold now.
 *   This needs the rule's author to hold `rules.run_as`: definition
 *   validation refuses a local change without it, and each run checks it
 *   again, so a rule whose author lost the permission fails closed
 *   (`NotAllowed`). The author of a local rule is the requester of the
 *   change set that wrote its current version (its definition's change
 *   entry); a rule shipped in a set is the set's, trusted like its
 *   access rules.
 */
import { NotAllowed } from "@std/api/errors/not-allowed";
import { sql, textParameter } from "@std/conditions/sql-fragment";
import type { RecordRuleDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import { hasPermission } from "@std/definitions/requester";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PERMISSION_IDS } from "@std/definitions/well-known";
import { Effect } from "effect";

import { loadActor } from "../auth/actor.ts";
import type { ActingUser } from "../auth/actor.ts";
import { readRows } from "../records/sql-run.ts";

/**
 * The user who wrote a local rule's current version.
 *
 * @param rule - A local record rule.
 * @returns The author's ID, or undefined when no entry names one.
 */
const authorOf = Effect.fn("Rules.authorOf")(function* authorOf(
  rule: RecordRuleDefinition
) {
  const rows = yield* readRows(
    sql`SELECT "actor_id"::text AS "actor_id" FROM core."change"
WHERE "record_id" = ${textParameter(rule.id, "uuid")}
  AND "record_version" = ${textParameter(String(rule.version), "int8")}`
  );

  const [row] = rows;

  return row?.actor_id ?? undefined;
});

/**
 * Checks that a rule may run as another identity: shipped in a set, or
 * written by a user who holds `rules.run_as` now.
 *
 * @param snapshot - The configuration.
 * @param rule - The rule.
 * @returns Fails with `NotAllowed` otherwise.
 */
export const checkRunAsAuthor = Effect.fn("Rules.checkRunAsAuthor")(
  function* checkRunAsAuthor(
    snapshot: ConfigSnapshot,
    rule: RecordRuleDefinition
  ) {
    if (rule.owner.layer !== "local") {
      return yield* Effect.void;
    }

    const author = yield* authorOf(rule);

    const holds =
      author !== undefined &&
      hasPermission(
        snapshot,
        yield* loadActor(snapshot, author),
        PERMISSION_IDS["rules.run_as"]
      );

    return holds ? yield* Effect.void : yield* new NotAllowed();
  }
);

/**
 * The identity a rule's nested saves run as.
 *
 * @param snapshot - The configuration.
 * @param rule - The rule.
 * @param identityId - Its run identity (`runAs`, the subscription's
 *   identity), or null for the acting user.
 * @param acting - The acting user.
 * @returns The actor to provide.
 */
export const ruleActor = Effect.fn("Rules.actor")(function* ruleActor(
  snapshot: ConfigSnapshot,
  rule: RecordRuleDefinition,
  identityId: DefinitionId | null,
  acting: ActingUser
) {
  if (identityId === null) {
    return acting;
  }

  yield* checkRunAsAuthor(snapshot, rule);

  const actor: ActingUser = yield* loadActor(snapshot, identityId);

  return actor;
});
