/**
 * `std upgrade` (Contracts 8.5), offline in v0.1.
 *
 * 1. Refuse on a non-UTF8 database and while a `std-server` session is
 *    connected (`--plan` only reports the sessions).
 * 2. Take `SCHEMA_KEY` with `pg_try_advisory_lock` on a dedicated
 *    connection and hold it for the whole run.
 * 3. Compare versions: the migration ledger with the code (an unknown or
 *    changed migration refuses), and every set with its installed version
 *    (a downgrade refuses).
 * 4. Plan: pending migrations, change sets to resume, and per set (core
 *    first, then apps in `requires` order, cycles refused) its diff,
 *    conflicts, converged overrides, removals, refusals and security
 *    changes, sets after the first planned against the earlier sets'
 *    results in memory. The plan has a hash over all of that and the
 *    configuration state it started from.
 * 5. `--plan` stops here and changes nothing. The real run refuses when the
 *    plan has refusals, or when `--expect <hash>` differs from the plan's
 *    hash (the database changed since the reviewed plan).
 * 6. Run `tx` and `concurrent_index` platform migrations, resume
 *    interrupted change sets, then load each set as one change set. Before
 *    each set the run plans it again against the database and stops if its
 *    diff differs from the plan; its main transaction also stops if another
 *    config commit came first.
 * 7. Run the `data` migrations that are pending or `running`
 *    (`platform/data-migrations.ts`): they change records of the classes
 *    the sets just loaded.
 *
 * Every step commits on its own, so after a failure a rerun continues from
 * the last committed migration or change set: committed sets plan nothing.
 */
import type { Owner } from "@std/definitions/definition";
import type { LayerState } from "@std/definitions/layers";
import { DefinitionInvalid, problem } from "@std/definitions/problems";
import type { NamedSetFile, SetHeader } from "@std/definitions/set-file";
import type { LifecycleOperations } from "@std/definitions/set-upgrade";
import type {
  Refusal,
  SecurityChange,
  SetReport,
} from "@std/definitions/upgrade-report";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";

import {
  dataBatchSize,
  runDataMigrations,
} from "../platform/data-migrations.ts";
import type {
  DataBatchSizeInvalid,
  DataMigrationOutcome,
  DataMigrationServices,
} from "../platform/data-migrations.ts";
import { compareLedger, readLedger, refusalOf } from "../platform/ledger.ts";
import type { MigrationStateRefused } from "../platform/ledger.ts";
import type {
  DataMigrationFailed,
  PlatformMigration,
} from "../platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../platform/migrations.ts";
import {
  applyPendingMigrations,
  checkUpgradePreconditions,
  refuseSchemaBusy,
} from "../platform/runner.ts";
import type { MigrationOutcome, UpgradeRefused } from "../platform/runner.ts";
import type {
  ChangeSetError,
  ChangeSetOptions,
  ChangeSetResult,
  ChangeSetServices,
} from "../schema/change-set.ts";
import { makeDedicatedConnection } from "../sql/dedicated.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { SCHEMA_KEY } from "../sql/locks.ts";
import { STD_VERSION } from "../version.ts";
import { readInstalledState } from "./installed-state.ts";
import type { InstalledState } from "./installed-state.ts";
import { jsonHash } from "./layer-store.ts";
import {
  plannedResumes,
  resumeInterrupted,
  SCHEMA_LIFECYCLE,
} from "./lifecycle.ts";
import type { PlannedResume, ResumedChangeSet } from "./lifecycle.ts";
import {
  applySetLoad,
  planSetLoad,
  refusalError,
  requiredOwners,
} from "./load-set.ts";
import type { PlannedSetLoad } from "./load-set.ts";
import { CORE_SET_DIRECTORY, readSetDirectory } from "./set-files.ts";
import type { SetRefused } from "./set-refused.ts";
import { UpgradeIncomplete } from "./upgrade-incomplete.ts";
import { UpgradePlanStale } from "./upgrade-plan-stale.ts";

