import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Catalog } from "../../catalog/catalog.ts";
import {
  readEntries,
  readFieldOrigins,
  versionImage,
} from "../../outbox/delivery-payload.ts";
import { decodeRows } from "../../sql/rows.ts";
import { DataMigrationFailed } from "../migration.ts";
import type { DataMigration } from "../migration.ts";

const Position = Schema.Struct({
  recordId: Schema.String,
  version: Schema.Int,
});

const positionCodec = Schema.fromJsonString(Position);

const failure = (error: { readonly message: string }) =>
  new DataMigrationFailed({
    id: 27,
    migration: "change-image-backfill",
    reason: error.message,
  });

// A delete reuses v-1's after-image; only a legacy gap needs its own before-image.
const missing = `FROM core.change c
  LEFT JOIN core.change_image i ON i.change_id = c.id
  LEFT JOIN core.change p ON p.record_id = c.record_id AND p.record_version = c.record_version - 1
  LEFT JOIN core.change_image pi ON pi.change_id = p.id
  WHERE (CASE WHEN c.kind = 'delete' THEN pi.after_image IS NULL AND i.before_image IS NULL
    ELSE i.after_image IS NULL END)`;

/** Finalize legacy images in record/version order, with atomic ledger batches. */
export const migration0027: DataMigration = {
  batch: Effect.fn("Platform.backfillChangeImages")(function* batch(
    after: string | null,
    size: number
  ) {
    const sql = yield* SqlClient.SqlClient;
    const snapshot = yield* (yield* Catalog).current;

    const position =
      after === null ? null : yield* Schema.decodeEffect(positionCodec)(after);

    const rows = yield* sql
      .unsafe(
        `SELECT c.id::text, c.record_id::text, c.record_class_id::text, c.record_version::text AS version, c.kind
       ${missing} AND ($1::uuid IS NULL OR (c.record_id, c.record_version) > ($1::uuid, $2::bigint))
       ORDER BY c.record_id, c.record_version LIMIT $3`,
        [position?.recordId ?? null, position?.version ?? 0, size]
      )
      .pipe(
        Effect.flatMap(
          decodeRows(
            Schema.Struct({
              id: Schema.String,
              kind: Schema.Literals(["create", "update", "delete"]),
              record_class_id: Schema.String,
              record_id: Schema.String,
              version: Schema.FiniteFromString,
            })
          )
        )
      );

    for (const row of rows) {
      const entries = yield* readEntries(row.record_id, row.version);
      const origins = yield* readFieldOrigins(snapshot, row.record_class_id);

      const image = JSON.stringify(
        Object.fromEntries(versionImage(snapshot, entries, origins).known)
      );

      const beforeImage = JSON.stringify(
        Object.fromEntries(
          versionImage(snapshot, entries.slice(0, -1), origins).known
        )
      );

      // An earlier row in this batch may just have supplied the previous image.
      yield* row.kind === "delete"
        ? sql`INSERT INTO core.change_image (change_id, before_image)
          SELECT ${row.id}::uuid, ${image}::jsonb WHERE NOT EXISTS (
            SELECT 1 FROM core.change p JOIN core.change_image i ON i.change_id = p.id
            WHERE p.record_id = ${row.record_id}::uuid AND p.record_version = ${row.version - 1} AND i.after_image IS NOT NULL)
          ON CONFLICT (change_id) DO UPDATE SET before_image = EXCLUDED.before_image`
        : sql`INSERT INTO core.change_image (change_id, before_image, after_image)
          SELECT ${row.id}::uuid,
            CASE WHEN ${row.version} > 1 AND NOT EXISTS (
              SELECT 1 FROM core.change p JOIN core.change_image i ON i.change_id = p.id
              WHERE p.record_id = ${row.record_id}::uuid AND p.record_version = ${row.version - 1} AND i.after_image IS NOT NULL)
            THEN ${beforeImage}::jsonb ELSE NULL END, ${image}::jsonb
          ON CONFLICT (change_id) DO UPDATE SET after_image = EXCLUDED.after_image,
            before_image = COALESCE(core.change_image.before_image, EXCLUDED.before_image)`;
    }

    const last = rows.at(-1);

    return {
      changed: rows.length,
      next:
        rows.length < size || last === undefined
          ? null
          : JSON.stringify({ recordId: last.record_id, version: last.version }),
    };
  }, Effect.mapError(failure)),
  description:
    "Backfills missing non-secret after-images and legacy-gap before-images in bounded record/version keyset batches at finalize; deletes reuse the previous after-image. Remaining counts versions still lacking their payload image. Derived images preserve legacy unknown/default semantics without logical writes.",
  id: 27,
  kind: "data",
  name: "change-image-backfill",
  phase: "expand",
  remaining: Effect.gen(function* remaining() {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* sql
      .unsafe(`SELECT count(*)::text AS total ${missing}`)
      .pipe(
        Effect.flatMap(
          decodeRows(Schema.Struct({ total: Schema.FiniteFromString }))
        )
      );

    return row?.total ?? 0;
  }).pipe(Effect.mapError(failure)),
};
