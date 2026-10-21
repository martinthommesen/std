/**
 * The per-process configuration cache (Contracts 1.3).
 *
 * Snapshots are cached under `(revision, change_set_id)`, so a database
 * restored to an earlier state, which reaches the same revision number
 * through different change sets, is never mistaken for the cached one.
 * Correctness always comes from the revision the transaction runs at
 * (`core.begin_request()` in requests, the locked state in config commits):
 * `Catalog.current` returns exactly that snapshot, loading it in the same
 * transaction when the cache does not hold it.
 *
 * The cache is an `effect/Cache` keyed by `revision/change_set_id`, with
 * room for `CACHED_SNAPSHOTS` snapshots, successes kept until evicted and
 * failures not kept. Its lookup takes the SQL client of the caller's
 * transaction (`requireServicesAt: "lookup"`), so a snapshot is always read
 * in a transaction running at exactly its key.
 *
 * One load runs at a time per process: a miss takes a permit around
 * `Cache.get`, inside the caller's transaction. The permit is only ever
 * taken inside a transaction that already holds `CONFIG_KEY` (shared or
 * exclusive), so a fiber waiting for it never blocks the config commit the
 * permit holder waits for, and a pending lookup never outlives the
 * transaction that started it.
 *
 * `listeningCatalogLayer` also listens on `std_config` and reloads early when
 * another process commits, including after its listener connection was
 * lost and re-established.
 */
import type { PgClient } from "@effect/sql-pg";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Semaphore,
  Stream,
} from "effect";
import type { Scope } from "effect";
import type { SqlClient } from "effect/sql";

import { configSignals } from "../sql/config-listener.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import { Transactions } from "../sql/transactions.ts";
import { loadSnapshot } from "./load.ts";

/** How many snapshots a process keeps. */
export const CACHED_SNAPSHOTS = 4;

const KEY_SEPARATOR = "/";

/**
 * The cache key of a configuration state.
 *
 * @param state - A revision and change set ID.
 * @returns `revision/changeSetId`.
 */
export const snapshotKeyOf = (state: ConfigState): string =>
  `${state.revision}${KEY_SEPARATOR}${state.changeSetId}`;

/**
 * The configuration state of a cache key.
 *
 * @param key - `revision/changeSetId`.
 * @returns The state.
 */
const stateOfKey = (key: string): ConfigState => {
  const separator = key.indexOf(KEY_SEPARATOR);

  return {
    changeSetId: key.slice(separator + 1),
    revision: Number(key.slice(0, separator)),
  };
};

/** The catalog of one process. */
export interface CatalogApi {
  /**
   * The snapshot of the running transaction's revision. Call it inside a
   * request or config-commit transaction.
   */
  readonly current: Effect.Effect<
    ConfigSnapshot,
    DatabaseError,
    RequestRevision | SqlClient.SqlClient
  >;
  /**
   * The snapshot at a state, loaded in the current transaction if it is
   * not cached. The transaction must run at exactly that state.
   */
  readonly at: (
    state: ConfigState
  ) => Effect.Effect<ConfigSnapshot, DatabaseError, SqlClient.SqlClient>;
  /** Loads the latest configuration in its own request transaction. */
  readonly refresh: Effect.Effect<ConfigSnapshot, DatabaseError>;
  /** The most recently loaded snapshot, if any. */
  readonly latest: Effect.Effect<Option.Option<ConfigSnapshot>>;
  /** How many loads this process has run (for tests and metrics). */
  readonly loads: Effect.Effect<number>;
}

/** The configuration catalog of this process. */
export class Catalog extends Context.Service<Catalog, CatalogApi>()(
  "@std/server/catalog/catalog/Catalog"
) {}

/**
 * Builds a catalog: the cache, the load permit and the latest snapshot.
 *
 * @returns The catalog functions over fresh state.
 */
export const makeCatalog: Effect.Effect<CatalogApi, never, Transactions> =
  Effect.gen(function* makeCatalogState() {
    const { request } = yield* Transactions;
    const permit = yield* Semaphore.make(1);
    const latest = yield* Ref.make(Option.none<ConfigSnapshot>());
    const loads = yield* Ref.make(0);

    const load = Effect.fn("Catalog.load")(function* load(key: string) {
      const snapshot = yield* loadSnapshot(stateOfKey(key));

      yield* Ref.update(loads, (count) => count + 1);
      yield* Ref.update(latest, (previous) =>
        Option.isSome(previous) && previous.value.revision > snapshot.revision
          ? previous
          : Option.some(snapshot)
      );

      return snapshot;
    });

    const cache = yield* Cache.makeWith(load, {
      capacity: CACHED_SNAPSHOTS,
      requireServicesAt: "lookup",
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    });

    const at = Effect.fn("Catalog.at")(function* at(state: ConfigState) {
      const key = snapshotKeyOf(state);
      const cached = yield* Cache.getSuccess(cache, key);

      if (Option.isSome(cached)) {
        return cached.value;
      }

      return yield* permit.withPermit(Cache.get(cache, key));
    });

    return Catalog.of({
      at,
      current: RequestRevision.pipe(Effect.flatMap(at)),
      latest: Ref.get(latest),
      loads: Ref.get(loads),
      refresh: request(RequestRevision.pipe(Effect.flatMap(at))),
    });
  });

/**
 * Reloads whenever the signalled state differs from the latest snapshot. A
 * failed reload is logged; the next signal or request loads again.
 *
 * @param catalog - The catalog to keep fresh.
 * @returns An effect that runs until interrupted.
 */
export const followSignals = (
  catalog: CatalogApi
): Effect.Effect<void, never, PgClient.PgClient | Scope.Scope> =>
  configSignals.pipe(
    Stream.runForEach((signal) =>
      catalog.latest.pipe(
        Effect.flatMap((latest) =>
          Option.isSome(latest) &&
          snapshotKeyOf(latest.value) === snapshotKeyOf(signal.state)
            ? Effect.void
            : catalog.refresh.pipe(
                Effect.tapError((failure) =>
                  Effect.logWarning("Catalog reload failed", failure)
                ),
                Effect.ignore
              )
        )
      )
    )
  );

/** A catalog without a listener: it loads on demand. */
export const catalogLayer: Layer.Layer<Catalog, never, Transactions> =
  Layer.effect(Catalog, makeCatalog);

/**
 * A catalog that also listens on `std_config` and reloads as soon as
 * another session commits configuration.
 */
export const listeningCatalogLayer: Layer.Layer<
  Catalog,
  never,
  Transactions | PgClient.PgClient
> = Layer.effect(
  Catalog,
  Effect.gen(function* listeningCatalog() {
    const catalog = yield* makeCatalog;
    yield* Effect.forkScoped(followSignals(catalog));

    return catalog;
  })
);
