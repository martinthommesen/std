import { makeDedicatedConnection } from "@std/server/sql/dedicated";
/**
 * Probe 4 (plan 0F; Contracts 5.5): `casefold` is IMMUTABLE and indexable.
 *
 * - `pg_proc.provolatile` of `casefold(text)`.
 * - An expression index on `casefold(name COLLATE pg_unicode_fast)`, built
 *   concurrently on the coordinator's dedicated connection as a follow-up
 *   step would, is used by folded equality: `EXPLAIN` of the literal form
 *   names the index, and the bound-parameter form run through request
 *   transactions (more than five times, so the plan cache may switch to a
 *   generic plan) raises `idx_scan` and leaves `seq_scan` unchanged.
 * - A unique index on the fold makes keys unique by key: `STRASSE` after
 *   `Straße`, and `σας` after `ΣΑΣ`, are refused with SQLSTATE 23505.
 */
import { decodeRows } from "@std/server/sql/rows";
import type { RequestTransactions } from "@std/server/sql/transaction";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { readTableState } from "./catalog-state.ts";
import { timedMillis } from "./clock.ts";

/** The folded-equality expression STD generates (Contracts 5.5). */
export const FOLD_EXPRESSION = "casefold(name COLLATE pg_unicode_fast)";

/** Pairs that are equal by key, and so collide in the unique index. */
export const KEY_COLLISIONS: readonly (readonly [string, string])[] = [
  ["Straße", "STRASSE"],
  ["ΣΑΣ", "σας"],
  ["ﬁle", "FILE"],
];

/** Inputs whose fold the report shows under both collations. */
const FOLD_EXAMPLES = ["Straße", "ΣΑΣ", "İ", "ﬁ"] as const;

/** How many bound-parameter lookups the probe runs. */
const BOUND_LOOKUPS = 12;

/** A fold under the database's default collation and under `pg_unicode_fast`. */
export interface FoldExample {
  readonly input: string;
  readonly defaultCollation: string;
  readonly unicodeFast: string;
}

/** One attempted insert of a key that collides with an earlier one. */
export interface CollisionResult {
  readonly first: string;
  readonly second: string;
  /** SQLSTATE of the refused insert, or `null` if it was accepted. */
  readonly sqlState: string | null;
  readonly constraint: string | null;
}

/** Result of probe 4. */
export interface CasefoldProbeResult {
  readonly rows: number;
  /** `pg_proc.provolatile` of `casefold(text)`: `i` is IMMUTABLE. */
  readonly provolatile: string;
  readonly defaultCollation: string;
  readonly foldExamples: readonly FoldExample[];
  readonly indexBuildMs: number;
  /** Node types of the literal-form plan, outermost first. */
  readonly planNodes: readonly string[];
  /** Index names the literal-form plan uses. */
  readonly planIndexes: readonly string[];
  readonly boundLookups: number;
  readonly boundMatches: number;
  readonly idxScanDelta: number;
  readonly seqScanDelta: number;
  readonly collisions: readonly CollisionResult[];
}

/** Options of probe 4. */
export interface CasefoldProbeOptions {
  /** Rows in the lookup table. */
  readonly rows: number;
}

const decodeVolatility = decodeRows(
  Schema.Struct({ provolatile: Schema.String })
);

const decodeFold = decodeRows(
  Schema.Struct({ by_default: Schema.String, unicode_fast: Schema.String })
);

const decodeCollation = decodeRows(Schema.Struct({ collation: Schema.String }));

const decodePlan = decodeRows(Schema.Struct({ "QUERY PLAN": Schema.String }));

const decodeIds = decodeRows(Schema.Struct({ id: Schema.String }));

/** One node of an `EXPLAIN (FORMAT JSON)` plan. */
interface PlanNode {
  readonly "Node Type"?: string;
  readonly "Index Name"?: string;
  readonly Plans?: readonly PlanNode[];
}

const PlanNodeSchema: Schema.Codec<PlanNode> = Schema.Struct({
  "Index Name": Schema.optionalKey(Schema.String),
  "Node Type": Schema.optionalKey(Schema.String),
  Plans: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<PlanNode> => PlanNodeSchema))
  ),
});

const decodeExplain = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ Plan: PlanNodeSchema })))
);

const flattenPlan = (node: PlanNode): readonly PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(flattenPlan),
];

/**
 * Inserts the second key of a colliding pair after the first, through
 * request transactions.
 * @param pair - Two keys equal by fold.
 * @returns How the second insert ended.
 */
