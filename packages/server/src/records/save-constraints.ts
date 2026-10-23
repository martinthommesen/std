import { InvalidReference } from "@std/api/errors/invalid-reference";
import { Referenced } from "@std/api/errors/referenced";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import type { FieldError } from "@std/definitions/field-errors";
/**
 * Constraint violations of record writes, mapped to API errors through the
 * constraint name (Contracts 1.1, 3.8, 3.10), never through message text.
 *
 * STD names constraints `std_<kind>_<32 hex of the definition ID>`, and the
 * SQL layer's sanitized errors keep only the SQLSTATE, the constraint name
 * and a diagnostic ID. So:
 *
 * | SQLSTATE | Constraint | Create or update | Delete |
 * | --- | --- | --- | --- |
 * | 23503 | `std_fk_<field>` | `InvalidReference` on the field | `Referenced` |
 * | 23503 | `std_cb_`/`std_ub_` (audit FKs) | (unmapped) | `Referenced` |
 * | 23505 | `std_ix_<index>` | `ValidationFailed`, `InvalidValue` `notUnique` per field | (unmapped) |
 * | 23502 | `std_nn_<field>` | `ValidationFailed`, `Required` | (unmapped) |
 * | 23514 | `std_ck_<field>` | `ValidationFailed`, `InvalidValue` `tooLong` | (unmapped) |
 *
 * Anything else stays a `DatabaseError` (SQLSTATE, constraint name and
 * diagnostic ID only). Raw Postgres text is never returned: it is logged
 * under the diagnostic ID.
 */
import { parseGeneratedName } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { SQLSTATE_UNIQUE_VIOLATION, toDatabaseError } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";

/** SQLSTATE `23503` (`foreign_key_violation`). */
export const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";

/** SQLSTATE `23502` (`not_null_violation`). */
export const SQLSTATE_NOT_NULL_VIOLATION = "23502";

/** SQLSTATE `23514` (`check_violation`). */
export const SQLSTATE_CHECK_VIOLATION = "23514";

/** Whether the failed statement wrote or removed a record. */
export type WriteDirection = "write" | "delete";

/** What a constraint violation of a record write becomes. */
export type ConstraintFailure =
  | InvalidReference
  | Referenced
  | ValidationFailed
  | DatabaseError;

const AUDIT_KINDS: ReadonlySet<string> = new Set(["cb", "ub"]);

const fieldName = (
  snapshot: ConfigSnapshot,
  fieldId: string
): string | undefined => snapshot.field(fieldId)?.name;

const uniqueErrors = (
  snapshot: ConfigSnapshot,
  indexId: string
): readonly FieldError[] => {
  const index = snapshot.getKind("index", indexId);

  return (index?.fieldIds ?? []).flatMap((fieldId) => {
    const name = fieldName(snapshot, fieldId);

    return name === undefined
      ? []
      : [
          {
            _tag: "InvalidValue",
            field: name,
            message: "Another record already has this value.",
            reason: "notUnique",
          } as const,
        ];
  });
};

const fieldErrorOf = (
  name: string,
  sqlState: string
): FieldError | undefined => {
  if (sqlState === SQLSTATE_NOT_NULL_VIOLATION) {
    return { _tag: "Required", field: name };
  }

  if (sqlState === SQLSTATE_CHECK_VIOLATION) {
    return {
      _tag: "InvalidValue",
      field: name,
      message: "The value is longer than this field allows.",
      reason: "tooLong",
    };
  }

  return undefined;
};

const writeFailure = (
  snapshot: ConfigSnapshot,
  error: DatabaseError,
  generated: { readonly kind: string; readonly id: string }
): ConstraintFailure => {
  const name = fieldName(snapshot, generated.id);

  if (
    error.sqlState === SQLSTATE_FOREIGN_KEY_VIOLATION &&
    generated.kind === "fk" &&
    name !== undefined
  ) {
    return new InvalidReference({ field: name });
  }

  if (error.sqlState === SQLSTATE_UNIQUE_VIOLATION && generated.kind === "ix") {
    const errors = uniqueErrors(snapshot, generated.id);

    return errors.length > 0 ? new ValidationFailed({ errors }) : error;
  }

  const fieldError =
    name !== undefined && (generated.kind === "nn" || generated.kind === "ck")
      ? fieldErrorOf(name, error.sqlState)
      : undefined;

  return fieldError === undefined
    ? error
    : new ValidationFailed({ errors: [fieldError] });
};

/**
 * Maps a sanitized database error of a record write.
 *
 * @param snapshot - The configuration the write ran at.
 * @param direction - Whether the statement wrote or deleted a record.
 * @param error - The sanitized error.
 * @returns The API error, or the `DatabaseError` itself when unmapped.
 */
export const constraintFailure = (
  snapshot: ConfigSnapshot,
  direction: WriteDirection,
  error: DatabaseError
): ConstraintFailure => {
  const generated =
    error.constraint === undefined
      ? undefined
      : parseGeneratedName(error.constraint);

  if (generated === undefined) {
    return error;
  }

  if (direction === "delete") {
    const referenced =
      error.sqlState === SQLSTATE_FOREIGN_KEY_VIOLATION &&
      (generated.kind === "fk" || AUDIT_KINDS.has(generated.kind));

    return referenced ? new Referenced() : error;
  }

  return writeFailure(snapshot, error, generated);
};

/**
 * Keeps a mapped failure to the fields the caller may see named (Contracts
 * 3.8): with `shown`, an `InvalidReference` on any other field becomes
 * `ValidationFailed` naming no field, and `ValidationFailed` keeps only the
 * errors of shown fields. The accepted leak of a unique conflict (that a
 * value is taken) stays; the name of a field the caller cannot read does
 * not. Without `shown` (a caller's own body) the failure is unchanged.
 *
 * @param failure - The mapped failure.
 * @param shown - The names of the fields errors may name, if limited.
 * @returns The failure as the caller may see it.
 */
export const withShownFields = <F extends ConstraintFailure>(
  failure: F,
  shown: ReadonlySet<string> | undefined
): F | ValidationFailed => {
  if (shown === undefined) {
    return failure;
  }

  if (failure instanceof InvalidReference) {
    return shown.has(failure.field)
      ? failure
      : new ValidationFailed({ errors: [] });
  }

  return failure instanceof ValidationFailed
    ? new ValidationFailed({
        errors: failure.errors.filter((error) => shown.has(error.field)),
      })
    : failure;
};

/**
 * Runs record-writing statements, mapping constraint violations.
 *
 * @param snapshot - The configuration the write runs at.
 * @param direction - Whether the statements write or delete a record.
 * @param shown - The names of the fields errors may name, for a system
 *   write (`withShownFields`); omitted for a caller's own body.
 * @returns A function wrapping the statements' effect.
 */
export const mapConstraints =
  (
    snapshot: ConfigSnapshot,
    direction: WriteDirection,
    shown?: ReadonlySet<string>
  ) =>
  <A, R>(
    effect: Effect.Effect<A, SqlError, R>
  ): Effect.Effect<A, ConstraintFailure, R> =>
    Effect.catchTag(effect, "SqlError", (failure) =>
      toDatabaseError(failure).pipe(
        Effect.flatMap((safe) =>
          Effect.fail(
            withShownFields(constraintFailure(snapshot, direction, safe), shown)
          )
        )
      )
    );
