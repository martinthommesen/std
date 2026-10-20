/**
 * What the code inside an STD transaction can see of it: the
 * `CurrentTransaction` service. The configuration state a request runs at is
 * the `RequestRevision` service (`request-revision.ts`).
 */
import { Context } from "effect";
import type { Effect } from "effect";

/** What kind of outermost transaction is running. */
export type TransactionKind = "request" | "config" | "maintenance";

/** What the code inside a transaction can do with it. */
export interface TransactionHandle {
  /** The outermost transaction's kind. */
  readonly kind: TransactionKind;
  /**
   * Registers an action to run after the outermost transaction commits,
   * outside the transaction. Dropped if the transaction rolls back.
   */
  readonly afterCommit: (action: Effect.Effect<void>) => Effect.Effect<void>;
  /** Counts a write the statement text does not reveal (a writing function). */
  readonly markWrite: Effect.Effect<void>;
  /** Why the transaction is poisoned, if it is. */
  readonly poisonReason: Effect.Effect<string | undefined>;
}

/** The running transaction, available to the code inside it. */
export class CurrentTransaction extends Context.Service<
  CurrentTransaction,
  TransactionHandle
>()("@std/server/sql/transaction-context/CurrentTransaction") {}