const tryCollision = Effect.fn("tryCollision")(function* collide(
  request: RequestTransactions["request"],
  pair: readonly [string, string]
) {
  const [first, second] = pair;

  const insert = (code: string) =>
    request(
      SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (sql) =>
            sql`INSERT INTO probe_casefold_unique (code) VALUES (${code})`
        )
      )
    );

  yield* insert(first);

  return yield* insert(second).pipe(
    Effect.as<CollisionResult>({
      constraint: null,
      first,
      second,
      sqlState: null,
    }),
    Effect.catchTag("DatabaseError", (error) =>
      Effect.succeed<CollisionResult>({
        constraint: error.constraint ?? null,
        first,
        second,
        sqlState: error.sqlState,
      })
    )
  );
});

/**
 * Runs probe 4 on the current database.
 * @param options - Table size.
 * @returns The facts and measurements.
 */
export const runCasefoldProbe = Effect.fn("runCasefoldProbe")(
  function* casefoldProbe(options: CasefoldProbeOptions) {
    const connection = yield* makeDedicatedConnection({
      applicationName: "std-probe-casefold",
    });

    const { execute } = connection;
    const { request } = connection.transactions;

    const [volatility] = yield* execute(
      "SELECT provolatile::text AS provolatile FROM pg_proc WHERE oid = 'pg_catalog.casefold(text)'::regprocedure"
    ).pipe(Effect.flatMap(decodeVolatility));

    const [collation] = yield* execute(
      "SELECT datcollate || ' (' || datlocprovider::text || ')' AS collation FROM pg_database WHERE datname = current_database()"
    ).pipe(Effect.flatMap(decodeCollation));

    const foldExamples: FoldExample[] = [];

    for (const input of FOLD_EXAMPLES) {
      const [fold] = yield* execute(
        "SELECT casefold($1::text) AS by_default, casefold($1::text COLLATE pg_unicode_fast) AS unicode_fast",
        [input]
      ).pipe(Effect.flatMap(decodeFold));

      foldExamples.push({
        defaultCollation: fold?.by_default ?? "",
        input,
        unicodeFast: fold?.unicode_fast ?? "",
      });
    }

    yield* execute("DROP TABLE IF EXISTS probe_casefold");
    yield* execute(
      "CREATE TABLE probe_casefold (id bigint PRIMARY KEY, name text NOT NULL) WITH (autovacuum_enabled = false)"
    );
    yield* execute(
      `INSERT INTO probe_casefold (id, name)
       SELECT g, 'Name ' || g FROM generate_series(1, $1::int8) AS g`,
      [String(options.rows)]
    );
    yield* execute(
      "INSERT INTO probe_casefold (id, name) VALUES (0, 'Straße')"
    );

    const [indexBuildMs] = yield* timedMillis(
      execute(
        `CREATE INDEX CONCURRENTLY probe_casefold_key ON probe_casefold (${FOLD_EXPRESSION})`
      )
    );

    yield* execute("ANALYZE probe_casefold");

    const [plan] = yield* execute(
      `EXPLAIN (FORMAT JSON) SELECT id FROM probe_casefold WHERE ${FOLD_EXPRESSION} = 'strasse'`
    ).pipe(Effect.flatMap(decodePlan));

    const nodes = flattenPlan(
      decodeExplain(plan?.["QUERY PLAN"] ?? "[]")[0]?.Plan ?? {}
    );

    const before = yield* readTableState(execute, "probe_casefold");
    let boundMatches = 0;

    for (let lookup = 0; lookup < BOUND_LOOKUPS; lookup += 1) {
      const ids = yield* request(
        SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) =>
              sql`SELECT id::text AS id FROM probe_casefold WHERE casefold(name COLLATE pg_unicode_fast) = ${"strasse"}`
          ),
          Effect.flatMap(decodeIds)
        )
      );

      boundMatches += ids.length;
    }

    const after = yield* readTableState(execute, "probe_casefold");

    yield* execute("DROP TABLE IF EXISTS probe_casefold_unique");
    yield* execute(
      "CREATE TABLE probe_casefold_unique (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code text NOT NULL)"
    );
    yield* execute(
      "CREATE UNIQUE INDEX CONCURRENTLY probe_casefold_unique_key ON probe_casefold_unique (casefold(code COLLATE pg_unicode_fast))"
    );

    const collisions: CollisionResult[] = [];

    for (const pair of KEY_COLLISIONS) {
      collisions.push(yield* tryCollision(request, pair));
    }

    const result: CasefoldProbeResult = {
      boundLookups: BOUND_LOOKUPS,
      boundMatches,
      collisions,
      defaultCollation: collation?.collation ?? "",
      foldExamples,
      idxScanDelta: after.idxScan - before.idxScan,
      indexBuildMs,
      planIndexes: nodes.flatMap((node) =>
        node["Index Name"] === undefined ? [] : [node["Index Name"]]
      ),
      planNodes: nodes.flatMap((node) =>
        node["Node Type"] === undefined ? [] : [node["Node Type"]]
      ),
      provolatile: volatility?.provolatile ?? "",
      rows: options.rows,
      seqScanDelta: after.seqScan - before.seqScan,
    };

    return result;
  }
);
