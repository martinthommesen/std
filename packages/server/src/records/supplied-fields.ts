/**
 * The fields callers supplied, per record, for the running transaction
 * (Contracts 4.9, 4.10, decision 0022): every user-mode save adds the
 * field IDs its body named, whatever their values, to the set of its
 * record. Settling reads the set when it runs an owner's `derive` rules
 * (`applyDeriveRules`'s `supplied`), so a `keepSupplied` action keeps
 * protecting a value a user wrote earlier in the operation, also when a
 * part write makes the owner settle afterwards.
 *
 * The sets live in process memory, keyed by the transaction attempt's
 * handle like the operation ID (`change-entry.ts`): a retried attempt
 * starts empty, and nothing outlives the transaction.
 */
import type { DefinitionId } from "@std/definitions/ids";
import { Effect, Option } from "effect";

import { CurrentTransaction } from "../sql/transaction-context.ts";
import type { TransactionHandle } from "../sql/transaction-context.ts";

const suppliedByTransaction = new WeakMap<
  TransactionHandle,
  Map<string, Set<DefinitionId>>
>();

/**
 * Adds the fields a user-mode save's body named to its record's set.
 * Outside a transaction it records nothing.
 *
 * @param recordId - The saved record.
 * @param fieldIds - The fields the body named.
 * @returns Nothing.
 */
export const recordSupplied = Effect.fnUntraced(function* recordSupplied(
  recordId: string,
  fieldIds: Iterable<DefinitionId>
) {
  const transaction = yield* Effect.serviceOption(CurrentTransaction);

  if (Option.isNone(transaction)) {
    return;
  }

  const byRecord =
    suppliedByTransaction.get(transaction.value) ??
    new Map<string, Set<DefinitionId>>();

  suppliedByTransaction.set(transaction.value, byRecord);

  const fields = byRecord.get(recordId) ?? new Set<DefinitionId>();

  byRecord.set(recordId, fields);

  for (const fieldId of fieldIds) {
    fields.add(fieldId);
  }
});

/**
 * The fields callers supplied for a record in the running transaction.
 *
 * @param recordId - A record.
 * @returns The field IDs; none outside a transaction or for a record no
 *   user-mode save named.
 */
export const suppliedFieldsOf = (
  recordId: string
): Effect.Effect<ReadonlySet<DefinitionId>> =>
  Effect.serviceOption(CurrentTransaction).pipe(
    Effect.map((transaction): ReadonlySet<DefinitionId> =>
      Option.isNone(transaction)
        ? new Set()
        : (suppliedByTransaction.get(transaction.value)?.get(recordId) ??
          new Set())
    )
  );
