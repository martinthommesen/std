/** Service records owned by installed sets, repaired through ordinary audited saves. */
import { sql, textParameter } from "@std/conditions/sql-fragment";
import {
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_FIELD_IDS,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { isSecretState } from "@std/values/write-only";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import { column, userTables } from "../auth/user-table.ts";
import { Catalog } from "../catalog/catalog.ts";
import { OutboxSaveHooks } from "../records/outbox-producer.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
  ensureUserIndividual,
} from "../records/save-pipeline.ts";
import { loadRecord } from "../records/save-sql.ts";
import { readRows } from "../records/sql-run.ts";
import { WriteAccess } from "../records/write-access.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { Transactions } from "../sql/transactions.ts";

/** Set records could not be provisioned; reloading the set retries the repair. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SetIdentityFailed extends Schema.TaggedError<
  SetIdentityFailed,
  { readonly brand: unique symbol }
>()("SetIdentityFailed", { reason: Schema.String }) {
  /** Describes the failed provisioning and how to retry it.
   * @returns The diagnostic message.
   */
  override get message(): string {
    return `Could not provision the helpdesk cascade identity: ${this.reason}; reload helpdesk v3 to retry`;
  }
}

const provisioning = Layer.mergeAll(
  WriteAccess.allowAll,
  OutboxSaveHooks,
  WriteOnlyValues.scrypt,
  Layer.succeed(Actor, Actor.of({ roleIds: [], userId: SYSTEM_USER_ID }))
);

const cause = { kind: "system" } as const;

const repair = Effect.gen(function* repairSetIdentity() {
  const snapshot = yield* (yield* Catalog).current;

  if (snapshot.role(HELPDESK_CASCADE_ROLE_ID)?.state !== "active") {
    return;
  }

  const sqlClient = yield* SqlClient.SqlClient;
  yield* sqlClient`SELECT pg_advisory_xact_lock(hashtextextended(${HELPDESK_CASCADE_USER_ID}, 0))`;

  const loaded = yield* loadRecord(
    snapshot,
    USER_CLASS_ID,
    HELPDESK_CASCADE_USER_ID
  );

  if (Option.isNone(loaded)) {
    yield* createRecord({
      body: {
        active: true,
        login: "std-helpdesk-cascade",
        name: "Helpdesk cascade service",
      },
      cause,
      endpointClassId: USER_CLASS_ID,
      fixedId: HELPDESK_CASCADE_USER_ID,
    });
  } else {
    const record = loaded.value;
    const password = record.values.get(USER_FIELD_IDS.password);

    if (
      record.values.get(USER_FIELD_IDS.active) !== true ||
      (isSecretState(password) && password.set)
    ) {
      yield* updateRecord({
        body: { active: true, password: null },
        cause,
        endpointClassId: USER_CLASS_ID,
        expectedVersion: record.version,
        id: record.id,
      });
    }

    yield* ensureUserIndividual({ cause, id: record.id });
  }

  const tables = userTables(snapshot);

  const assignments =
    yield* readRows(sql`SELECT r.id::text, r.version::text, ${column("r", tables.userRoleUser)}::text AS user, ${column("r", tables.userRoleRole)}::text AS role FROM ${tables.userRole} r
    WHERE ${column("r", tables.userRoleUser)} = ${textParameter(HELPDESK_CASCADE_USER_ID, "uuid")} OR ${column("r", tables.userRoleRole)} = ${textParameter(HELPDESK_CASCADE_ROLE_ID, "uuid")}
    ORDER BY r.id FOR UPDATE`);

  let kept = false;

  for (const assignment of assignments) {
    if (
      !kept &&
      assignment.user === HELPDESK_CASCADE_USER_ID &&
      assignment.role === HELPDESK_CASCADE_ROLE_ID
    ) {
      kept = true;
    } else if (
      assignment.id !== null &&
      assignment.id !== undefined &&
      assignment.version !== null &&
      assignment.version !== undefined
    ) {
      yield* deleteRecord({
        cause,
        endpointClassId: USER_ROLE_CLASS_ID,
        expectedVersion: Number(assignment.version),
        id: assignment.id,
      });
    }
  }

  if (!kept) {
    yield* createRecord({
      body: { role: HELPDESK_CASCADE_ROLE_ID, user: HELPDESK_CASCADE_USER_ID },
      cause,
      endpointClassId: USER_ROLE_CLASS_ID,
    });
  }
});

/** Ensures installed sets' service identities on every load, including unchanged reloads. */
export const ensureSetIdentities = Effect.fn("Config.ensureSetIdentities")(
  function* ensureSetIdentities() {
    yield* (yield* Transactions).request(repair).pipe(
      Effect.provide(provisioning),
      Effect.mapError(
        (error) => new SetIdentityFailed({ reason: error.message })
      )
    );
  }
);
