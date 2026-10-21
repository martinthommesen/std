# 0002. STD's SQL layer, platform migrations and test databases

Status: accepted, 2026-10-20 (workstream 0A). Code: `packages/server/src/sql`, `packages/server/src/platform`, `packages/server/src/cli`, `packages/testing`.

## Decision

All STD code talks to Postgres through `@std/server/sql/*`, a thin layer over `@effect/sql-pg` 4.0.5. Statements are still written with the `SqlClient` tagged template; transactions, session setup, text reads, error hygiene, locks and LISTEN go through the layer. Platform tables are created by numbered, forward-only platform migrations that only `std upgrade` applies. Tests get a fresh migrated database per test file from `@std/testing`.

## API

Import each module by its subpath, for example `@std/server/sql/transactions`.

| Module | What it provides |
| --- | --- |
| `sql/database-config` | `DatabaseConfig` service (`url`, `directUrl`, `applicationName`, `maxConnections`); `DatabaseConfig.fromEnv(appName)` reads `STD_DATABASE_URL` (default `postgres://std:std@127.0.0.1:54329/std`), `STD_DATABASE_DIRECT_URL`, `STD_DATABASE_MAX_CONNECTIONS`; `fromUrl`; `SERVER_APPLICATION_NAME = "std-server"`, `CLI_APPLICATION_NAME = "std-cli"` |
| `sql/layer` | `SqlLayer`: `PgClient`, `SqlClient`, `Transactions`, `WorkerWakeup`, built from `DatabaseConfig` (connections open lazily) |
| `sql/client` | `PgLive`, the pooled client alone |
| `sql/sanitizing-client` | `makeSanitizedPool`, `makeSanitizedConnection`: `PgClient`s assembled from the driver's `PgPool`/`PgConnection`, `SqlClient.make` and `PgClient.makeCompiler`, whose every connection sanitizes statement errors |
| `sql/session` | `SESSION_PARAMETERS` (`TimeZone=UTC`, `DateStyle=ISO`), `COORDINATOR_KEEPALIVE_PARAMETERS`, `connectionConfig(setup)` (session parameters, text registry, statement-log tap) |
| `sql/text-codecs` | `makeTextRegistry()` and the binary-to-text readers for `int8`, `numeric`, `date`, `timestamp`, `timestamptz`, `json`, `jsonb` |
| `sql/transactions` | `Transactions` service: `request(effect, { isolation? })`, `configCommit(effect, { retryDelays? })`, `maintenance(effect, { lockTimeout?, statementTimeout? })`; `makeTransactions(client, monitor)` for other clients |
| `sql/transaction` | the rules and building blocks: `runOutermost`, `joinTransaction`, `currentState`, `BEGIN_STATEMENT`, `BEGIN_REQUEST_QUERY`, timeouts, `TransactionServices` |
| `sql/transaction-context` | `CurrentTransaction` service: `kind`, `afterCommit(action)`, `markWrite`, `poisonReason` |
| `sql/request-revision` | `RequestRevision` service (`{ revision, changeSetId }`) and `parseConfigState` |
| `sql/transaction-state` | per-transaction bookkeeping, `refusalFor(sql)` (the statement check), the tracking connection wrapper |
| `sql/statement-lexer` | `analyzeStatement(sql)`: statement count and leading words, lexed like Postgres (comments, quotes, dollar quotes) |
| `sql/statement-marks` | `readOnly(effect)` and `lockWaiting(effect)`: the only ways to exempt a statement from poisoning or to make its lock timeout retryable |
| `sql/transaction-refused` | `TransactionRefused` defect, `reason`: `poisoned`, `isolation-level`, `savepoint`, `transaction-control`, `nesting`, `closed` |
| `sql/config-commit` | config-commit machinery, `bumpRevision(changeSetId)`, `SchemaLockTimeout` (`attempts`, `holders`: pid, application name, client address, state, granted locks), `CONFIG_CHANNEL = "std_config"`, timeouts and `DEFAULT_RETRY_DELAYS` |
| `sql/dedicated` | `makeDedicatedConnection({ applicationName? })`: `processId`, `client`, `transactions`, `execute` (autocommit), `tryAdvisoryLock`, `advisoryUnlock` |
| `sql/config-listener` | `configSignals`: `Stream<{ reason: "listening" \| "notified", state }>` that never fails and reconnects |
| `sql/wake-up` | `WorkerWakeup` (`wake`), `WorkerWakeupLayer`, `wakeWorkerAfterCommit`, `WORKER_CHANNEL = "std_worker"` |
| `sql/statement-log` | `StatementLog` service (`entries`, `texts`, `clear`) and `StatementLog.layer`; `StatementObserver` reference |
| `sql/errors` | `DatabaseError` (`sqlState`, `constraint?`, `diagnosticId?`), `sanitizeSqlError`, `isSanitized`, `logSqlError`, `hygienic(effect)` (failures and defects), `sanitizeCause` (fallback for the HTTP edge), `toDatabaseError`, `sqlStateOf`, SQLSTATE constants |
| `sql/rows` | `decodeRows(schema)`: decode driver rows with Effect Schema (mismatch is a defect) |
| `sql/locks` | `CONFIG_KEY`, `SCHEMA_KEY`, `advisoryClassId`, `advisoryObjectId` |
| `platform/migration` | `TxMigration`, `ConcurrentIndexMigration`, `migrationChecksum`, `validateMigrations` |
| `platform/migrations` | `PLATFORM_MIGRATIONS` (append only); `platform/migrations/0001-core` |
| `platform/ledger` | `readLedger`, `compareLedger`, `MigrationStateRefused` (`pending`, `unknown`, `changed`) |
| `platform/runner` | `checkPlatformMigrations()` (server startup check), `runPlatformMigrations()` (the migration step of `std upgrade`), `checkUpgradePreconditions`, `UpgradeRefused` (`encoding`, `servers-connected`, `schema-busy`) |
| `cli/main` | `std upgrade` (root script `pnpm std upgrade`) |
| `@std/testing/test-database` | `testDatabaseLayer(options?)`, `TestDatabase` service (`name`, `url`, `template`, `session(appName?)`), `ensureTemplate`, `runJanitor` |

