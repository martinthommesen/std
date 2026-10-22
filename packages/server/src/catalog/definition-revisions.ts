/**
 * Reading definitions as they were (Contracts 1.6, 4.4): a definition's
 * effective JSON at revision R is its latest `core.definition_revision` row
 * at revision R or earlier. History interprets old values through it after a
 * rename or a purge, and stale requests resolve names at the revision they
 * were built at (6.4).
 *
 * A purged field or table stays as a tombstone: the definition row keeps
 * its ID, last name, type and label with state `purged`, and its purge
 * revision is the first definition revision in that state.
 */
import { DefinitionSchema } from "@std/definitions/definition";
import type { Definition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import { parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { hygienic } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";

const decodeEffective = decodeRows(
  Schema.Struct({ effective: Schema.String, revision: Schema.String })
);

const decodeDefinition = Schema.decodeUnknownResult(DefinitionSchema);

/** A definition as it was at some revision. */
export interface DefinitionAtRevision {
  /** The revision of the definition revision row that applies. */
  readonly revision: number;
  /** The effective definition (its version is not part of the record). */
  readonly definition: Definition;
}

/**
 * A definition revision's effective JSON as a definition.
 *
 * @param text - The `effective` column as text.
 * @returns The definition, or undefined when it does not decode.
 */
export const definitionOf = (text: string): Definition | undefined => {
  const parsed = parseJson(text);

  if (!(parsed.ok && isJsonObject(parsed.value))) {
    return undefined;
  }

  // The effective JSON leaves out version and enforcement (Contracts 4.4);
  // put placeholders back so it decodes as a definition.
  const decoded = decodeDefinition({
    enforcement: "enforced",
    enforcementNote: null,
    version: 1,
    ...parsed.value,
  });

  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/**
 * A definition as it was at a revision.
 *
 * @param definitionId - The definition.
 * @param revision - The revision.
 * @returns The definition then, or undefined when it did not exist yet.
 */
export const definitionAt = Effect.fn("Catalog.definitionAt")(
  function* definitionAt(definitionId: DefinitionId, revision: number) {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* sql
      .unsafe(
        `SELECT effective::text AS effective, revision::text AS revision FROM core.definition_revision
         WHERE definition_id = $1::uuid AND revision <= $2::int8
         ORDER BY definition_revision.revision DESC LIMIT 1`,
        [definitionId, String(revision)]
      )
      .pipe(Effect.flatMap(decodeEffective));

    const definition =
      row === undefined ? undefined : definitionOf(row.effective);

    return row === undefined || definition === undefined
      ? undefined
      : ({
          definition,
          revision: Number(row.revision),
        } satisfies DefinitionAtRevision);
  },
  hygienic
);

const decodeRevision = decodeRows(
  Schema.Struct({ revision: Schema.NullOr(Schema.String) })
);

/**
 * The revision at which a definition was purged.
 *
 * @param definitionId - A field or table.
 * @returns The purge revision, or undefined when it is not purged.
 */
export const purgeRevisionOf = Effect.fn("Catalog.purgeRevisionOf")(
  function* purgeRevisionOf(definitionId: DefinitionId) {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* sql
      .unsafe(
        `SELECT min(revision)::text AS revision FROM core.definition_revision
         WHERE definition_id = $1::uuid AND effective ->> 'state' = 'purged'`,
        [definitionId]
      )
      .pipe(Effect.flatMap(decodeRevision));

    return row?.revision === null || row === undefined
      ? undefined
      : Number(row.revision);
  },
  hygienic
);