/** Options of `std upgrade`. */
export interface UpgradeOptions extends ChangeSetOptions {
  /** App set directories, in any order (loaded in `requires` order). */
  readonly sets?: readonly string[];
  /** The core set (default: the one shipped with the server). */
  readonly coreDirectory?: string;
  /** Platform migrations (default: all of them). */
  readonly migrations?: readonly PlatformMigration[];
  /** The hash of the reviewed plan; the run refuses when it differs. */
  readonly expectedPlanHash?: string;
  /** Lifecycle operations of the schema engine (default: `SCHEMA_LIFECYCLE`). */
  readonly lifecycle?: LifecycleOperations;
  /** Records per `data` migration batch (default `DATA_BATCH_SIZE`). */
  readonly dataBatchSize?: number;
}

/** A platform migration the upgrade runs. */
export interface PlannedMigration {
  readonly id: number;
  readonly name: string;
  readonly kind: PlatformMigration["kind"];
  /** `recheck` inspects an applied optional-app migration after its sets load. */
  readonly state: "pending" | "running" | "recheck";
}

/** A security change and the set making it. */
export interface PlannedSecurityChange extends SecurityChange {
  readonly set: string;
}

/** What `std upgrade` will do (`--plan`), and what the real run did first. */
export interface UpgradePlan {
  readonly stdVersion: string;
  /** The configuration state the plan starts from (null before migrations). */
  readonly basis: {
    readonly revision: number | null;
    readonly changeSetId: string | null;
  };
  readonly migrations: readonly PlannedMigration[];
  /** Open change sets: `applying` ones are resumed, the rest reported. */
  readonly resume: readonly PlannedResume[];
  /** Per set, in load order. */
  readonly sets: readonly SetReport[];
  /** Every refusal of every set; any refusal refuses the whole upgrade. */
  readonly refusals: readonly Refusal[];
  /** Every access-rule, role and permission-grant change. */
  readonly security: readonly PlannedSecurityChange[];
  /** Not part of the hash: connected servers, content changed without a version bump. */
  readonly warnings: readonly string[];
  /** SHA-256 over everything above except the warnings. */
  readonly hash: string;
}

/** What one set's change set did. */
export interface UpgradedSet {
  readonly name: string;
  readonly version: number;
  readonly result: ChangeSetResult;
}

/** What `std upgrade` did. */
export interface UpgradeReport {
  /** The plan the run applied. */
  readonly plan: UpgradePlan;
  readonly migrations: readonly MigrationOutcome[];
  readonly resumed: readonly ResumedChangeSet[];
  readonly sets: readonly UpgradedSet[];
  /** The `data` migrations this run applied or completed. */
  readonly dataMigrations: readonly DataMigrationOutcome[];
}

/** Errors of `std upgrade --plan`. */
export type PlanError =
  | UpgradeRefused
  | MigrationStateRefused
  | DefinitionInvalid
  | DatabaseError;

/** Services of a plan run, its scope included. */
type PlanServices = ChangeSetServices | Scope.Scope;

/** Errors of `std upgrade`. */
export type UpgradeError =
  | DataBatchSizeInvalid
  | DataMigrationFailed
  | UpgradeIncomplete
  | UpgradeRefused
  | MigrationStateRefused
  | UpgradePlanStale
  | SetRefused
  | ChangeSetError;

/** One set read from disk. */
interface SetSource {
  readonly directory: string;
  readonly header: SetHeader;
  readonly files: readonly NamedSetFile[];
}

const headerOf = (
  directory: string,
  files: readonly NamedSetFile[]
): Effect.Effect<SetHeader, DefinitionInvalid> => {
  const headers = files.flatMap((file) =>
    file.content.set === undefined ? [] : [file.content.set]
  );

  const [header] = headers;

  return headers.length === 1 && header !== undefined
    ? Effect.succeed(header)
    : Effect.fail(
        new DefinitionInvalid({
          problems: [
            problem(
              "invalidName",
              null,
              `The set in ${directory} has ${headers.length} set headers; a set has exactly one.`
            ),
          ],
        })
      );
};

