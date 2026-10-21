/**
 * The installed configuration a set load or an upgrade plans against: the
 * effective definitions and the config layer tables, read in one request
 * transaction so they belong to the same revision (`CONFIG_KEY` shared
 * keeps every config commit out while the transaction runs).
 */
import type { LayerState } from "@std/definitions/layers";
import { EMPTY_LAYERS } from "@std/definitions/layers";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Catalog } from "../catalog/catalog.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import { Transactions } from "../sql/transactions.ts";
import { readLayerState } from "./layer-store.ts";

/** The installed configuration at one state. */
export interface InstalledState {
  /** The state, or null before platform migrations created the tables. */
  readonly state: ConfigState | null;
  readonly snapshot: ConfigSnapshot;
  readonly layers: LayerState;
}

/** The empty state of a database without platform tables. */
const EMPTY_STATE: ConfigState = { changeSetId: "", revision: 0 };

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

/**
 * Whether the definition tables exist (platform migration 0002 applied).
 *
 * @returns True when they do.
 */
const definitionTablesExist = hygienic(
  Effect.gen(function* definitionTablesExist() {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* sql`
      SELECT to_regclass('core.namespace') IS NOT NULL
         AND to_regprocedure('core.begin_request()') IS NOT NULL AS present`.pipe(
      Effect.flatMap(decodePresence)
    );

    return row?.present === true;
  })
);

/**
 * Reads the installed configuration. A database whose platform migrations
 * have not created the definition tables yet reads as empty.
 *
 * @returns The state, snapshot and layer tables.
 */
export const readInstalledState: Effect.Effect<
  InstalledState,
  DatabaseError,
  Catalog | Transactions | SqlClient.SqlClient
> = Effect.gen(function* readInstalledState() {
  if (!(yield* definitionTablesExist)) {
    return {
      layers: EMPTY_LAYERS,
      snapshot: ConfigSnapshot.empty(EMPTY_STATE),
      state: null,
    };
  }

  const catalog = yield* Catalog;
  const { request } = yield* Transactions;

  return yield* request(
    Effect.gen(function* readAtOneRevision() {
      const state = yield* RequestRevision;
      const snapshot = yield* catalog.at(state);
      const layers = yield* readLayerState;

      return { layers, snapshot, state };
    })
  );
});
