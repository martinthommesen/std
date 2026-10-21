# 0015. Test isolation: concurrent runs on one Postgres server

Status: accepted, 2026-10-21 (workstream 0A, test isolation). Code: `packages/testing/src/test-database.ts` and its tests in `packages/testing/test/test-database.test.ts`.

## Problem

Several agents run `pnpm ci:local` at the same time against the shared test server (127.0.0.1:54329). Tests that passed alone failed in those runs:

- All of `transaction-guards.test.ts` failed in 0 ms to 23 ms with `DatabaseError 08006`. All four failures had the same `diagnosticId`. `schema-locks.test.ts` failed in the same run, but for a different reason (see Out of scope).
- The janitor tests in `test-database.test.ts` failed. The messages were `expected true to be false` (an expired test database was not dropped), `dropped once unused` and `kept while in use`.

## Root causes, with evidence

1. **The template locks were not shared between runs.** Advisory locks belong to the database in which they are taken. The harness took the template locks in the database named by `STD_DATABASE_URL`. Some runs used another database for this; for example, a reviewer's run used `std_review_outbox_909999f_20261021`. Those runs had their own lock space, so their janitors could take a template's exclusive lock while another run was cloning or dropping that template.

   We checked this on the server. With a lock held in `std_ws0a_maint`, `pg_try_advisory_lock` on the same keys returns `t` in `postgres` and `f` in `std_ws0a_maint`.

2. **`ALTER DATABASE` on an invalid database is FATAL.** `DROP DATABASE` marks the database invalid (`datconnlimit = -2`, an in-place update) before it removes the files. Under load, removing the files can take seconds. An interrupted drop leaves the database invalid.

   The janitor ran `ALTER DATABASE ... IS_TEMPLATE false` on such a database. Postgres answers this with `FATAL: cannot alter invalid database` and closes the connection. We confirmed this on a scratch database.

   That connection was also the one that `createTestDatabase` used to clone the next test database. The janitor logged the error as best effort and continued, then the clone failed with 08006. This is the record of the `transaction-guards` failure:

   ```
   2026-10-21 09:32:04.608 UTC [347025] FATAL:  cannot alter invalid database "std_tpl_ab36aa4ddff324ad1462ec8d"
   [11:32:04.611 CEST] WARN: Test database janitor failed ... ConnectionError: Connection closed
   [11:32:04.615 CEST] ERROR: DatabaseError 08006 (diagnosticId cc018704f2d8e8d0), in all four tests
   ```

   The same pattern was reproduced on the old code. Concurrent `@std/testing` loops ran, one of them with another `STD_DATABASE_URL`. Of 68 runs, 14 failed:
   - 12 in the template test, with `dropped once unused` or `kept while in use`
   - 2 in "clones a migrated database", with 08006 after `janitor failed ... Connection closed`
   - 1 of the 12 also in the janitor test, with `expected true to be false`

   The server logged 14 of these FATALs.

3. **One failure stopped the whole janitor.** `runJanitor` caught `SqlError` around the whole loop. An `ALTER DATABASE` on a template that another run dropped after the listing returns `ERROR: database ... does not exist`. That error, like a FATAL, ended the pass before the janitor reached the test's own expired database. This caused the janitor test failure `expected true to be false`.

4. **The template test raced with other runs' janitors.** The test planted an expired template and took its clone lock only after it had created and marked the template. In that window, other runs could drop it (`kept while in use`). Later, another run's janitor could still be dropping it when the test asserted that it was gone (`dropped once unused`). The test's finalizer also dropped the template without the lock.

**Why many files fail with 08006 at once.** The old janitor ran in every test file's build, on the connection the build then used for cloning. Vitest starts a batch of files together. All their janitors listed the same expired template, and each ran `ALTER DATABASE` on it while another run was dropping it. Every one of those connections received the FATAL, and every one of those files then failed its clone with 08006 `Connection closed`. This looks like an event across the whole cluster, but nothing terminated backends across databases.

The server log shows these clusters. For example, at 20:42:14–15 UTC five sessions in `std`, each a file of one old-code run, logged `cannot alter invalid database "std_tpl_6549ab..."`.

The expired templates came from the old harness test "the janitor never drops a template while a clone holds its shared lock". Every run planted one. During this investigation, our stress runs planted many more between 20:39 and 20:48 UTC. The server logged 48 such FATALs in old-code runs of other agents in that window, so failures of other agents' runs at that time were probably caused by those stress runs. The tests in this change no longer plant expired databases (see Decision).

The `FATAL: terminating connection due to administrator command` lines in the server log come from each run's own `DROP DATABASE ... WITH (FORCE)` and from the LISTEN tests. Those tests terminate backends with `datname = current_database()`. We matched the terminated PIDs of a run with three concurrent `@std/server` processes against sampled `pg_stat_activity` rows. Every PID belonged to that run's own test databases. No test creates, alters or drops roles.

