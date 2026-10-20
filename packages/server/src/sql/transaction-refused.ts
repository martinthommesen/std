/**
 * The defect STD's transaction layer raises when it refuses something.
 */
import { Schema } from "effect";

/** Why a transaction was refused. */
export const TransactionRefusal = Schema.Literals([
  // The transaction was poisoned and has been rolled back instead of committed.
  "poisoned",
  // An isolation level other than READ COMMITTED was requested.
  "isolation-level",
  // A SAVEPOINT, RELEASE or ROLLBACK TO statement inside an STD transaction.
  "savepoint",
  // Another transaction-control statement inside an STD transaction.
  "transaction-control",
  // A nesting STD does not allow (for example a config commit inside a request).
  "nesting",
]);

/**
 * Defect: STD refused to run or commit a transaction. Never a typed error:
 * each case is a programming error or a poisoned transaction, and callers
 * must not be able to recover into a commit.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class TransactionRefused extends Schema.TaggedError<TransactionRefused>()(
  "TransactionRefused",
  {
    detail: Schema.String,
    reason: TransactionRefusal,
  }
) {
  /**
   * The reason and detail; neither carries data from the database.
   * @returns The message.
   */
  override get message(): string {
    return `Transaction refused (${this.reason}): ${this.detail}`;
  }
}