const readSources = Effect.fn("Config.readSetSources")(function* readSources(
  directories: readonly string[]
) {
  const sources: SetSource[] = [];

  for (const directory of directories) {
    const files = yield* readSetDirectory(directory);

    sources.push({
      directory,
      files,
      header: yield* headerOf(directory, files),
    });
  }

  return sources;
});

/** The sets in load order, or the refusals that prevent ordering them. */
interface SetOrder {
  readonly order: readonly SetSource[];
  readonly refusals: readonly Refusal[];
}

const isReady = (
  source: SetSource,
  done: ReadonlySet<string>,
  given: ReadonlySet<string>
): boolean =>
  (source.header.requires ?? []).every(
    (name) => done.has(name) || !given.has(name)
  );

/**
 * The sets that lie on a `requires` cycle, a set requiring itself
 * included.
 *
 * @param requires - Every set's required set names.
 * @returns The names on a cycle.
 */
const cyclicSets = (
  requires: ReadonlyMap<string, readonly string[]>
): ReadonlySet<string> => {
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(requires.get(from) ?? [])];

    while (stack.length > 0) {
      const next = stack.pop() ?? "";

      if (next === target) {
        return true;
      }

      if (!seen.has(next)) {
        seen.add(next);
        stack.push(...(requires.get(next) ?? []));
      }
    }

    return false;
  };

  return new Set([...requires.keys()].filter((name) => reaches(name, name)));
};

const cycleRefusals = (
  cyclic: ReadonlySet<string>,
  requires: ReadonlyMap<string, readonly string[]>,
  ids: ReadonlyMap<string, string>
): readonly Refusal[] => {
  const names = [...cyclic].toSorted().join(", ");

  return [...cyclic].toSorted().map((name) => ({
    code: "setCycle",
    definitionId: ids.get(name) ?? null,
    details: { requires: requires.get(name) ?? [] },
    message: `The set ${name} requires itself through these sets: ${names}.`,
    set: name,
  }));
};

/**
 * Orders sets for loading (Contracts 8.3 step 7): core first, then app sets
 * after the sets they require (ties in the given order). The whole
 * dependency graph is checked first, installed sets included: any cycle,
 * a set requiring itself included, refuses.
 *
 * @param sources - The core set first, then the app sets as given.
 * @param installed - The installed sets.
 * @returns The order, or refusals naming the sets on a cycle.
 */
const orderSets = (
  sources: readonly SetSource[],
  installed: LayerState["sets"]
): SetOrder => {
  const requires = new Map<string, readonly string[]>();
  const ids = new Map<string, string>();

  for (const set of installed.values()) {
    requires.set(set.name, set.requires);
    ids.set(set.name, set.id);
  }

  for (const source of sources) {
    requires.set(source.header.name, source.header.requires ?? []);
    ids.set(source.header.name, source.header.id);
  }

  const cyclic = cyclicSets(requires);

  if (cyclic.size > 0) {
    return { order: [], refusals: cycleRefusals(cyclic, requires, ids) };
  }

  const given = new Set(sources.map((source) => source.header.name));
  const done = new Set<string>();
  const order: SetSource[] = [];
  const pending = [...sources];

  for (;;) {
    const index = pending.findIndex((source) => isReady(source, done, given));
    const ready = pending[index];

    if (ready === undefined) {
      return { order, refusals: [] };
    }

    order.push(ready);
    done.add(ready.header.name);
    pending.splice(index, 1);
  }
};

/** The plan without its hash and warnings: what the hash covers. */
type HashedPlan = Omit<UpgradePlan, "hash" | "warnings">;

/** Report data that is hashed or compared. */
type ReportData = HashedPlan | SetReport;

/**
 * A plain JSON copy of report data, for hashing and comparing.
 *
 * @param value - Report data.
 * @returns The JSON value.
 */