## Decision

- **One lock space.** All admin work of the harness, including the template locks, happens in the server's `postgres` database (`MAINTENANCE_DATABASE`), whatever database `STD_DATABASE_URL` names. Cloning holds a template's lock shared from the readiness check through `CREATE DATABASE ... TEMPLATE`. Building and dropping hold it exclusive. So no run drops a template while another run selects, clones or builds it.
- **Template drops re-read under the lock.** The lock and re-read happen in `dropTemplateIfUnused` (the janitor) and `dropTemplate` (tests).
  - If the template no longer exists, the drop reports `gone`.
  - A janitor passes what it listed: the database's OID and its own clock. Between the listing and the lock, another run's janitor can drop the template and a build can create a new one with the same name. So under the lock, the janitor checks that the OID is still the listed one and that the ownership comment is still expired. Otherwise it reports `kept` and leaves the database alone.
  - Test databases need no such check. Each name records its creation time, process and 32 random bits, and is never created twice, so a dropped test database is never replaced by one with the same name.
  - If the template is invalid, it is dropped without `ALTER DATABASE`.
  - Otherwise, the template is altered and then dropped.
- **Templates that are being built or were left half-built.**
  - A build holds the template's exclusive lock from the readiness check to its last statement. That statement sets `IS_TEMPLATE true` and `ALLOW_CONNECTIONS false` together.
  - Until the build comments the template, its comment is empty, and the janitor skips it. After that, the comment says it was created now, so it does not expire for a week. The janitor's try-lock would also fail while the build runs.
  - A clone waits for the build's lock. It clones only a template that is marked `IS_TEMPLATE` and is not invalid. Otherwise it builds the template itself under the exclusive lock.
  - The build first drops a half-built or invalid leftover. Under the single lock space, no other run can be building it at that moment.
  - An interrupted `CREATE DATABASE` leaves nothing: its `pg_database` row is rolled back. Only an interrupted `DROP DATABASE` leaves an invalid database. Such a database is never `IS_TEMPLATE`, because Postgres refuses to drop a template.
- **The janitor is isolated.** It runs on its own connection, and each database's failure is logged and ignored separately. Nothing the janitor meets can break the build of a test database.
- **Templates are built from `template0`, not `template1`.** `CREATE DATABASE` fails while any session is connected to its template, and someone may be connected to `template1`.
- The harness's own tests no longer plant expired databases for every run's janitor to chase. Planted databases carry a creation comment of now. The tests run their own janitor passes at a later clock, limited to the planted names (`runJanitor`'s `only` argument). The tests also take the clone lock before they create a template, drop templates under the lock, and use random name suffixes.

Retries, longer timeouts and skips were not used.

## Transition

Until a branch merges this change, its runs still take the template locks in their own URL database (usually `std`), so they do not exclude runs that use the new code. An old-code run and a new-code run that build the same new template at the same moment are not excluded either. The old janitor can still hit an invalid template and lose its connection. While the old and new code ran side by side, the server logged such FATALs from sessions in `std`, the old harness's maintenance database. The window closes once every active branch has merged main.

## Regression tests (`test-database.test.ts`)

- "a run whose STD_DATABASE_URL names another database never drops a template this run is cloning": the other run's janitor and `dropTemplateIfUnused` run with a `ConfigProvider` that points `STD_DATABASE_URL` at another database. When the admin connection uses the URL's database (the old behavior), the janitor drops the template that is being cloned, and the test fails.
- "a template another run dropped after the janitor listed it is skipped" fails on the old drop with `database ... does not exist`.
- "an invalid template is dropped without ALTER DATABASE, which would close the connection" fails on the old drop with FATAL and a closed connection. It marks the database invalid through `pg_database`, which needs a superuser. Its comment is fresh, so no run's janitor treats it as expired.
- "the janitor never drops a template that was rebuilt after it listed it" drops and rebuilds the template between the listing and the drop, with a janitor clock at which even the rebuilt template has expired. It fails without the OID check.
- "the janitor re-checks under the lock that a template has expired" fails without the expiry check.
- "the janitor leaves a template alone while another run is building it" holds the build's exclusive lock over a created but unfinished template.
- "dropping one run's test database leaves another run's sessions alone" builds two harness instances in one process.

## Out of scope

- In the same run, `schema-locks.test.ts` failed with `expected [] to include <pid>`. That failure came from the lock-holder sampling in `config-commit.ts`, not from a lost connection, and is fixed on `ws/0a-lock-holder-sampling`.
- The codec tests of `@std/values` (`test/support/postgres.ts`) still connect directly to the URL's database. They create no tables or databases, and what they test is their own codecs against `::text` casts. `@std/conditions` now uses the harness (decision 0005).
