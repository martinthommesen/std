import type { NotAllowed } from "@std/api/errors/not-allowed";
/**
 * The authorization seam of the save pipeline (Contracts 3.2, 3.6, 3.9).
 *
 * The pipeline fixes the order of checks (4.1); this service decides them.
 * Every method runs inside the save's request transaction, so SQL it issues
 * sees the same revision and, after the root lock, a fresh snapshot.
 *
 * Phase 1 of workstream 0C writes ships only `WriteAccess.allowAll`, which
 * sees and allows everything and checks reference targets for existence.
 * The access layer (`@std/access` with the reads compiler) provides the
 * real implementation for the acting user: visibility and field read
 * rights from the compiled SQL predicates, the record and field rules for
 * create, update and delete on both states, the target-visibility guard
 * and projection with the caller's read rights.
 */
import type { FieldDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { encodeOut } from "@std/values/codec";
import { formatDateTime } from "@std/values/date-time";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import type { Option } from "effect";
import { Context, Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import type { DatabaseError } from "../sql/errors.ts";
import type { RequestRevision } from "../sql/request-revision.ts";
import { existingTargets } from "./save-sql.ts";
import type { StoredRecord } from "./stored-record.ts";

/** What the seam's methods may use: the save's transaction. */
export type InTransaction = SqlClient.SqlClient | RequestRevision;

/** A record as the pipeline found it, right after the root lock. */
export interface ExistingCheck {
  readonly snapshot: ConfigSnapshot;
  /** The class whose endpoint the request came through. */
  readonly endpointClassId: DefinitionId;
  readonly record: StoredRecord;
}

/** The existing-state access check of an update or delete (3.9). */
export interface ExistingActionCheck extends ExistingCheck {
  readonly action: "update" | "delete";
  /** The written fields (3.9); empty for a delete. */
  readonly written: ReadonlySet<DefinitionId>;
}

/** The proposed-state access check of a create or update (3.9). */
export interface ProposedCheck {
  readonly snapshot: ConfigSnapshot;
  readonly endpointClassId: DefinitionId;
  readonly action: "create" | "update";
  readonly classId: DefinitionId;
  readonly id: string;
  /** Create: the supplied fields; update: the written fields. */
  readonly written: ReadonlySet<DefinitionId>;
}

/** The reference targets a write names, for one target class. */
export interface TargetCheck {
  readonly snapshot: ConfigSnapshot;
  readonly targetClassId: DefinitionId;
  readonly ids: readonly string[];
}

/** The saved record, to project for the response. */
export interface ProjectionInput {
  readonly snapshot: ConfigSnapshot;
  readonly endpointClassId: DefinitionId;
  readonly record: StoredRecord;
}

/** Which fields a write body may name (3.4). */
export interface NameableInput {
  readonly snapshot: ConfigSnapshot;
  readonly endpointClassId: DefinitionId;
  readonly action: "create" | "update";
}

/** What the pipeline asks the access layer. */
export interface WriteAccessApi {
  /**
   * The fields of the endpoint's class and its ancestors that the caller
   * may name in a write body: readable or writable ones (3.4). Any other
   * name, misspelled or never readable, is `UnknownField`.
   */
  readonly nameable: (input: NameableInput) => readonly FieldDefinition[];
  /**
   * Visibility of the existing record, checked in the statement after the
   * root lock and before the version check: `None` when the caller cannot
   * see it (`NotFound`), otherwise the IDs of the fields the caller can
   * read on it, which decide the written fields and the no-op rule (3.9).
   */
  readonly visibility: (
    input: ExistingCheck
  ) => Effect.Effect<
    Option.Option<ReadonlySet<DefinitionId>>,
    SqlError,
    InTransaction
  >;
  /** Record and field rules on the existing state (`NotAllowed`). */
  readonly checkExisting: (
    input: ExistingActionCheck
  ) => Effect.Effect<void, NotAllowed | SqlError, InTransaction>;
  /**
   * Record and field rules on the proposed state, after the row writes,
   * re-reading through the same compiled predicates (`NotAllowed`; the
   * transaction rolls back).
   */
  readonly checkProposed: (
    input: ProposedCheck
  ) => Effect.Effect<void, NotAllowed | SqlError, InTransaction>;
  /**
   * The IDs among `ids` that exist and that the caller can see (3.6); a
   * missing ID becomes `InvalidReference`.
   */
  readonly visibleTargets: (
    input: TargetCheck
  ) => Effect.Effect<ReadonlySet<string>, SqlError, InTransaction>;
  /**
   * The response record, with the caller's read rights; only `id` and
   * `version` when the record is no longer visible (3.9).
   */
  readonly project: (
    input: ProjectionInput
  ) => Effect.Effect<JsonObject, SqlError | DatabaseError, InTransaction>;
}

/**
 * Every field of a record that its endpoint shows (the fields of the
 * endpoint's class and its ancestors, Contracts 2.3) in canonical JSON,
 * keyed by field name, in the record JSON shape of Contracts 6.6 (no
 * labels, nothing withheld). `class` stays the concrete class.
 *
 * @param input - The snapshot, endpoint and record.
 * @returns `{ id, class, version, values }`.
 */
export const projectAll = (input: ProjectionInput): JsonObject => {
  const values: Record<string, JsonValue> = {};

  for (const field of input.snapshot.fields(input.endpointClassId)) {
    values[field.name] = encodeOut(
      field.type,
      input.record.values.get(field.id) ?? null
    );
  }

  return {
    class: input.snapshot.qualifiedNameOf(input.record.classId) ?? null,
    created_at: formatDateTime(input.record.createdAt),
    created_by: input.record.createdBy,
    id: input.record.id,
    updated_at: formatDateTime(input.record.updatedAt),
    updated_by: input.record.updatedBy,
    values,
    version: input.record.version,
  };
};

/** The access layer's answers for the acting user.
 *
 * Its methods run inside the save's transaction and use that
 * transaction's `SqlClient`, so the `SqlClient` requirement is
 * deliberately the caller's (the `leakingRequirements` suggestion).
 */
export class WriteAccess extends Context.Service<WriteAccess, WriteAccessApi>()(
  "std/server/WriteAccess"
) {
  /**
   * Sees and allows everything; reference targets must exist. For phase 1
   * tests, bootstrap and the system user's definition loads only.
   */
  static readonly allowAll: Layer.Layer<WriteAccess> = Layer.succeed(
    WriteAccess,
    WriteAccess.of({
      checkExisting: () => Effect.void,
      checkProposed: () => Effect.void,
      nameable: (input) => input.snapshot.fields(input.endpointClassId),
      project: (input) => Effect.succeed(projectAll(input)),
      visibility: (input) =>
        Effect.succeedSome<ReadonlySet<DefinitionId>>(
          new Set(
            input.snapshot.fields(input.record.classId).map((field) => field.id)
          )
        ),
      visibleTargets: (input) =>
        existingTargets(input.snapshot, input.targetClassId, input.ids),
    })
  );
}