const asJson = (value: ReportData): JsonValue => {
  const parsed = parseJson(JSON.stringify(value));

  return parsed.ok ? parsed.value : null;
};

const reportHash = (value: ReportData): string => jsonHash(asJson(value));

/** Everything the plan computes besides the report. */
interface ComputedPlan {
  readonly plan: UpgradePlan;
  readonly order: readonly SetSource[];
}

const pendingMigrations = Effect.fn("Config.pendingMigrations")(
  function* pendingMigrations(
    connection: DedicatedConnection,
    migrations: readonly PlatformMigration[]
  ): Effect.fn.Return<
    readonly PlannedMigration[],
    MigrationStateRefused | DatabaseError
  > {
    const ledger = yield* hygienic(readLedger(connection.client));
    const comparison = compareLedger(migrations, ledger);
    const refusal = refusalOf(comparison, true);

    if (refusal !== undefined) {
      return yield* refusal;
    }

    const planned: PlannedMigration[] = [
      ...comparison.pending.map((migration) => ({
        id: migration.id,
        kind: migration.kind,
        name: migration.name,
        state: "pending" as const,
      })),
      ...comparison.incomplete.map(({ migration }) => ({
        id: migration.id,
        kind: migration.kind,
        name: migration.name,
        state: "running" as const,
      })),
    ];

    return planned.toSorted((left, right) => left.id - right.id);
  }
);

/**
 * Change sets that wait for an admin refuse the upgrade: a database with
 * unfinished change sets must never look upgraded.
 *
 * @param open - The open change sets.
 * @returns One refusal per change set in `needs_attention`.
 */
const unfinishedRefusals = (
  open: readonly PlannedResume[]
): readonly Refusal[] =>
  open.flatMap((changeSet) =>
    changeSet.state === "needs_attention"
      ? [
          {
            code: "unfinishedChangeSet",
            definitionId: changeSet.id,
            details: {},
            message: `Change set ${changeSet.id} needs attention; fix the cause and run std schema resume ${changeSet.id}, or std schema abandon ${changeSet.id}, then rerun std upgrade.`,
            set: "journal",
          } satisfies Refusal,
        ]
      : []
  );

/** The state carried from one planned set to the next. */
interface Chain {
  readonly installed: InstalledState;
  readonly owners: ReadonlyMap<string, Owner>;
}

const nextChain = (chain: Chain, planned: PlannedSetLoad): Chain => ({
  installed: {
    layers: planned.upgrade.layersAfter,
    snapshot: planned.upgrade.applied?.after ?? chain.installed.snapshot,
    state: chain.installed.state,
  },
  owners: new Map([...chain.owners, [planned.header.name, planned.owner]]),
});

const planSets = Effect.fn("Config.planSets")(function* planSets(
  connection: DedicatedConnection,
  order: readonly SetSource[],
  installed: InstalledState,
  lifecycle: LifecycleOperations
) {
  const reports: SetReport[] = [];
  let chain: Chain = { installed, owners: new Map() };

  for (const source of order) {
    const { layers } = chain.installed;
    const required = requiredOwners(layers, chain.owners);

    const planned = yield* planSetLoad(source.files, chain.installed, {
      connection,
      lifecycle,
      required,
    });

    reports.push(planned.upgrade.report);
    chain = nextChain(chain, planned);
  }

  return reports;
});

const warningsOf = (
  servers: readonly number[],
  reports: readonly SetReport[]
): readonly string[] => [
  ...(servers.length > 0
    ? [
        `std-server sessions are connected (pids ${servers.join(", ")}); the real run refuses until the servers stop.`,
      ]
    : []),
  ...reports.flatMap((report) =>
    report.contentChangedWithoutVersion
      ? [
          `The set ${report.name} ships different content under the installed version ${report.toVersion}; give changed sets a new version.`,
        ]
      : []
  ),
];

