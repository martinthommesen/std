/**
 * The hook points of the save pipeline (Contracts 4.1), in phase order:
 *
 * - `beforeWrite` (step 5): may change the proposed values or refuse the
 *   save (`RuleRefused`, `InvalidTransition`); runs before the second
 *   no-op check and validation. It must not write records.
 * - `deliveries` (step 9): writes the outbox rows of a change entry
 *   (Contracts 4.6, workstream 1E), in the save's transaction.
 * - `afterWrite` (step 10): runs after the rows, the change entry and the
 *   delivery rows; may save other records through the record service, as
 *   a nested save in the same transaction. Any failure fails the save.
 *
 * Every hook point runs inside the save's transaction, so its Effect
 * environment holds the record service and the SQL client but no HTTP
 * client: an external call from an in-transaction hook does not type
 * check (Contracts 4.1). External calls belong to after-commit effects,
 * which run from the outbox.
 *
 * Record rules (`../hooks/record-rule-hooks.ts`, Step 3) and the outbox
 * producer (`outbox-producer.ts`, 1E) provide real layers; `SaveHooks.none`
 * runs nothing.
 */
import type { HookDepthExceeded } from "@std/api/errors/hook-depth-exceeded";
import type { InvalidReference } from "@std/api/errors/invalid-reference";
import type { InvalidTransition } from "@std/api/errors/invalid-transition";
import type { NotAllowed } from "@std/api/errors/not-allowed";
import type { NotFound } from "@std/api/errors/not-found";
import type { RecordInSave } from "@std/api/errors/record-in-save";
import type { Referenced } from "@std/api/errors/referenced";
import type { RuleRefused } from "@std/api/errors/rule-refused";
import type { UnknownField } from "@std/api/errors/unknown-field";
import type { ValidationFailed } from "@std/api/errors/validation-failed";
import type { VersionConflict } from "@std/api/errors/version-conflict";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { DecodedInput } from "@std/values/field-value";
import { Context, Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import type { Actor } from "../auth/actor.ts";
import type { Catalog } from "../catalog/catalog.ts";
import type { DatabaseError } from "../sql/errors.ts";
import type { CurrentTransaction } from "../sql/transaction-context.ts";
import type { Transactions } from "../sql/transactions.ts";
import type { ChangeEntry, ChangeKind } from "./change-entry.ts";
import type { InvalidBody } from "./invalid-body.ts";
import type { StoredRecord } from "./stored-record.ts";
import type { WriteAccess } from "./write-access.ts";
import type { WriteOnlyValues } from "./write-only-values.ts";

/**
 * Which `before` rules a save runs (Contracts 4.1 step 5, 4.9, 4.10):
 *
 * - `user`: every save a user, an API call, an import or an `after`
 *   action makes; `derive`, then `guard`, then `invariant` rules.
 * - `settled`: the saves that settling persists (4.9: part saves as the
 *   system effect `aggregate`, and the aggregate save of an owner); only
 *   `invariant` rules run, since `derive` rules already ran on the
 *   settled image and `guard` rules guard users' writes only.
 */
export type SaveMode = "user" | "settled";

/** What a before-write hook sees. */
export interface BeforeWriteInput {
  readonly snapshot: ConfigSnapshot;
  readonly kind: ChangeKind;
  /** The record's concrete class. */
  readonly classId: DefinitionId;
  /** The existing record; null for a create. */
  readonly existing: StoredRecord | null;
  /**
   * The proposed values by field ID: on create every field the create
   * sets, on update the body's fields, empty for a delete.
   */
  readonly values: ReadonlyMap<DefinitionId, DecodedInput>;
  /**
   * The fields the caller's body named, whatever their values (equal to
   * the stored ones included): a `set` action with `keepSupplied` leaves
   * them alone (4.10).
   */
  readonly supplied: ReadonlySet<DefinitionId>;
  /** Which `before` rules run. */
  readonly mode: SaveMode;
}

/** A committed-to-be change, after its entry is written. */
export interface AfterWriteInput {
  readonly snapshot: ConfigSnapshot;
  readonly entry: ChangeEntry;
  /** The record before the save; null for a create. */
  readonly before: StoredRecord | null;
  /** The record after the save; null for a delete. */
  readonly after: StoredRecord | null;
}

/**
 * Every way a save can fail, nested saves of its hooks included: what the
 * record service's `createRecord`, `updateRecord` and `deleteRecord`
 * return, before the SQL layer sanitizes driver errors.
 */
export type SaveFailure =
  | SqlError
  | DatabaseError
  | InvalidBody
  | UnknownField
  | NotFound
  | NotAllowed
  | VersionConflict
  | ValidationFailed
  | InvalidReference
  | Referenced
  | RecordInSave
  | HookDepthExceeded
  | RuleRefused
  | InvalidTransition;

/**
 * What an in-transaction hook may use: the save's SQL client and the
 * record service with the acting user. Deliberately no HTTP client.
 */
export type HookEnvironment =
  | SqlClient.SqlClient
  | Actor
  | Catalog
  | Transactions
  | WriteAccess
  | WriteOnlyValues
  | SaveHooks;

/** The pipeline's hook points. */
export interface SaveHooksApi {
  /** Step 5: returns the proposed values, possibly changed, or refuses. */
  readonly beforeWrite: (
    input: BeforeWriteInput
  ) => Effect.Effect<
    ReadonlyMap<DefinitionId, DecodedInput>,
    SqlError | RuleRefused | InvalidTransition,
    SqlClient.SqlClient | Actor
  >;
  /**
   * Step 9: the outbox rows of the change entry. The running transaction
   * is available to register the after-commit worker wake-up (step 11).
   */
  readonly deliveries: (
    input: AfterWriteInput
  ) => Effect.Effect<
    void,
    SqlError,
    SqlClient.SqlClient | CurrentTransaction | Actor
  >;
  /** Step 10: after-write hooks; a failure fails the whole save. */
  readonly afterWrite: (
    input: AfterWriteInput
  ) => Effect.Effect<void, SaveFailure, HookEnvironment>;
}

/** Hooks, record rules and outbox producers of the save pipeline.
 *
 * Its methods run inside the save's transaction and use that
 * transaction's `SqlClient`, so the `SqlClient` requirement is
 * deliberately the caller's (the `leakingRequirements` suggestion).
 */
export class SaveHooks extends Context.Service<SaveHooks, SaveHooksApi>()(
  "std/server/SaveHooks"
) {
  /** No hooks, no subscriptions. */
  static readonly none: Layer.Layer<SaveHooks> = Layer.succeed(
    SaveHooks,
    SaveHooks.of({
      afterWrite: () => Effect.void,
      beforeWrite: (input) => Effect.succeed(input.values),
      deliveries: () => Effect.void,
    })
  );
}
