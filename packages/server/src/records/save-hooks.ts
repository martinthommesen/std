/**
 * The hook points of the save pipeline (Contracts 4.1), in phase order:
 *
 * - `beforeWrite` (step 5): may change the proposed values; runs before
 *   the second no-op check and validation. It must not write records.
 * - `deliveries` (step 9): writes the outbox rows of a change entry
 *   (Contracts 4.6, workstream 1E), in the save's transaction.
 * - `afterWrite` (step 10): runs after the rows, the change entry and the
 *   delivery rows; may save other records through the record service, as
 *   a nested save in the same transaction.
 *
 * Hooks and record rules (Step 3) and the outbox producer
 * (`outbox-producer.ts`, 1E) provide real layers; `SaveHooks.none` runs
 * nothing.
 */
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { DecodedInput } from "@std/values/field-value";
import { Context, Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import type { CurrentTransaction } from "../sql/transaction-context.ts";
import type { ChangeEntry, ChangeKind } from "./change-entry.ts";
import type { StoredRecord } from "./stored-record.ts";

/** What a before-write hook sees. */
export interface BeforeWriteInput {
  readonly snapshot: ConfigSnapshot;
  readonly kind: ChangeKind;
  /** The record's concrete class. */
  readonly classId: DefinitionId;
  /** The existing record; null for a create. */
  readonly existing: StoredRecord | null;
  /** The proposed values by field ID (empty for a delete). */
  readonly values: ReadonlyMap<DefinitionId, DecodedInput>;
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

/** The pipeline's hook points. */
export interface SaveHooksApi {
  /** Step 5: returns the proposed values, possibly changed. */
  readonly beforeWrite: (
    input: BeforeWriteInput
  ) => Effect.Effect<
    ReadonlyMap<DefinitionId, DecodedInput>,
    SqlError,
    SqlClient.SqlClient
  >;
  /**
   * Step 9: the outbox rows of the change entry. The running transaction
   * is available to register the after-commit worker wake-up (step 11).
   */
  readonly deliveries: (
    input: AfterWriteInput
  ) => Effect.Effect<void, SqlError, SqlClient.SqlClient | CurrentTransaction>;
  /** Step 10: after-write hooks. */
  readonly afterWrite: (
    input: AfterWriteInput
  ) => Effect.Effect<void, SqlError, SqlClient.SqlClient>;
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