const computePlan = Effect.fn("Config.computePlan")(function* computePlan(
  connection: DedicatedConnection,
  options: UpgradeOptions,
  servers: readonly number[]
): Effect.fn.Return<
  ComputedPlan,
  MigrationStateRefused | DefinitionInvalid | DatabaseError,
  ChangeSetServices
> {
  const migrations = yield* pendingMigrations(
    connection,
    options.migrations ?? PLATFORM_MIGRATIONS
  );

  const resume = yield* plannedResumes(connection);
  const installed = yield* readInstalledState;

  const sources = yield* readSources([
    options.coreDirectory ?? CORE_SET_DIRECTORY,
    ...(options.sets ?? []),
  ]);

  // A repeated data migration may first become applicable when this run
  // installs its optional app. Show the check in the plan and its hash,
  // even when the post-set remaining proof will find no work to do.
  const setVersions = new Map(
    [...installed.layers.sets.values()].map((set) => [set.name, set.version])
  );

  for (const source of sources) {
    setVersions.set(source.header.name, source.header.version);
  }

  const listed = new Set(migrations.map((migration) => migration.id));
  const rechecks: PlannedMigration[] = [];

  for (const migration of options.migrations ?? PLATFORM_MIGRATIONS) {
    if (
      migration.kind !== "data" ||
      migration.repeatable !== true ||
      listed.has(migration.id)
    ) {
      continue;
    }

    const requiredSet = migration.recheckForSet;

    if (
      requiredSet === undefined ||
      (setVersions.get(requiredSet.name) ?? 0) >= requiredSet.minVersion
    ) {
      rechecks.push({
        id: migration.id,
        kind: migration.kind,
        name: migration.name,
        state: "recheck",
      });
    }
  }

  const { order, refusals: orderRefusals } = orderSets(
    sources,
    installed.layers.sets
  );

  const sets =
    orderRefusals.length > 0
      ? []
      : yield* planSets(
          connection,
          order,
          installed,
          options.lifecycle ?? SCHEMA_LIFECYCLE
        );

  const hashed: HashedPlan = {
    basis: {
      changeSetId: installed.state?.changeSetId ?? null,
      revision: installed.state?.revision ?? null,
    },
    migrations: [...migrations, ...rechecks].toSorted(
      (left, right) => left.id - right.id
    ),
    refusals: [
      ...unfinishedRefusals(resume),
      ...orderRefusals,
      ...sets.flatMap((set) => set.refusals),
    ],
    resume,
    security: sets.flatMap((set) =>
      set.security.map((change) => ({ ...change, set: set.name }))
    ),
    sets,
    stdVersion: STD_VERSION,
  };

  return {
    order,
    plan: {
      ...hashed,
      hash: reportHash(hashed),
      warnings: warningsOf(servers, sets),
    },
  };
});

/**
 * Opens `std upgrade`'s dedicated connection and takes `SCHEMA_KEY`, held
 * until the scope closes.
 *
 * @returns The connection, or `UpgradeRefused` (`schema-busy`).
 */
const openUpgradeConnection = Effect.gen(function* openUpgradeConnection() {
  const connection = yield* makeDedicatedConnection();

  if (!(yield* connection.tryAdvisoryLock(SCHEMA_KEY))) {
    return yield* refuseSchemaBusy(connection);
  }

  yield* Effect.addFinalizer(() =>
    Effect.ignore(connection.advisoryUnlock(SCHEMA_KEY))
  );

  return connection;
});

/**
 * Plans the upgrade and changes nothing (`std upgrade --plan`). It holds
 * `SCHEMA_KEY` while it reads, so data counts see no concurrent schema
 * change; connected servers are reported as a warning.
 *
 * @param options - Sets, migrations and lifecycle operations.
 * @returns The plan.
 */