Typical use:

```ts
const { request } = yield * Transactions;
const rows =
  yield *
  request(
    Effect.gen(function* () {
      const { revision } = yield* RequestRevision;
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`SELECT ...`;
    })
  );
```

Inside a transaction, `SqlClient`, `PgClient`, `CurrentTransaction` and (for request and config commits) `RequestRevision` are provided; `request` and `configCommit` remove them from the effect's requirements. Errors leave as `DatabaseError` instead of `SqlError`. Yield `SqlClient` inside the transaction: a constructor captured outside belongs to the client it came from, which matters for transactions on a dedicated connection.

## Transactions

- **Request**: `BEGIN ISOLATION LEVEL READ COMMITTED`, `SET LOCAL statement_timeout = '30s'`, `SET LOCAL idle_in_transaction_session_timeout = '10s'`, then `SELECT revision, change_set_id FROM core.begin_request()` (the first query; the `SET LOCAL`s take no snapshot). The order is asserted on the statement log.
- **READ COMMITTED only**: every STD transaction begins with an explicit `ISOLATION LEVEL READ COMMITTED`, so a database or role default does not leak in (tested with `ALTER DATABASE ... SET default_transaction_isolation = 'serializable'`). Asking for another level, or `SET TRANSACTION ... ISOLATION LEVEL` inside, dies with `TransactionRefused`.
- **Nesting**: `request` inside a running transaction joins it: no `BEGIN`, no second `begin_request()`, no `SAVEPOINT`. `configCommit` inside a config commit joins; inside a request it is refused (a request holds `CONFIG_KEY` shared, and upgrading would deadlock, Contracts 1.4). `maintenance` cannot nest. Every statement of the transaction's code is lexed before it is sent (`statement-lexer.ts`: whitespace, `--` comments ended by CR, LF or CRLF, nested `/* */` comments, `'...'`, `E'...'`, `U&'...'`, `"..."`, `U&"..."`, dollar quotes, `$n`, punctuation) and then classified against an allowlist (`STATEMENT_KEYWORDS` in `transaction-state.ts`): the text must hold exactly one non-empty statement and no top-level `;` at all, and start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `COMMENT`, `LOCK`, `NOTIFY`, `LISTEN`, `UNLISTEN`, `EXPLAIN`, `ANALYZE`, or `SET LOCAL <name> = | TO ...` where `<name>` is an unquoted word from `TRANSACTION_SETTINGS` (`lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`). That is what STD generates: reads, record and journal writes, DDL of change sets and migrations, explicit locks, notifications, plans, and the timeouts config commits and migrations adjust. Everything else is refused, `BEGIN`, `COMMIT`, `SAVEPOINT`, `PREPARE`, `DO`, `CALL`, `RESET`, `DISCARD`, session `SET` and quoted or `U&` setting names included. An allowlist, so a form nobody thought of is refused rather than admitted.
- **Poisoning**: a nested unit that fails after one of its statements ran, or any failed statement (Postgres has then aborted the transaction), poisons the transaction. On a successful exit the layer rolls back instead of committing, logs, and dies with `TransactionRefused("poisoned")`. A `COMMIT` that Postgres answers with `ROLLBACK` is treated the same way. Nothing is inferred from statement text: every statement counts as a potential write unless the code that built it wraps it in `readOnly(...)` (`statement-marks.ts`, for the record service's own `SELECT`s). `readOnly` takes one statement value built with the `SqlClient` template (or `sql.unsafe`), never an arbitrary effect, and the transaction refuses the mark unless the statement starts with `SELECT`, `WITH`, `VALUES`, `TABLE` or `SHOW` and its structure holds no write clause (`LexedStatement.writeClause`, checked outside strings, comments, dollar quotes and quoted identifiers): (a) no unquoted `INTO` anywhere; `INTO` is fully reserved, so it appears only in `SELECT INTO`, `INSERT INTO` and `MERGE INTO`; (b) for `WITH [RECURSIVE]`, every top-level entry's body (after `AS`, an optional `[NOT] MATERIALIZED` and `(`) and the primary statement after the list (past any `SEARCH` and `CYCLE` clauses) starts with `SELECT`, `VALUES`, `TABLE`, `WITH` or `(`. Postgres accepts data-modifying statements only in those positions (a nested one fails with "WITH clause containing a data-modifying statement must be at the top level", and a parenthesized query cannot hold one), and a `WITH` the check cannot parse counts as writing. Command words are not scanned, so columns, aliases and functions named `update`, `insert`, `delete` or `merge` are reads, as are the locking clauses (`FOR UPDATE`, `FOR NO KEY UPDATE ... OF t SKIP LOCKED`, `FOR SHARE`). Beyond the structure, `readOnly` stays the caller's assertion: a read that calls a function with side effects (`nextval`, a user function that writes) must not be marked. `CurrentTransaction.markWrite` remains for explicit counting.
- **Fibers and scope**: the transaction's code runs in its own fiber, and its context provides a `Scope` of its own, closed inside that fiber when the code ends, so finalizers run where the code ran and a failing finalizer fails the code (and the transaction rolls back). Ending a fiber interrupts and awaits its children (`internal/effect.ts:600-605`, `:925-935`). Only the code's own fiber and fibers forked from it may use the transaction (a statement, a join, `afterCommit`, `markWrite`): a fiber enrolls only if its id is at least the code fiber's id (fiber ids grow monotonically, so no ancestor qualifies) and its context carries this transaction as `CurrentTransaction`. Any other fiber, an ancestor holding a leaked handle included, is refused at once with `TransactionRefused("foreignFiber")`, so the sweep below never waits on a fiber that is itself waiting for the transaction. Enrolled fibers are recorded; this covers fibers Effect does not parent, such as `forkDetach` and `forkIn` from inside the code. Limitation: a fiber created after the code started that captured the transaction's context without descending from the code (say, a sibling handed the context explicitly) passes the check; if it also awaits the transaction's own fiber, the sweep and that fiber wait on each other until one is interrupted. When the code ends the transaction is sealed: recorded fibers that are still running are interrupted and awaited before the commit decision (a detached nested unit that wrote is interrupted and poisons the transaction), and a fiber that first touches the transaction after the seal is refused with `TransactionRefused("foreignFiber")`. Every path then sets the transaction closed (statements, `afterCommit`, `markWrite` and joins die with reason `closed`), and a connection whose transaction could not be ended cleanly (a failed `COMMIT` or `ROLLBACK`, a failed check before `COMMIT`, a defect in the machinery) is discarded (`discardConnection`, the pool replaces it) instead of returned to the pool.
- **Backstop before COMMIT**: right after setup the layer stores a random token in the transaction-local setting `std.transaction_token` and records `transaction_timestamp()`. Immediately before `COMMIT`, one statement checks that the token and the transaction timestamp are unchanged and that `transaction_isolation` is `read committed`; on any mismatch it rolls back and dies with `TransactionRefused("transaction-control")`. A transaction the code started after a hidden `COMMIT` carries neither the token nor the timestamp, independent of the classifier. The token is a stronger identity than `pg_current_xact_id_if_assigned()`, which is unassigned until the first write and would need a round trip after it.
- **Post-commit actions** run after the outermost commit, after the connection is released, in order; failures are logged. `wakeWorkerAfterCommit` registers the 4.1 step 11 wake-up: `WorkerWakeup` sends `NOTIFY std_worker` on a pooled connection at most once per 250 ms per process (leading edge, then one trailing send per window).
- **Config commits** follow the Contracts 1.4 recipe: `lock_timeout = '200ms'`, `pg_advisory_xact_lock(CONFIG_KEY)`, `lock_timeout = '2s'`, `statement_timeout = '15s'`, the caller's work ending with `bumpRevision`, `COMMIT`. Only two lock timeouts are retried: the `CONFIG_KEY` wait, and a statement the caller wrapped in `lockWaiting(...)` (the DDL of the main transaction). Such a timeout (SQLSTATE 55P03, seen by the layer even if the caller maps or catches the error) rolls back and retries after 0.5, 1, 2 and 4 s with ±20% jitter; after 5 attempts `SchemaLockTimeout` names the sessions that blocked the last attempt. While an attempt runs, a fiber samples `pg_blocking_pids(<backend>)` every 50 ms on a pooled connection; if nothing was sampled, the holders of `CONFIG_KEY` are reported. Holder details come from `pg_stat_activity` and `pg_locks`, without query text.
- Any other 55P03 (`NOWAIT`, a function raising it, unmarked DDL) propagates at once as `DatabaseError`.
- **Dedicated connection**: a single-connection client like `PgClient.makeClient` (assembled by `makeSanitizedConnection`) over one `PgConnection` to `STD_DATABASE_DIRECT_URL`, with `tcp_keepalives_idle = 30`, `tcp_keepalives_interval = 10`, `tcp_keepalives_count = 3` as startup parameters and client-side TCP keepalive. It has its own `transactions` (the coordinator's main transaction runs on it) and `execute` for autocommit statements (`CREATE INDEX CONCURRENTLY` works, tested).

## Error hygiene

Every connection the layer hands out (pool, transactions, `reserve`, dedicated) is built by `sanitizing-client.ts`, so a failed statement is sanitized where it fails: the raw Postgres fields are logged once (`logSqlError`, with a random 16-hex `diagnosticId`), and the caller receives a `SqlError` of the same reason class whose message is `Database error <SQLSTATE>` and whose cause is `{ code, constraint?, diagnosticId }`. Wrapping it in another error, turning it into a defect, `Cause.pretty` or `util.inspect` of the cause therefore reveal nothing (tested with `SELECT 'private-value'::int` under `Effect.orDie` and `Effect.mapError`, inside and outside transactions). `request`, `configCommit` and `maintenance` map `SqlError` failures and defects to `DatabaseError`, which carries the same `diagnosticId`. `sanitizeCause` is the fallback for an edge that receives a raw `Cause` (the HTTP layer). Listen queues still fail with the driver's own connection error; `config-listener.ts` logs only its SQLSTATE.

## Lock keys

64-bit advisory keys, high 32 bits `0x53544400` ("STD\0"), so `pg_locks` shows them as `classid = 1398031360`:

| Key | Value | `objid` | Kind |
| --- | --- | --- | --- |
| `CONFIG_KEY` | `6004498969982402561` (`0x5354440000000001`) | 1 | transaction lock: shared in `core.begin_request()`, exclusive in config commits |
| `SCHEMA_KEY` | `6004498969982402562` (`0x5354440000000002`) | 2 | session lock, only with `pg_try_advisory_lock`: coordinator and `std upgrade` |

`@std/testing` uses two-key advisory locks `(0x53544401, hashtext(<template name>))` in the maintenance database for its templates; STD itself never takes them. Advisory locks are per database, so every `pg_locks` lookup filters on the current database (parallel test runs showed other databases' `SCHEMA_KEY` holders before that filter).

## Platform migrations

- Migrations are TypeScript modules in `platform/migrations/NNNN-name.ts`, each a list of single statements (see the driver facts below), checksummed with SHA-256 over kind and statements. `PLATFORM_MIGRATIONS` is append only; `validateMigrations` refuses gaps and a `concurrent_index` statement that does not build its named index.
- `tx`: statements and the ledger row in one maintenance transaction (`lock_timeout = '2s'`, `statement_timeout = '15s'`). `concurrent_index`: probe `pg_index` (valid: record; invalid: `DROP INDEX CONCURRENTLY` and rebuild; missing: build) with `lock_timeout = 0` and `statement_timeout = 0` on the dedicated connection, then record.
- `std upgrade` checks, in order: database encoding UTF8; no other `std-server` session on this database; `pg_try_advisory_lock(SCHEMA_KEY)`; the ledger has no unknown or changed entry. Then it applies the pending migrations.
- Migration 0001: schema `core`, `core.platform_migration`, `core.config_state` (one row, `revision bigint` starting at 0, `change_set_id uuid` set by `uuidv7()` at install), `core.begin_request()` (VOLATILE PL/pgSQL: `pg_advisory_xact_lock_shared(CONFIG_KEY)`, then a fresh read), and `core.refuse_class_change()` raising SQLSTATE `ST001`.
- Tested: startup refusal for pending, unknown and changed migrations; the three upgrade guards; SIGKILL of the upgrade process during a `tx` migration (rolled back, rerun applies once) and during a `concurrent_index` build (the build finishes without its client, the rerun records it); a build whose backend is terminated (invalid index, the rerun rebuilds it).

## Test databases

Per test file, `testDatabaseLayer()` clones `std_tpl_<24 hex of the migrations' ids and checksums>` into `std_test_<base-36 ms>_<pid>_<random>` (about 45 ms with the default `WAL_LOG` strategy; the test asserts under 1 s), provides the SQL layer with `application_name = std-test` and a statement log, and drops the database `WITH (FORCE)` on release. Each template has a two-key session advisory lock in the maintenance database (`TEMPLATE_LOCK_CLASS = 0x53544401`, `hashtext(<template name>)`): cloning holds it shared from the readiness check through `CREATE DATABASE ... TEMPLATE`; building and dropping hold it exclusive, and the janitor only try-locks, so it never drops a template that is being cloned. A template is used only once it is `IS_TEMPLATE` (a half-built one is dropped and rebuilt). The harness comments every database it creates (`std-testing test database, created <ISO time>`; templates `std test template, created <ISO time>`). The first layer of each process runs the janitor, which drops only databases with the exact generated name (`TEST_DATABASE_NAME`, `TEMPLATE_NAME`) and the matching ownership comment: test databases older than 3 hours and other templates older than 7 days. Use `layer(testDatabaseLayer(), { excludeTestServices: true })`: the SQL layer waits on real time.

## Driver facts ([spike] items)

Paths are in `@effect/sql-pg` 4.0.5 (`node_modules/@effect/sql-pg/src`) and `effect` 4.0.5 (`node_modules/effect/src`).

| Fact | Result | Evidence |
| --- | --- | --- |
| Text-format reads through the driver's `types` registry (Contracts 5.6) | **Refuted as stated; done differently.** The driver requests binary results for every column and has no text-format path. The registry holds binary codecs. STD registers codecs that render the binary value as the exact text Postgres prints. | `PgProtocol.ts:815` and `:955` (result format code 1 for every column); `PgTypes.ts:4` ("binary wire format only"), `:1710` and `:1763` (other formats refused); built-ins turn `int8` into `bigint`, `timestamp(tz)` into a millisecond `Date` (`PgTypes.ts:13`, `:1066`) and `json(b)` into parsed values (`:1144`); `PgTypes.ts:1457` and `:1462` (client registry; array codecs look elements up in it). Smoke test: every value equals `v::text`, including `1e-20`, int8 bounds, `5874897-12-31`, `0001-12-31 BC`, `294276-12-31 23:59:59.999999+00`, `infinity`, DST gaps, arrays |
| `TimeZone` and `DateStyle` through the driver's session parameters (Contracts 5.7) | **Confirmed.** `startupParameters` go into the startup packet of every physical connection, pooled or not, and survive `RESET ALL`. | `PgClient.ts:122`, `PgConnection.ts:128`, `:2313`; smoke test on 4 pooled connections, after `RESET ALL`, and on a dedicated connection |
| The Effect API for a dedicated connection (Contracts 1.4) | **Confirmed:** `PgClient.makeClient` (a `PgClient` over one `PgConnection.make`, transactions pin it), built with `Layer.build(PgClient.layerFrom(...))` because `effect/reactivity` is not on the allow list. | `PgClient.ts:196-213`, `:373-381` |
| The listen stream does not reconnect by itself (Contracts 1.3) | **Confirmed.** A lost connection fails every listen queue with the `SqlError`; `LISTEN` is issued once per subscription. | `PgConnection.ts:489-503` (`fatal`), `:1885-1930` (`listenChannel`, `LISTEN` at `:1924`), `PgClient.ts:59-68`, `:239` |
| A nested `withTransaction` issues `SAVEPOINT` (Contracts 4.1) | **Confirmed**, plus: inside an STD transaction it dies before sending anything, because its nested path needs a semaphore that only its own outer `withTransaction` provides. | `sql/SqlClient.ts:210`, `:437`, `:444`, `:487`; statement log shows `SAVEPOINT effect_sql_1` for Effect's own nesting and nothing inside STD transactions |
| `COMMIT` of an aborted transaction | Postgres answers `ROLLBACK`; the driver's own commit reports it, and STD treats it as poisoned. | `PgClient.ts:344-359` |
| Simple-query protocol | **Absent**: every statement uses Parse/Bind/Execute, so a multi-statement script cannot be sent. Migrations therefore list single statements. | `PgConnection.ts:1084` (`encodeQuery`) |
| Postgres error fields | The driver keeps them on `reason.cause` (`Object.assign(new Error(message), fields)`), so STD can read SQLSTATE and constraint and log the rest. | `PgConnection.ts:2466-2471`, `internal/sqlError.ts` |
| Untyped string parameters | Bound as text with OID 0, so `$1::numeric` casts work as Contracts 5.6 assumes. | `PgConnection.ts:898-920` |

Allow-list entry strings (Contracts 9): with the server list in `packages/server/tsconfig.json`, imports from `effect/sql`, `@effect/sql-pg` and `@effect/platform-node` type-check, and the `test/**/*.ts` override with `@effect/vitest` type-checks the tests; a temporary import of `effect/reactivity/Reactivity#layer` in `src` failed with `unstableApiUsage` (TS377136).

## Consequences and deviations

- `TransactionRefused` is one defect class with a `reason` instead of separate classes (the lint profile allows one class per file, and every case is a programming error or a poisoned transaction).
- Poisoning also covers a caught SQL error: Postgres has aborted the transaction, so a commit could only roll back.
- `std upgrade` refuses with `UpgradeRefused` (`schema-busy`, with the holder's PID) when `SCHEMA_KEY` is held; the schema engine will add its own `SchemaBusy` for change sets.
- The statement log taps the frontend protocol through the driver's `stream` option (a forwarding `Duplex`), so it only works on plaintext connections; it records each executed statement, including `BEGIN`, `COMMIT` and re-bound prepared statements.
- `@std/server` does not declare `@std/testing`: `pnpm -r run` refuses the workspace cycle (`ERR_PNPM_TASK_CYCLE`). The server's own tests import the harness by relative path (`../../testing/src/test-database.ts`).
- The lint rule `unicorn/throw-new-error` misreads `Schema.TaggedError<X>()(...)` as an Error constructor and its fixer inserts `new`, which breaks the class; each error class carries a single-line disable with that reason.

## Review round 1 (API changes)

- Removed `isWriteStatement` (text inference); added `sql/statement-marks` (`readOnly`, `lockWaiting`) and `refusalFor`.
- Lock timeouts of DDL in a config commit are retried only when the DDL is wrapped in `lockWaiting(...)`; callers that relied on retries of unmarked statements must mark them.
- A nested unit that fails after any unmarked statement poisons the transaction (before: only after a statement whose text looked like a write).
- `TransactionServices` and `MaintenanceServices` include `Scope.Scope`: the transaction's code gets its own scope, closed before the transaction ends.
- `TransactionRefused` has the new reason `closed`.
- `DatabaseError` has the optional field `diagnosticId`; driver errors seen inside STD code are sanitized `SqlError`s (same reason classes, safe message and cause).
- `sanitizeCause` and `sanitizeDefects` are new; `hygienic` also maps `SqlError` defects.
- `@std/testing`: `TEMPLATE_LOCK_KEY` is replaced by `TEMPLATE_LOCK_CLASS`; new `TEST_DATABASE_NAME`, `TEMPLATE_NAME`, `TEST_DATABASE_COMMENT_PREFIX`, `TEMPLATE_COMMENT_PREFIX`, `expiredHarnessDatabase`.
- Text reads: the `numeric` group count and scale are read unsigned, so values with more than 32,767 digit groups (up to 131,072 integer digits) decode.

## Review round 2 (API changes)

- The statement check is an allowlist (`STATEMENT_KEYWORDS`, `TRANSACTION_SETTINGS`, `READ_KEYWORDS`): `DO`, `CALL`, `TRUNCATE`, `RESET`, session `SET`, any `;` and empty statements are now refused inside STD transactions.
- `readOnly` accepts only a `Statement` (it was any `Effect`) and only on read statements.
- `TransactionRefused` has the new reason `foreignFiber`.
- `LexedStatement` adds `leadingTokens` and `separators`; `LexedToken`, `LexedTokenKind` and `MAX_LEADING_TOKENS` are new.
- `discardConnection` (sanitizing client) and `TRANSACTION_TOKEN_SETTING` are new. Every STD transaction now sends two more statements: the token mark after setup and the check before `COMMIT`.

## Review round 3 (API changes)

- Only the transaction code's fiber and its descendants may enroll: `TransactionState` gains `bodyFiberId` and `owns(fiber)`; a fiber without the transaction in its context, or created before the code's fiber (an ancestor), is now refused with `foreignFiber` instead of being enrolled.
- `LexedStatement` adds `dataModifying`; `readOnly` refuses statements for which it is set (replaced in round 4 by `writeClause`).
- The proposed mapping of 57014 on `lockWaiting` statements to a lock timeout was withdrawn: 57014 propagates as an ordinary error.

## Review round 4 (API changes)

- `LexedStatement.dataModifying` (a scan for command words) is replaced by `writeClause` (the structural `INTO` and `WITH` rules above). `readOnly` now refuses `SELECT INTO` and accepts command words used as names and every locking clause.

## Open items

- The root `vitest.config.ts` lists `bench`, which does not exist on this branch, so `pnpm test` from the root fails to start until the benchmark workstream lands; `pnpm -r test` runs both packages.
- The write classification is textual; the record service should call `markWrite` around any writing function call.
- `SchemaLockTimeout` holders come from sampling; a blocker that appears and leaves between samples can be missed (the `CONFIG_KEY` fallback covers the common case).
