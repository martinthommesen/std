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
 * One load runs at a time per process. The permit is only ever taken inside
 * a transaction that already holds `CONFIG_KEY` (shared or exclusive), so a
 * fiber waiting for the permit never blocks the config commit that the
 * permit holder is waiting for.
 *
 * `Catalog.listening` also listens on `std_config` and reloads early when
 * another process commits, including after its listener connection was
 * lost and re-established.
 */
import type { PgClient } from "@effect/sql-pg";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Context, Effect, Layer, Option, Ref, Semaphore, Stream } from "effect";
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

/**
 * The cache key of a configuration state.
 *
 * @param state - A revision and change set ID.
 * @returns `revision/changeSetId`.
 */
export const snapshotKeyOf = (state: ConfigState): string =>
  `${state.revision}/${state.changeSetId}`;

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

/** State shared by the catalog's functions. */
interface CatalogState {
  readonly permit: Semaphore.Semaphore;
  readonly cache: Ref.Ref<ReadonlyMap<string, ConfigSnapshot>>;
  readonly latest: Ref.Ref<Option.Option<ConfigSnapshot>>;
  readonly loads: Ref.Ref<number>;
}

const cachedAt = (
  state: CatalogState,
  key: string
): Effect.Effect<Option.Option<ConfigSnapshot>> =>
  Ref.get(state.cache).pipe(
    Effect.map((cache) => Option.fromNullishOr(cache.get(key)))
  );

const remember = (
  state: CatalogState,
  key: string,
  snapshot: ConfigSnapshot
): Effect.Effect<void> =>
  Effect.andThen(
    Ref.update(state.cache, (cache) => {
      const next = new Map(cache);
      next.delete(key);
      next.set(key, snapshot);

      for (const oldest of next.keys()) {
        if (next.size <= CACHED_SNAPSHOTS) {
          break;
        }

        next.delete(oldest);
      }

      return next;
    }),
    Ref.update(state.latest, (latest) =>
      Option.isSome(latest) && latest.value.revision > snapshot.revision
        ? latest
        : Option.some(snapshot)
    )
  );

const snapshotAt =
  (state: CatalogState) =>
  (
    config: ConfigState
  ): Effect.Effect<ConfigSnapshot, DatabaseError, SqlClient.SqlClient> => {
    const key = snapshotKeyOf(config);

    const load = Effect.gen(function* loadIfMissing() {
      const cached = yield* cachedAt(state, key);

      if (Option.isSome(cached)) {
        return cached.value;
      }

      const snapshot = yield* loadSnapshot(config);
      yield* Ref.update(state.loads, (count) => count + 1);
      yield* remember(state, key, snapshot);

      return snapshot;
    });

    return cachedAt(state, key).pipe(
      Effect.flatMap((cached) =>
        Option.isSome(cached)
          ? Effect.succeed(cached.value)
          : state.permit.withPermit(load)
      )
    );
  };

/**
 * Builds a catalog.
 *
 * @returns The catalog functions over fresh state.
 */
export const makeCatalog: Effect.Effect<CatalogApi, never, Transactions> =
  Effect.gen(function* makeCatalogState() {
    const { request } = yield* Transactions;

    const state: CatalogState = {
      cache: yield* Ref.make<ReadonlyMap<string, ConfigSnapshot>>(new Map()),
      latest: yield* Ref.make(Option.none<ConfigSnapshot>()),
      loads: yield* Ref.make(0),
      permit: yield* Semaphore.make(1),
    };

    const at = snapshotAt(state);

    return {
      at,
      current: RequestRevision.pipe(Effect.flatMap(at)),
      latest: Ref.get(state.latest),
      loads: Ref.get(state.loads),
      refresh: request(RequestRevision.pipe(Effect.flatMap(at))),
    };
  });

/**
 * Reloads whenever the signalled state differs from the latest snapshot.
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
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("Catalog reload failed", cause)
                )
              )
        )
      )
    )
  );

/** The configuration catalog of this process. */
export class Catalog extends Context.Service<Catalog, CatalogApi>()(
  "@std/server/catalog/catalog/Catalog"
) {
  /** A catalog without a listener: it loads on demand. */
  static readonly layer: Layer.Layer<Catalog, never, Transactions> =
    Layer.effect(Catalog, makeCatalog);

  /**
   * A catalog that also listens on `std_config` and reloads as soon as
   * another session commits configuration.
   */
  static readonly listening: Layer.Layer<
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
}