export const planUpgrade: (
  options?: UpgradeOptions
) => Effect.Effect<UpgradePlan, PlanError, ChangeSetServices> = Effect.fn(
  "Config.planUpgrade"
)(
  function* planUpgrade(
    options: UpgradeOptions = {}
  ): Effect.fn.Return<UpgradePlan, PlanError, PlanServices> {
    const pool = yield* SqlClient.SqlClient;

    const servers = yield* checkUpgradePreconditions(pool, {
      allowServers: true,
    });

    const connection = yield* openUpgradeConnection;
    const { plan } = yield* computePlan(connection, options, servers);

    return plan;
  },
  (effect) => Effect.scoped(effect)
);

const applySets = Effect.fn("Config.applySets")(function* applySets(
  connection: DedicatedConnection,
  computed: ComputedPlan,
  options: UpgradeOptions
): Effect.fn.Return<readonly UpgradedSet[], UpgradeError, ChangeSetServices> {
  const outcomes: UpgradedSet[] = [];
  const owners = new Map<string, Owner>();
  const lifecycle = options.lifecycle ?? SCHEMA_LIFECYCLE;

  for (const [index, source] of computed.order.entries()) {
    const installed = yield* readInstalledState;

    const planned = yield* planSetLoad(source.files, installed, {
      connection,
      lifecycle,
      required: requiredOwners(installed.layers, owners),
    });

    const expected = computed.plan.sets[index];

    if (
      expected === undefined ||
      reportHash(expected) !== reportHash(planned.upgrade.report)
    ) {
      return yield* new UpgradePlanStale({
        actual: null,
        expected: null,
        set: source.header.name,
      });
    }

    const { header } = planned;

    const result = yield* applySetLoad(planned, {
      ...options,
      coordinator: connection,
    });

    if (result.state === "needs_attention") {
      return yield* new UpgradeIncomplete({
        changeSetId: result.changeSetId ?? "",
        error: result.error,
        set: header.name,
      });
    }

    owners.set(header.name, planned.owner);
    outcomes.push({ name: header.name, result, version: header.version });
  }

  return outcomes;
});

/**
 * Runs the upgrade.
 *
 * @param options - Sets, the expected plan hash, migrations, retry delays.
 * @returns The plan it applied and what each step did.
 */
export const runUpgrade: (
  options?: UpgradeOptions
) => Effect.Effect<
  UpgradeReport,
  UpgradeError,
  ChangeSetServices | DataMigrationServices
> = Effect.fn("Config.runUpgrade")(
  function* runUpgrade(
    options: UpgradeOptions = {}
  ): Effect.fn.Return<
    UpgradeReport,
    UpgradeError,
    ChangeSetServices | DataMigrationServices | Scope.Scope
  > {
    const pool = yield* SqlClient.SqlClient;

    // Before anything runs: a bad batch size must not leave a half-run upgrade.
    const batchSize = yield* dataBatchSize(options.dataBatchSize);

    yield* checkUpgradePreconditions(pool);
    const connection = yield* openUpgradeConnection;
    const computed = yield* computePlan(connection, options, []);
    const { plan } = computed;

    if (
      options.expectedPlanHash !== undefined &&
      options.expectedPlanHash !== plan.hash
    ) {
      return yield* new UpgradePlanStale({
        actual: plan.hash,
        expected: options.expectedPlanHash,
        set: null,
      });
    }

    if (plan.refusals.length > 0) {
      return yield* refusalError(plan.refusals);
    }

    const migrations = yield* applyPendingMigrations(
      connection,
      options.migrations ?? PLATFORM_MIGRATIONS
    );

    const resumed = yield* resumeInterrupted(connection, plan.resume, options);

    const stuck = resumed.find(
      (entry) => entry.outcome.state === "needs_attention"
    );

    if (stuck !== undefined) {
      return yield* new UpgradeIncomplete({
        changeSetId: stuck.id,
        error: stuck.outcome.error,
        set: null,
      });
    }

    const sets = yield* applySets(connection, computed, options);

    const dataMigrations = yield* runDataMigrations({
      batchSize,
      migrations: options.migrations ?? PLATFORM_MIGRATIONS,
    });

    return { dataMigrations, migrations, plan, resumed, sets };
  },
  (effect) => Effect.scoped(effect)
);
