# STD core contracts

Status: draft, 2026-10-20. Companion to "STD platform core: plan".

## How to read this

Sections 1 to 8 match the eight points of Martin's review, in order. Section 9 covers the Effect toolchain. Sections 10 to 14 cover Martin's TM Forum, ODA and ITIL requirement (2026-10-22, decision 0021): the generic API under TMF630, the TMF Open API mappings, events, the ODA Component and the ITIL practices. Each section states decisions with a one-line reason, then lists acceptance tests. The plan says in which stage each part lands. Markers: **[checked: link]** is a fact verified in the Postgres 18 docs, the Postgres or Effect source, or another primary source; **[unverified]** is not verified; **[judgment]** is a design choice or claim that is the author's judgment; **[spike]** must be confirmed in Stage 0 before Step 1 relies on it. All paths and command names are placeholders until implemented.

## Glossary

- **Class**: a table definition. A **child class** extends a parent class. The **root** is the top class of a hierarchy. `subtree(T)` is T and all its descendants.
- **Concrete class**: the one class a record was created as. Stored as `class_id` (the class's stable ID) on every level row, shown as `class` in the API.
- **Level row**: one table's row for a record. A **logical record** is the root row plus one level row per class from the root down to its concrete class.
- **Version**: the single version of a logical record, stored on the root row.
- **Schema revision**: an instance-wide counter that increases by 1 with every config commit: a change set's main transaction, and its `complete` step if it has follow-up steps. It covers all cached configuration.
- **Change set**: one admin request or one definition-set load, applied in one main transaction. A **follow-up step** is work that must run after the main transaction (validation, concurrent index builds). The **journal** records change sets and steps.
- **Retired** and **purged**: a retired definition keeps its column and data and refuses writes; a purged definition has its column dropped and remains as a **tombstone**.
- **Protected definition**: a core definition no one may change, admins included.
- **Platform table**: a table the schema engine itself runs on, owned by platform migrations.
- **Owner layer**: `core`, `app` or `local`. A **definition set** is a versioned set of shipped config records. Each shipped record has a **base** (shipped values) and optional **overrides** (local values); the **effective record** is the result.
- **Access rule**: an allow or deny on records or fields of a class, for roles and actions, with an optional condition.
- **Permission**: a protected built-in capability outside access rules (for example `schema.purge`), granted to roles.
- **Visible schema**: the fields and tables a caller may name. A field is **never**, **always** or **conditionally** readable for a caller.
- **Existing state** and **proposed state**: a record before and after a write.
- **Change entry**: the history row for one version of one logical record. An **operation** groups change entries that committed together.
- **Outbox**: the delivery rows written in the save transaction, one per matching **subscription**.
- **External identity**: a mapping from (source system, source table, source record ID) to a logical record.
- **Condition**: an expression tree (AST) stored as JSON. A **profile** restricts what a condition may use and where it runs.
- **Canonical JSON**: the one JSON form of each field type's values.
- **TMF Open API**: a TM Forum REST API (TMF621 and so on); STD serves some as **mappings** onto its classes (11). A **CTK** is TM Forum's conformance test kit for one API version. A **hub** is a listener registration; a **listener** is the callback a client exposes for events (12).
- **ODA Component**: a deployable unit described by TM Forum's Component resource (`oda.tmforum.org/v1`); the **ODA Canvas** is the Kubernetes platform that deploys it (13).

## 1. Schema lifecycle

Covers how definitions change without breaking references, stalling the application or losing data. Field type changes on tables with data stay deferred.

### 1.1 Stable identity and names

- Every namespace, table, field, index, child-class override, choice, layout, saved filter, rule, access rule, role, permission and subscription has a stable UUID. It never changes and is never reused. Reason: renames and upgrades must not break anything that points at a definition.
- Names are separate and can change. Table names are unique per namespace. Field names are unique per hierarchy, counting active and retired fields.
- Stored configuration refers to definitions by ID only: layouts, saved filters, rules, access rules (including the roles they name), stored conditions, indexes, the dependency index (1.7), change entries. Names appear only at the edges (API paths, filter text, definition files) and are resolved when parsed.
- Physical names: tables and columns use STD names, so plain SQL stays readable, and a rename runs `ALTER TABLE ... RENAME [COLUMN]`. Index and constraint names are built from the stable ID (`std_ix_<32 hex>`, `std_nn_<32 hex>`), so renames never touch them and recovery finds them by ID. Identifiers are limited to 63 bytes [checked: [limits](https://www.postgresql.org/docs/18/limits.html)].
- Shipped definitions carry their ID in the definition file, so they have the same ID on every install. Records and API-created definitions get a UUIDv7 from `uuidv7()` [checked: [UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html)], unless the change set supplies one: a change set may give a create a client-chosen UUID, so later operations of the same batch can refer to it and scripts converge on rerun. An ID already in use, by a tombstone or by a definition the caller cannot see included, is refused, because IDs are never reused: before anything else looks at the batch, the whole change set gets one `DefinitionInvalid` with an `idInUse` problem naming the operation's index and its ID, identical whatever holds the ID (kind, owner, version, state, visible or not); no later operation runs (accepted leak in 3.6). STD relies only on uniqueness, not on monotonicity, which the docs do not promise.
- Generated SQL never uses `SELECT *`. Reason: adding a column must not change the row shape of a prepared statement.
- Admins can rename local tables and fields. Core and app definitions are renamed only by a new version of their set (8.4).
- Renames go by ID for every kind with a name: namespaces (`ALTER SCHEMA ... RENAME TO`), tables, fields, roles, permissions, subscriptions, saved filters (name unique per table [decision 0019]), access rules and indexes (the last two have an optional name, unique per table for indexes and among live access rules; the physical index name stays `std_ix_<id>`). A rename to a name another live definition of the same scope holds before the change set is refused, even if the change set renames that holder too (renames run one after another). [decision 0011]
- No aliases: after a rename, the old name is an unknown field. Reason: aliases make filter text ambiguous. [judgment]
- Moving a table between namespaces is not supported in v0.1.

### 1.2 Schema revision

- `core.config_state` holds one row: `revision bigint` and `change_set_id uuid`. Sent on the wire with the change set ID (6.2); the number is a JSON number (it cannot reach 2^53 in practice). [judgment]
- Each config commit adds exactly 1 inside its own transaction. Config commits are serialized (1.4), so revisions have no gaps and follow commit order. This is deliberately not a Postgres sequence: `nextval` is never rolled back and values are allocated at call time, independent of commit order [checked: [sequence functions](https://www.postgresql.org/docs/18/functions-sequence.html)].
- The revision covers every configuration kind the runtime caches: namespaces, tables, fields, indexes, choices, layouts, saved filters, rules, access rules, roles, role permission grants, subscriptions and overrides. Reason: a request must see one consistent combination of fields and rules. User-role assignments are data, not configuration, and do not bump it.
- A change set with follow-up steps ends with a `complete` step that takes its own revision.

### 1.3 How requests and caches see a revision

- Every record-service call, reads included, runs in one READ COMMITTED transaction whose first statement is `SELECT revision, change_set_id FROM core.begin_request()`. The SQL layer refuses isolation levels other than READ COMMITTED for request, batch and worker transactions. Reason: under REPEATABLE READ the snapshot is taken before the lock wait.
- `core.begin_request()` is a VOLATILE PL/pgSQL function. It takes `pg_advisory_xact_lock_shared(CONFIG_KEY)`, then reads `(revision, change_set_id)`. A VOLATILE function takes a fresh snapshot per query, so the read sees a config commit that finished while the lock call waited [checked: [function volatility](https://www.postgresql.org/docs/18/xfunc-volatility.html)]. Cost: from asking for a request transaction until `begin_request()` returned, p50 0.3 ms and p95 0.5 ms at 15,100 requests/s, and p50 0.4 ms, p95 0.8 ms while 9.6 config commits per second ran [checked: 0F probe 1, decision 0007].
- Every config commit takes `pg_advisory_xact_lock(CONFIG_KEY)` exclusively first. So no request overlaps a config commit, and each request runs at one revision.
- Derived artifacts (per-class Effect Schemas, generated SQL, OpenAPI, metadata) are cached under `(revision, change_set_id)`. A process whose cache differs loads the new snapshot before compiling; one load at a time per process. Including `change_set_id` catches a restored database that reaches the same number through different changes. [judgment]
- Every config commit runs `pg_notify('std_config', '<revision>')` inside its transaction, delivered only on commit [checked: [NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html)]. This is acceptable because config commits are serialized anyway (see 4.1 for why saves do not). Processes LISTEN and reload early. Correctness comes from `begin_request()`, not from NOTIFY.
- The `listen` stream does not reconnect by itself [checked: in `@effect/sql-pg` 4.0.5 a lost connection fails every listen queue (`PgConnection.ts` `fatal`) and `LISTEN` is issued once (`listenChannel`); decision 0002]. STD wraps it with retry and re-reads the revision after reconnecting; the 0A smoke test kills the listener with `pg_terminate_backend`.
- Request transactions set `statement_timeout = 30s` and `idle_in_transaction_session_timeout = 10s` [judgment on values], so an abandoned request cannot hold back a change for long.
- Long jobs run in batches, each with its own transaction and `begin_request()` (7.6).
- Every API response carries the revision it was served at (6.2).

### 1.4 Change sets, serialization and locks

- Writes to config tables (definitions, roles, access rules, layouts and other config records) through the generic record API become a one-operation change set. They are routed onto the change-set path before `begin_request()`. That transaction takes `CONFIG_KEY` exclusive as its first lock and runs the save steps (access checks, history) under it, never upgrading a lock. Reason: two requests holding `CONFIG_KEY` shared and both asking for exclusive would deadlock.
- A fixed admin endpoint accepts several operations as one change set. Each operation names the definition's `version`. It is `POST /api/v1/schema/change-sets` (201), and `GET /api/v1/schema/change-sets/{id}` returns the journal entry and steps. The session's `Actor` is the requester; its access rules must allow each operation's write on the definition table of its kind, record and written fields, unconditionally (`NotAllowed`), checked again with the session and the stated revision in the main transaction under exclusive `CONFIG_KEY`. Each definition version gets a change entry in `core.change`. Generic `POST`, `PATCH` (`name` is a rename, `state` a retire or reactivate) and `DELETE` on definition tables take the same path. [decision 0011] A generic `POST` body leaves out what defaults, as 6.7 says (an optional property such as an access rule's `name` is null); a body the kind's draft refuses is `ValidationFailed` with a `Required` or `InvalidValue` error per column it can blame (the message says what the column takes, never the refused value), otherwise `InvalidRequest` [judgment, decision 0020].
- `DELETE` on a definition record is refused with `UseRetireOrPurge`. Reason: an ordinary delete must never destroy a column.

| Lock | Kind | Holder | Purpose |
| --- | --- | --- | --- |
| `SCHEMA_KEY` | session advisory, exclusive | coordinator of a change set with DDL or a data preflight, from start through `complete`; `std upgrade` | one such change set at a time, including non-transactional steps |
| `CONFIG_KEY` | transaction advisory | requests shared (via `begin_request()`); config commits exclusive | a request never overlaps a config commit |

- `SCHEMA_KEY` is taken with `pg_try_advisory_lock`, never a blocking call under `lock_timeout`. Reason: a timed-out advisory lock request was reported to fail although the lock was granted ([pgsql-bugs #17686](https://www.postgresql.org/message-id/17686-fb1fa3870138e394%40postgresql.org)) [checked the report, not whether it is fixed]. For `CONFIG_KEY` that race does no harm: the timeout aborts the transaction, which releases a transaction-level lock.
- If another change set holds it, the caller gets `SchemaBusy` (503 with `Retry-After`) naming that change set. No queue in v0.1.
- The coordinator holds `SCHEMA_KEY` on one dedicated connection outside the pool, connected directly to Postgres, and runs every statement of the change set on it. [checked: `PgClient.makeClient` in `@effect/sql-pg` 4.0.5 is a client over one `PgConnection`, outside any pool; decision 0002]
- Changes without DDL or data preflight (labels, layouts, rules, access rules) take only `CONFIG_KEY`.
- Lock order is always `SCHEMA_KEY`, `CONFIG_KEY`, table locks. Requests take `CONFIG_KEY` before any table lock. So STD sessions cannot deadlock on these.
- Nothing that scans record tables runs while `CONFIG_KEY` is held exclusively. Data counts and preflights run under `SCHEMA_KEY`, before `CONFIG_KEY`, and name tables and columns as they are before the change set's DDL.

Main transaction of a change set:

1. `BEGIN`; `SET LOCAL lock_timeout = '200ms'` [judgment]; `pg_advisory_xact_lock(CONFIG_KEY)`, which also drains STD requests.
2. `SET LOCAL lock_timeout = '2s'`; `SET LOCAL statement_timeout = '15s'` [judgment on values]. The 2 s is a lock budget for the whole attempt, not a limit per lock: Postgres applies `lock_timeout` to each lock acquisition separately, also within one statement, so a statement or a sequence of statements that needs k locks could otherwise wait nearly k × 2 s while every request waits behind `CONFIG_KEY` [checked: [client defaults](https://www.postgresql.org/docs/18/runtime-config-client.html); 0F probe 3b: one `CREATE TABLE` with two foreign keys, each referenced table held by a writer for 1.2 s, committed in a single attempt that held `CONFIG_KEY` 2.44 s under `lock_timeout = '2s'`; probe 3: two `ALTER TABLE`s likewise, 2.44 s]. The budget is enforced like this [judgment]:
   - Before each DDL statement, the transaction takes every table lock the statement needs explicitly and one at a time, `LOCK TABLE <t> IN <mode> MODE`, root first (the writers' lock order, 2.2 item 3), each after `SET LOCAL lock_timeout = '<remaining budget>ms'`. The locks are the "Explicit locks taken first" column of the DDL table below. The explicit locks are marked `lockWaiting`, so a 55P03 from a `LOCK TABLE` rolls the attempt back and retries it.
   - Then `SET LOCAL lock_timeout = '<remaining budget>ms'` once more, and the DDL statement runs, also marked `lockWaiting`. There is no statement-level backstop: DDL is catalog work and can legitimately take long (review of 0F measured a `CREATE TABLE` with 1,200 reference columns at 986 ms with its locks held), and a `statement_timeout` would cancel it and misreport it as lock contention.
   - What the budget covers: every inventoried table lock. Application traffic, STD's own sessions and STD's follow-up steps lock a table before its indexes and take only non-conflicting locks (ACCESS SHARE) on system catalogs, so contention from all of them is fully covered by the explicit locks [checked: 0F probe 3c: for every form in the table, with the listed locks taken first, the DDL holds no relation lock beyond them, its own new relations, indexes of the locked tables and system catalogs; with the target's lock left out of "purge reference field", the guard reports `ACCESS EXCLUSIVE` on the target]. A new DDL form needs its row here and in the guard's inventory.
   - What it does not cover: the DDL also locks indexes of the locked tables and system catalogs internally, and Postgres cannot `LOCK TABLE` an index, nor is budgeting catalog locks practical. Only sessions that lock an index or a catalog directly contend these: `ALTER INDEX`, `REINDEX`, amcheck, an explicit `LOCK` on a catalog, `VACUUM FULL` or `CLUSTER` of a catalog. The remaining budget is recomputed before each explicit `LOCK TABLE` and once more before each DDL statement, and the value set before a statement is reused for every internal acquisition within it, so each internal wait is capped at the remainder computed when its statement started. The lock-wait time of one attempt is therefore at most the budget × (1 + N), where N counts the contended internal acquisition attempts, reacquisitions included (not distinct relations or blocker sessions); the attempt's ordinary transaction work comes on top [checked: 0F probe 3d: with two open `ALTER INDEX ... RENAME`s on the indexes of a purged reference column, and with SHARE locks on `pg_class` and `pg_type` while a table is created, the DDL waited on each (requesting ACCESS EXCLUSIVE on the indexes, ROW EXCLUSIVE on the catalogs); released after 1.2 s each, one attempt held `CONFIG_KEY` about 2.4 s, within 3 × 2 s; held on, the first wait timed out at the remaining budget (about 2.0 s) and the retry committed. After an explicit `LOCK TABLE` had waited 1.2 s for a reader, an internal index wait timed out after 780 ms, the remainder, and the attempt rolled back at 2,001 ms, near the original 2 s deadline rather than 3.2 s]. Some catalog locks are released before the transaction ends, so sampling `pg_locks` after a statement cannot show every lock it took.
   - Runbook rule: do not run index or catalog maintenance (`REINDEX`, `ALTER INDEX`, amcheck, `VACUUM FULL` or `CLUSTER` of a catalog) while schema changes are applied.
   - STD-generated tables have no owned sequences (IDs come from `uuidv7()`), so DDL never locks a sequence; the guard reports any sequence lock as a violation.
   - [checked: 0F probe 3b with explicit locks: writers on both referenced tables of one `CREATE TABLE` made the first attempt stop at the budget (it held `CONFIG_KEY` 2,001 ms) and the retry committed; an STD request issued during the wait took 1,992 ms. Probe 3: the same with two `ALTER TABLE`s.]
3. Load definitions, validate, run dependency checks (1.7), in memory.
4. Run the DDL, only in the forms below.
5. Write definition rows, definition revisions (4.4), the dependency index, the journal and the audit entry.
6. Bump `core.config_state`.
7. `pg_notify`, `COMMIT`.

- Locks are held until the end of the transaction [checked: [explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html)], and without `lock_timeout` a request waits indefinitely [checked: [client defaults](https://www.postgresql.org/docs/18/runtime-config-client.html)].
- Postgres queues a new lock request behind any waiting request it conflicts with [checked: `waitMask` test in src/backend/storage/lmgr/lock.c, REL_18_STABLE]. So while a config commit waits for `CONFIG_KEY`, new STD requests wait too, and while its DDL waits for a table lock, later requests on that table wait, plain reads included. Per attempt, the request pause is at most the `CONFIG_KEY` wait (200 ms) plus the DDL lock budget (2 s, enforced as in step 2) plus the main transaction's own work, as long as no session locks an index or a catalog directly; such sessions add up to the remaining budget per contended internal lock (step 2). Between attempts requests run normally. [checked: 0F probe 1 with 8 clients: a small DDL change set holds `CONFIG_KEY` p50 2.9 ms, p95 5.1 ms; a commit blocked by a 30 s request stalled requests 200 ms per attempt (max 205 ms) and gave up after 5 attempts and 8.0 s with `SchemaLockTimeout`, the 30 s request undisturbed; DDL waiting for a table lock held by a plain session stalled requests 2,004 ms, then the retry committed; probe 3: a plain `SELECT` was observed queued behind a waiting `ALTER TABLE` (`pg_blocking_pids`) for 1,989 ms and completed once the attempt rolled back; decision 0007]
- On lock timeout of the `CONFIG_KEY` wait or of a DDL statement the schema engine marks as lock-waiting, the transaction rolls back and retries after 0.5, 1, 2 and 4 s with jitter, 5 attempts in total [judgment]. Any other lock timeout (`NOWAIT`, a function raising 55P03) fails the change set at once. Then `SchemaLockTimeout`, naming the sessions holding conflicting locks (from `pg_locks` and `pg_stat_activity`). Nothing applied, revision unchanged.

DDL forms STD generates [checked: [ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html), [CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html)]. ALTER TABLE takes `ACCESS EXCLUSIVE` unless the page notes a lower lock, and that is the only mode that blocks plain `SELECT`.

| Operation | Postgres form | Lock | Explicit locks taken first (1.4 step 2) | Rewrite or scan | Runs in |
| --- | --- | --- | --- | --- | --- |
| Create root table | `CREATE TABLE` with its unique and check constraints | new table invisible until commit | none | none | main |
| Create child table with level FK | `CREATE TABLE ... FOREIGN KEY (id, class_id) REFERENCES <parent>` | new table invisible until commit; SHARE ROW EXCLUSIVE on the parent [checked: 0F probe 3] | parent SHARE ROW EXCLUSIVE | none: the FK of a new table is not validated by a scan [checked: 0F probe 3] | main |
| Class-change trigger | `CREATE TRIGGER ... BEFORE UPDATE` | SHARE ROW EXCLUSIVE on the table (none extra on a table created in the same transaction) | the table SHARE ROW EXCLUSIVE, unless created in this transaction | none | main |
| Widen an ancestor's subtree check (2.4) | `DROP CONSTRAINT <check>, ADD CONSTRAINT <check> CHECK (...) NOT VALID` | ACCESS EXCLUSIVE | the ancestor ACCESS EXCLUSIVE, root first | none [checked: 0F probe 3] | main |
| Add field | `ADD COLUMN`, no default or a constant default | ACCESS EXCLUSIVE | the table ACCESS EXCLUSIVE | none: a non-volatile default is stored in the catalog [checked: 0F probe 5, also with `NOT NULL`] | main |
| Add reference field | `ADD COLUMN` without `REFERENCES`, then `ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID` | ACCESS EXCLUSIVE on the table for the column; SHARE ROW EXCLUSIVE on both tables for the FK, which blocks writes to the target briefly | column: the table ACCESS EXCLUSIVE; FK: the table, then the target, SHARE ROW EXCLUSIVE | none; `VALIDATE` scans | main, then validate as follow-up |
| Drop a reference FK | `DROP CONSTRAINT <fk>` | ACCESS EXCLUSIVE on the table and on the target (its FK triggers are dropped) [checked: 0F probe 3c] | the table, then the target, ACCESS EXCLUSIVE | none | main |
| Rename | `RENAME`, `RENAME COLUMN` (cannot combine with other subcommands) | ACCESS EXCLUSIVE | the table ACCESS EXCLUSIVE (also when FKs reference it) | none | main |
| Rename namespace | `ALTER SCHEMA ... RENAME TO` | the schema object only; no table lock | none | none | main |
| Set or drop default | `ALTER COLUMN SET/DROP DEFAULT` | ACCESS EXCLUSIVE | the table ACCESS EXCLUSIVE | none | main |
| Retire a required field | `ALTER COLUMN DROP NOT NULL` | ACCESS EXCLUSIVE | the table ACCESS EXCLUSIVE | none | main |
| Purge field | `DROP COLUMN` | ACCESS EXCLUSIVE; its indexes and constraints are dropped under it | the table ACCESS EXCLUSIVE | none; column becomes invisible | main |
| Purge reference field | `DROP COLUMN` of a column with an FK | ACCESS EXCLUSIVE on the table and on the target (the FK's triggers on the target are dropped) [checked: 0F probe 3c] | the table, then the target, ACCESS EXCLUSIVE | none | main |
| Purge table | `DROP TABLE` (no `CASCADE`) | ACCESS EXCLUSIVE on the table, its parent (level FK) and every table its FKs reference, `core.user` for a root's audit FKs (their triggers are dropped) [checked: `lock-inventory.test.ts`] | every ancestor root first, the table, then each referenced table, ACCESS EXCLUSIVE | none | main |
| Make required on a table with rows | `ADD CONSTRAINT std_nn_<id> NOT NULL col NOT VALID`, then `VALIDATE CONSTRAINT` (new in 18) | add: ACCESS EXCLUSIVE; validate: SHARE UPDATE EXCLUSIVE | add: the table ACCESS EXCLUSIVE; validate: n/a (follow-up) | validate scans without blocking reads or writes | add in main, validate as follow-up |
| Check constraint (max length) | `ADD CONSTRAINT ... CHECK (...) NOT VALID`, then `VALIDATE`; `DROP CONSTRAINT` to remove it | as above; drop: ACCESS EXCLUSIVE | add and drop: the table ACCESS EXCLUSIVE | as above | as above |
| Index or unique index on a table with rows | `CREATE [UNIQUE] INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | n/a: follow-up, no `CONFIG_KEY`, `lock_timeout = 0` with the watchdog (1.5) | two scans | follow-up, outside any transaction |
| Drop index | `DROP INDEX CONCURRENTLY` | does not block reads or writes [checked: [DROP INDEX](https://www.postgresql.org/docs/18/sql-dropindex.html)] | n/a: follow-up (1.5) | none | follow-up, outside any transaction |

- STD adds a reference's FK constraint separately as `NOT VALID`, so no validation scan runs under ACCESS EXCLUSIVE.
- Refused in v0.1, because each rewrites or scans under ACCESS EXCLUSIVE [checked]: `ADD COLUMN` with a volatile default, identity, stored generated column or constrained domain; `ALTER COLUMN TYPE`; `SET NOT NULL` without a validated constraint that proves it.
- Adding a required field to a table with rows needs a constant default; without one it is refused with `ExistingDataViolates` before any SQL runs.
- Statement order in the main transaction: purged columns and tables are dropped first (children before parents), then schemas, tables and columns are renamed, then the rest; so a name a purge frees can be taken in the same change set. Every explicit lock names a table as it is before any DDL. [decision 0011]
- Postgres column defaults are constants only. The record service computes dynamic defaults (current user, time, numbers) on insert.
- Max length is `text` plus a CHECK constraint, never `varchar(n)`, so changing it never rewrites. [judgment]
- UNIQUE constraints have no NOT VALID form; uniqueness is a unique index built concurrently.
- A CI test checks every DDL statement in the SQL snapshots against this table.

Tightening on a table with rows (required, unique, max length, and child-class overrides, 2.5):

- After `SCHEMA_KEY` and before `CONFIG_KEY`, a preflight counts violating rows. If any, `ExistingDataViolates` with the count and up to 20 sample IDs.
- From the main commit, the record service enforces required, max length and overrides on writes itself, and Postgres checks new rows against a NOT VALID constraint [checked].
- Rows written between preflight and main commit make `VALIDATE` or the index build fail, and the journal reports it. Overrides have no database constraint, so a follow-up `validate_override` step rechecks the subtree and sets enforcement to `enforced` or `failed`; rows that violate it are reported in the change set's report and by `doctor` [judgment].
- Each constraint, index and override has `enforcement: pending | enforced | failed`. Uniqueness is promised only once its index is `enforced`.

### 1.5 Journal and follow-up steps

- `core.schema_change`: ID, requester, operations, state (`applying | completed | needs_attention | abandoned`), first and last revision, error, timestamps.
- `core.schema_change_step`: change ID, ordinal, kind, target ID, generated SQL, state (`pending | running | done | failed`), attempts, last error, backend PID, timestamps.
- Journal operations record target ID, kind, old name and new name, so stale-request checks can match names (6.4).
- The main transaction writes the change set and all its steps; a rollback leaves nothing to recover.
- Step kinds: `validate_constraint`, `validate_override`, `create_index_concurrently`, `drop_index_concurrently`, `complete`; Step 2 adds `backfill` (batched, resumes from a stored keyset cursor): adding an auto-numbered field (6.5) to an existing table plans one, which numbers the rows in `id` order in short transactions, stores its cursor in the step after each batch, and neither bumps versions nor writes change entries (the number counts as if it had always been there) [judgment, decision 0017].
- The coordinator runs steps in order on its `SCHEMA_KEY` connection, marking `running` and `done` in autocommit.
- Concurrent index statements cannot run in a transaction block, and a concurrent build waits for transactions that modified the table and for older snapshots [checked: [CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html)]. The coordinator keeps no transaction open while such a step runs. These steps use `lock_timeout = 0` plus a watchdog.
- Watchdog: after 10 minutes in a waiting phase [judgment], it reports the PIDs the build is waiting for (from `pg_stat_progress_create_index.phase`, `pg_locks` and `pg_stat_activity`) in the step's `last_error`, in `std schema status` and as a metric. It never cancels on its own; cancelling is an operator decision through `std schema abandon`.
- `complete` is a short transaction under `CONFIG_KEY`: sets enforcement states, bumps the revision, marks the change set `completed`.
- Each step defines a **probe** (reads the catalog: `done`, `not_started` or `partial`), the **action**, and an **abandon action** (drop the index or NOT VALID constraint, set enforcement `failed`).

Coordinator connection:

- It sets `tcp_keepalives_idle = 30`, `tcp_keepalives_interval = 10` and `tcp_keepalives_count = 3` as startup parameters, so `RESET ALL` keeps them [judgment on values]. Reason: after a network partition or a host crash with no TCP reset, an idle backend otherwise keeps `SCHEMA_KEY` until the OS keepalive fires, often after 2 hours.
- STD assumes `client_connection_check_interval = 0` (the default), so a running build is not cancelled when its client disappears. `doctor` reports a different setting. [checked: 0F probe 2: with 250 ms the backend of a build whose client process was killed exits 241 to 295 ms after the kill, in a lock wait or mid-scan, leaving an invalid index and releasing `SCHEMA_KEY`; resume would rebuild it]
- `std schema status` shows the lock holder's PID and client address.

Resume:

- Each server process and `std upgrade` tries `pg_try_advisory_lock(SCHEMA_KEY)` at startup and every 30 s [judgment], on a dedicated connection. Getting it proves no coordinator is alive, because a session lock is released when its backend ends. If nothing is open, it releases the lock at once.
- The holder resumes change sets in `applying`, probing each unfinished step: `done` is recorded; `partial` is cleaned up and rerun (an invalid index is dropped first, as the docs recommend); `not_started` runs.
- A build runs on the backend holding `SCHEMA_KEY`, so if the coordinator process dies mid-build, the lock stays held until the build ends and no resume can race it. [checked: 0F probe 2, SIGKILL of the client process with interval 0: the backend kept `SCHEMA_KEY` (another session's `pg_try_advisory_lock` failed) through a 3 s wait and a 2.0 s scan of 10M rows, then left a valid index, or an invalid one (`indisvalid = false`) when a duplicate broke a unique build, and released the lock within 35 ms of the build's end]
- A step that errors is retried 3 times [judgment], then the change set moves to `needs_attention` and `doctor` reports it. An admin fixes the cause and runs `std schema resume <id>`, or runs `std schema abandon <id>` (abandon actions plus `complete`).
- A failed concurrent unique build leaves an invalid index that still enforces uniqueness [checked], so abandon drops it at once.
- A new coordinator, once it holds `SCHEMA_KEY`, first resumes change sets left in `applying`, then refuses with `SchemaNeedsAttention` (409) while any change set is `needs_attention`: stored step statements name tables and columns as they were, and the new change set could rename or drop them. Changes without DDL still apply. [judgment, decision 0011]
- Abandon applies only to a change set still `applying` or `needs_attention`. It drops unfinished index builds and finishes unfinished index drops concurrently before its `complete`, and drops `NOT VALID` constraints inside the `complete` config commit under the lock budget; afterwards the catalog matches the definitions or the enforcement state explains it. If the backend that is running one of this change set's steps right now holds `SCHEMA_KEY` (a build waiting on another session, or one whose client died), `std schema abandon` terminates it first, checking in the signalling statement the step's state, PID, backend start and the lock; that is the operator's decision. Any other holder gives `SchemaBusy`. [decision 0011]
- The watchdog runs on a pooled connection beside the step and writes the PIDs the step waits for (`pg_blocking_pids`) and the build phase into `last_error`; `std schema status` shows them live too. [checked: `schema-recovery.test.ts`]

### 1.6 Field and table lifecycle

| State | Column or table | Reads | Writes | Forms and default selection | Next |
| --- | --- | --- | --- | --- | --- |
| `active` | exists | yes | yes | shown | `retired` |
| `retired` | kept with data | only when selected explicitly, under access rules | refused (`DefinitionRetired`) | hidden | `active`, `purged` |
| `purged` | dropped | no | no | no | none (tombstone) |

- Retiring keeps the data and drops `NOT NULL` (catalog-only), so inserts without the field work. A retired field cannot be made required, directly or by an override. A reactivated field comes back optional on every class: retiring sets the field's `required` to false and clears `required` on its overrides in descendant classes. Booleans stay `NOT NULL DEFAULT false`. [checked: `schema-lifecycle.test.ts`, `lifecycle.test.ts`]
- Retiring a parent field retires it on every child class. A retired table accepts reads only: creates, updates and deletes of its records (and of records of its descendants) are refused with `NotAllowed`.
- Purge needs the `schema.purge` permission (3.1; held by the built-in `schema_purger` role, not by `admin`), a target retired in an earlier committed revision, no blocking dependents (1.7), and a confirmation naming the target's ID and version. It is journaled and audited with the number of values or rows destroyed. The count runs under `SCHEMA_KEY` before `CONFIG_KEY`; a retired field or table refuses writes, so the count is stable.
- A tombstone keeps ID, last name, type, label and purge revision, so history can interpret old values. The name becomes free; the ID is never reused. The tombstone is the definition row in state `purged`; its purge revision is its first definition revision in that state (4.4). [decision 0011]
- A field purge takes its single-field indexes and its overrides along; a table purge takes its fields, indexes and overrides along. Records of a child class also have rows in its ancestors' tables, which dropping the child's table cannot remove: purging a class whose subtree has records while its root table stays is refused (`PurgeRefused`, counted under `SCHEMA_KEY`); a populated hierarchy is purged from its leaves to its root in one change set. [judgment, decision 0011]
- A purge does not free a column slot: dropped columns count toward the 1,600-column limit [checked: [limits](https://www.postgresql.org/docs/18/limits.html)].
- A purge leaves history values in place; erasure is deliberately later.

### 1.7 Dependency checks

- `core.config_dependency (from_id, to_id, kind)` records every reference between config records, maintained in the same transaction as each config write. Kinds: `extends`, `field_of`, `references_table`, `condition_on` (a condition field to the class its conditions apply to), `index_on`, `display_field`, `layout_uses`, `condition_reads` (a stored access-rule, subscription or allowed-records condition to each field it reads, 6.5), `rule_writes`, `access_rule_on`, `rule_role` (access rule to role), `choice_of`, `overrides`, `subscription_on` (subscription to its class), `grant_of` (grant to its role and permission), each registered when its feature lands.
- Step 2 registers `choice_of` (a choice to its field) and `layout_uses` (a layout to its table and to each field it names). Layout and choice rules, beyond the table below [judgment, decision 0017]: retiring a field a layout names is allowed and reports the layout; a layout never blocks a field purge, and keeps the purged field's ID, which metadata skips; a table purge takes its layouts along, and a field purge its choices, as they take overrides along; deleting a choice that an override's subset names is refused as `DefinitionInvalid` (the subset would name no choice); a layout naming a field outside its table's lineage, a field twice, a section in a list layout, or a second layout of one type is `DefinitionInvalid`.
- Workstream 2D registers `saved_filter_on` (a saved filter to its table; the fields its condition reads, on every hop, are `condition_reads`). Saved filter rules [judgment, decision 0019]: retiring a field a saved filter reads is allowed and reports the filter, which metadata then no longer serves; a live saved filter blocks the purge of a field it reads, like any stored condition (a condition naming a tombstone cannot run); a table purge takes its saved filters along, like its layouts.
- Dependency checks read only config tables and run in the main transaction under `CONFIG_KEY`, so no concurrent write can add a dependent. Data counts run before it (1.4).

| Operation | Refused when | Reported but allowed |
| --- | --- | --- |
| Rename | target is protected, or owned by core or an app and the caller is not its set | nothing |
| Retire field | protected; display field of a live table, unless the same change set retires that table; an active rule writes it; part of a multi-field unique index | layouts, conditions, access rules that read it |
| Retire table | protected; has a child class not retired; a non-retired reference field points at it, or a non-retired condition field names it (whatever its own table's state, self-references included) | other dependents |
| Reactivate field or table | a reference or condition field that would be active names a retired table | nothing |
| Purge field | not retired; any non-retired dependent except layout entries and single-field indexes | count of non-null values (counted under `SCHEMA_KEY`) |
| Purge table | not retired; a child class, incoming reference or condition field naming it not purged; an access rule or subscription on it | row count (counted under `SCHEMA_KEY`) |
| Delete or retire role | protected; an active access rule names it (`rule_role`); for a delete, any access rule | user-role assignments; a deleted role's grants are deleted with it |
| Tighten required, unique, max length, override | existing rows violate it (preflight, 1.4) |  |
| Change type | always, in v0.1 |  |

- Refusal: `DependencyConflict` (409), listing each blocking dependent by ID, kind and name.
- A multi-field unique index refuses the retire of its fields, so a purge meets only non-unique multi-field indexes; it refuses those too. `DELETE` of an override is refused (it would loosen the field, 2.5). [decision 0011]
- Other refusals of lifecycle operations: `UseRetireOrPurge` (409, `DELETE` of a field, table or namespace definition), `PurgeRefused` (409: not retired, retired in the same change set, a confirmation that does not name the target's ID and version, or records left in ancestor tables), `PermissionRequired` (403, `schema.purge`) and `DefinitionProtected` (403, 1.8). Each is raised before any lock or SQL, except the record check of a purge, which runs under `SCHEMA_KEY` before `CONFIG_KEY`. The requester (user ID and current role IDs) is passed with the change set; permissions are checked by ID through active grants of its active roles.

### 1.8 Protected core definitions and local additions

- Core definitions carry `protected = true`, settable only by core definition files. They accept no local change except label and help-text overrides (8.2), for every caller.
- The check lives in the schema service, not in access rules, so a misconfigured rule cannot weaken it. Built-in access rules add a second layer.
- Admins may add `local` fields to app tables and to core tables marked `extensible` (the user table now), and may create `local` child classes of app classes and of `extensible` core classes. Platform tables (1.9) are never extensible.
- An upgrade whose set adds a name already used by a local field or class is refused at plan time. The report names the local definition; the admin renames it (1.1) and reruns.
- The `core` namespace and installed apps' namespaces are reserved.
- Enforced for every operation by the schema service's guard [decision 0011]: a protected definition accepts only `label` and `helpText` changes unless the change set is the core set itself; rename, retire, reactivate and delete of a core- or app-owned definition are for its own set only (a retired app definition may still be purged locally, 8.4); platform tables, their fields and their namespace are never renamed, retired, purged or deleted, and only the core set creates a table or namespace with platform storage (nothing else would create its table or schema); new definitions belong to the change set's owner layer, a new table must be in a namespace that layer owns, and fields, indexes, overrides and child classes go only onto classes the layer owns, app classes or `extensible` core classes, never onto a platform table. One check covers every operation that adds a definition. Refusal: `DefinitionProtected` (403) with the reason (`protected`, `owner`, `reserved`, `notExtensible`, `platform`). A label or help-text change by an origin that does not own the definition is marked as a local override in the journal; workstream 1B stores it in `core.config_override`.

### 1.9 Minimal migration mechanism

- **Platform tables** (`core.config_state`, definition tables, `core.definition_revision`, journal, config layer tables, migration ledger, outbox, import bookkeeping) are owned by platform migrations. Core definition files describe them so they appear in the API; the loader verifies them and never changes them. Reason: a change set cannot create the tables it writes into.
- Platform tables laid out like root classes keep `created_by` and `updated_by` without a foreign key: `core.user` is created later, by the core set. Set loads write the system user's ID (a fixed ID, inserted into `core.user` by the change set that creates it); `doctor` checks that every audit ID on a platform table exists in `core.user`. Tables without `id` (`core.config_state`, `core.config_dependency`, `core.definition_revision`, the ledger) are internal and not described as classes. [judgment, decision 0006]
- **Core definition tables** (for example `core.user`) are ordinary STD tables loaded through change sets.
- Migrations are numbered, forward-only files (TypeScript modules that list their statements one by one, because the driver has no simple-query protocol to run a multi-statement script), recorded in `core.platform_migration (id, checksum, std_version, applied_at)`. No down migrations; rollback is restoring the backup taken before the upgrade. Reason: down migrations are rarely tested and lose data.
- Kind `tx` (default) runs in one transaction with its ledger row. Kind `concurrent_index` is one `CREATE INDEX CONCURRENTLY` with a fixed name: the runner probes `pg_index` (valid: record; invalid: drop and rebuild; missing: build).
- Kind `data` (from Step 3, decision 0021, resolved question 24): a batched change of records through the save pipeline, acting as the system user (3.1), so change entries and deliveries are written. It needs tables and classes that set loads create, so `std upgrade` runs `data` migrations after the core and app sets load (8.5). Its ledger row is inserted with `state` `running` when it starts; each batch commits its records together with the row's `progress` (a keyset cursor), so a killed run resumes from the last committed batch; the last batch sets `state` `applied`. It selects only records that still need the change, so a rerun changes nothing [judgment]. `tx` and `concurrent_index` rows are written `applied`. First use: an individual for every user that has none (11.3).
- Migrations follow the DDL table and timeouts in 1.4.
- The server refuses to start if a migration is pending, if a `data` migration's row is still `running` (an interrupted batch run), if the ledger holds one the code does not know, or if an applied checksum differs.
- Migrations run only through `std upgrade` (8.5), never at server start. Docker compose runs `std upgrade` as a one-shot service the server waits for.

### 1.10 `doctor`

`std doctor [--json]` only reads: one REPEATABLE READ READ ONLY transaction without advisory locks, so it never waits for a config commit or a running schema change (decision 0002). Exit 0 clean, 1 on any error, 2 for warnings only. Informational findings do not affect the exit code. "Clean" means exit 0. Repairs are separate commands with normal authorization and journaling. [judgment]

Checks:

1. Migration ledger matches the code, and every row is `applied`; a `data` migration left `running` is an error (`dataMigrationIncomplete`) naming it and its progress.
2. Every active and retired table and field matches the catalog (type, nullability, default, keys, level FK); every audit ID on a platform table exists in `core.user` (1.9).
3. Every index and constraint exists under its ID-based name and is valid (`indisvalid`, `convalidated`), or its enforcement state explains why not. A widened subtree check recorded as `enforced` without VALIDATE (2.4) is accepted.
4. Purged definitions are absent from the catalog.
5. Orphan tables, columns, indexes or constraints in STD namespaces (reported, never dropped).
6. Interrupted or `needs_attention` change sets; steps left `running`.
7. `config_state.revision` equals the journal's highest revision.
8. Effective records equal base plus overrides; no override on a non-overridable property; open conflicts listed; records violating an override (2.5).
9. The dependency index equals a full recomputation; no unknown IDs.
10. Protected definitions match the installed core set by hash.
11. Column headroom per table, counting dropped columns; warning at 1,400 [judgment].
12. Inheritance invariants (2.2): each non-root record has its lowest level row; `class_id` is NOT NULL in every table; FK delete and update actions match 3.10.
13. Mappings in `core.external_identity` that point at missing records (informational: this is the expected `TargetDeleted` state, 7.1). Until imports add the table (Step 4) the check reports "not applicable" as informational.
14. The fold table's Unicode version equals the server's `unicode_version()` [checked: [system information functions](https://www.postgresql.org/docs/18/functions-info.html)] (5.5).
15. The database encoding is UTF8 (5.5), and `client_connection_check_interval` is 0 (1.5).
16. Each definition's latest `core.definition_revision` row equals its effective record (4.4). A row written before a release added a property is read with that property's documented default (absent `numberPrefix` and `choices` are null), so old rows are not drift and real differences still are [decision 0017].

### Acceptance tests

- Rename of a local field used by an index and an access rule: the rule still works, the index name is unchanged, the old name gets `UnknownField`, older history reads under the new name.
- Installing the core set on two empty databases gives every core definition, roles and permissions included, the same ID.
- 200 change sets from 8 concurrent clients produce consecutive revisions in journal commit order.
- Under mixed load on `acme.asset` and `acme.laptop` while 50 change sets commit, every response matches the definitions at the revision in its header, and no response is a 500.
- With two processes, a change committed through A is used by B's next request, including after B's listener is killed with `pg_terminate_backend`.
- A process that cached revision N reloads after a restore to N-5 followed by 5 new change sets.
- Two concurrent access-rule edits through the generic API both succeed, at consecutive revisions, with no deadlock.
- `DELETE` of a field definition is refused; column and data unchanged.
- A retired required field is hidden by default, returned when selected, refuses writes, keeps values, and inserts without it succeed; reactivated it is optional with values intact.
- Purge is refused when active, retired in the same change set, without `schema.purge`, with a non-retired access rule reading it, or in a multi-field unique index; once causes are removed it succeeds and older history shows the tombstone label. (A multi-field unique index already refuses the retire; the purge test uses a non-unique multi-field index.)
- Deleting or retiring a role that an active access rule names is refused with `DependencyConflict`.
- Every operation other than a label or help-text override on every protected definition, as admin, through both the generic API and the change-set endpoint, is refused and leaves `pg_catalog` unchanged; a label override on a protected definition succeeds and changes no catalog object.
- Adding a field with a constant default to a 1,000,000-row table leaves `relfilenode` unchanged, finishes under 100 ms [judgment] and does not increase `pg_stat_user_tables.seq_scan`. Adding a required field without a default to a table with rows is refused with `ExistingDataViolates` before any SQL runs.
- Every DDL statement in the SQL snapshots matches the 1.4 table; volatile defaults, type changes and direct `SET NOT NULL` are refused before any SQL runs.
- While psql holds an open transaction on `acme.asset`, adding a field fails after 5 attempts with `SchemaLockTimeout` naming its PID; nothing applied; per attempt no STD request waits longer than the `CONFIG_KEY` wait plus the DDL lock wait plus the main transaction's time.
- Request latency is measured during a config commit while a 30 s request and an import batch are in flight; the result is committed with the 0F probes [done: `packages/probes/results/2026-10-21.md`, decision 0007; the CI test `probe-config-pause` keeps the 30 s case].
- Tightening an override on a 1,000,000-row subtree: the request pause is measured and does not include the preflight scan; rows written during the window are reported and the `validate_override` step ends `enforced` or `failed`.
- A second DDL change set during the first one's follow-up phase gets `SchemaBusy`, while a label change at the same moment succeeds.
- Making a field required on a table with nulls is refused with count and samples; after a backfill it succeeds with a validated constraint.
- For "make serial unique" on 1,000,000 rows, SIGKILL of the coordinator at each step boundary and during the build always ends completed with one valid index and `doctor` exiting 0.
- A duplicate inserted during a unique build leaves `needs_attention`; `std schema abandon` drops the invalid index, sets enforcement `failed`, bumps the revision, and `doctor` exits 0.
- An index build blocked by an idle-in-transaction session is reported by the watchdog with that session's PID and is not cancelled.
- The server refuses to start with a pending, unknown or changed migration, and with a `data` migration left `running` after `std upgrade` was killed between batches (`data-migration-interrupted`: `std serve` names the migration, `doctor` exits 1 with `dataMigrationIncomplete`, a rerun of `std upgrade` completes it and `doctor` exits 0, a second rerun changes nothing); killing `std upgrade` during a `tx` and a `concurrent_index` migration and rerunning applies each once.
- `doctor` exits 0 on a clean install and reports each seeded drift (missing, extra or mistyped column, invalid index, unvalidated constraint, orphan table, edited base row, effective record mismatch, dangling dependency, interrupted change set, 1,400 columns, nullable `class_id`, stale definition revision) with the right severity.

## 2. Logical records and inheritance

Model: class-table inheritance. Each class has its own Postgres table holding only the fields it adds. Every table in a hierarchy uses the record's `id`.

### 2.1 Storage layout

- The root row holds `id`, `class_id`, `version`, `created_at`, `created_by`, `updated_at`, `updated_by` and the root's own fields. A child level row holds `id`, `class_id` and its own fields.
- `class_id` is NOT NULL in every table. Reason: with the default MATCH SIMPLE, a NULL `class_id` would skip the level FK check. `doctor` check 12 verifies it.
- Every table gets `PRIMARY KEY (id)` and `UNIQUE (id, class_id)` at creation. Reason: any table can gain a child later, and adding a unique index then needs a concurrent build. [judgment; costs one index per table, measured in the benchmark]
- Every table gets `CHECK (class_id IN (<stable IDs of subtree(T)>))`.
- Every child table gets `FOREIGN KEY (id, class_id) REFERENCES <parent> (id, class_id) ON DELETE CASCADE`. This **level FK** is the only `ON DELETE CASCADE` allowed in an STD schema.
- Every table gets a `BEFORE UPDATE` row trigger `WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id)` that raises. `WHEN` is used instead of `UPDATE OF class_id` because column-specific triggers do not fire for changes made by other BEFORE triggers.
- A child's own required fields are `NOT NULL` in its table. Overrides of inherited fields are enforced by the record service (2.5).

```sql
CREATE TABLE acme.asset (
  id uuid PRIMARY KEY, class_id uuid NOT NULL, version bigint NOT NULL,
  created_at timestamptz(3) NOT NULL, created_by uuid NOT NULL REFERENCES core."user" (id),
  updated_at timestamptz(3) NOT NULL, updated_by uuid NOT NULL REFERENCES core."user" (id),
  name text NOT NULL,
  CONSTRAINT asset_id_class UNIQUE (id, class_id),
  CONSTRAINT asset_class_subtree CHECK (class_id IN (:asset, :laptop, :monitor)));
CREATE TABLE acme.laptop (
  id uuid PRIMARY KEY, class_id uuid NOT NULL, serial text NOT NULL,
  CONSTRAINT laptop_id_class UNIQUE (id, class_id),
  CONSTRAINT laptop_level FOREIGN KEY (id, class_id)
    REFERENCES acme.asset (id, class_id) ON DELETE CASCADE,
  CONSTRAINT laptop_class_subtree CHECK (class_id IN (:laptop)));
CREATE TRIGGER asset_class_fixed BEFORE UPDATE ON acme.asset FOR EACH ROW
  WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change();
```

`:asset` and the other `:name` values stand for the classes' stable IDs. Constraint names here are readable for the example; generated names follow 1.1.

### 2.2 Invariants (answers to the review questions)

1. **Concrete class.** Stored as `class_id` on the root row and copied to every level row so constraints can check it. The API shows it as read-only `class` (the qualified table name), so renaming a table changes no records.
2. **No sibling membership.** Each level FK forces a level row's `class_id` to equal the root row's, and each table's CHECK forces it into that table's subtree. Sibling subtrees are disjoint, so rows for two siblings cannot both exist, and no record can have a level row outside its concrete class's ancestry. A level row cannot exist without the rows above it.
   - Not enforced by Postgres: that the lowest level row exists. The record service inserts all level rows in one transaction, root first; `doctor` and a CI invariant check report gaps; child endpoints use inner joins, so such a record is absent there. [judgment]
3. **One version.** Every successful write to any level runs `UPDATE <root> SET version = version + 1, updated_at, updated_by WHERE id = $id AND version = $expected` in the same transaction. A client that read through the parent endpoint gets `VersionConflict` after a child-only change by someone else. Intended: one record, one version.
   - Lock order: every write first locks the root row alone (`SELECT version ... FOR NO KEY UPDATE`), then computes visibility and existing-state checks in the next statement, which takes a fresh snapshot, then writes level rows top down. Reason: under READ COMMITTED, after a lock wait only the locked row is re-fetched, so a single statement could judge joined level rows on stale data. From Step 3 a part of an aggregate locks its owner chain, aggregate root first, before its own root row (4.9).
   - Updates use `FOR NO KEY UPDATE`, except that a patch changing a column with a non-partial, non-expression unique index locks `FOR UPDATE` from the start, because such an UPDATE takes `FOR UPDATE` anyway [checked: [explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html)]. Deletes use `FOR UPDATE`. `FOR NO KEY UPDATE` does not block the `FOR KEY SHARE` locks other transactions' FK checks take [checked: same page].
4. **Whole-record delete.** The service deletes the root row with a version check; level FKs remove level rows in the same statement. One change entry holds all levels; it and its deliveries carry `record_version` = current version + 1. This is not a cascade between records: no other record changes. A reference from any other record refuses the delete (3.10).
5. **Child rules through the parent endpoint.** The service reads and locks the root row to learn the concrete class C, validates against C's effective schema (its fields plus overrides from C and its ancestors), applies access rules attached to C and every ancestor, and runs hooks and record rules attached to C and every ancestor, whichever endpoint is used. The parent endpoint can name only fields of its class and ancestors; a child-only field gets `UnknownField`. A create makes a record of exactly the endpoint's class. [judgment] (v1; in v2 a create may name a class of the endpoint's subtree with `@type`, 10.5.)
6. **No class changes.** `class` is read-only in the API, the service never writes `class_id` after insert, and the trigger refuses it. A later class-change feature must be a dedicated record-service operation.

### 2.3 What each endpoint shows

- Endpoint E lists records whose class is in subtree(E), with fields of E and its ancestors, system fields and `class`.
- In v0.1 child-only fields cannot be selected, filtered or sorted through a parent endpoint. [judgment]
- History is the exception: through any endpoint it shows every field the caller can read on the record's concrete class, since decisions do not depend on the endpoint (3.7). [judgment]
- `GET /E/{id}` for a record outside subtree(E) returns `NotFound`, identical to an unknown ID.
- `class` supports `eq` and `in` over table names, resolved against the caller's visible tables.

### 2.4 Adding a class

Runs as a change set (1.4), ancestors altered root first, the same order writers use:

1. For each ancestor, `DROP CONSTRAINT <subtree check>, ADD CONSTRAINT ... CHECK (...) NOT VALID`. ACCESS EXCLUSIVE, but no scan, so brief.
2. Create the child table with its level FK (SHARE ROW EXCLUSIVE on the parent).
3. No VALIDATE. The NOT VALID check already applies to new rows, and the old validated check implies the new one, so a scan of every ancestor would gain nothing. The widened check is recorded as `enforced` with a note saying so, and `doctor` check 3 accepts that state. [judgment; checked: `inheritance.test.ts` adds a grandchild to a hierarchy of 2,000 records, `seq_scan` of both ancestors unchanged, `convalidated` false]

Measured [checked: 0F probe 3, a grandchild added to a 1,000,000-record hierarchy]: the main transaction took 6.6 ms (each widened check 0.3 to 0.4 ms); it held ACCESS EXCLUSIVE on the root and the parent and SHARE ROW EXCLUSIVE on the parent; no ancestor was scanned (`pg_stat_xact_user_tables.seq_scan` 0) or rewritten (`relfilenode` unchanged). A reader holding an ancestor past 2 s makes the attempt time out (after 2,001 ms), roll back with the revision unchanged, and retry.

Accepted cost: adding a class briefly locks every ancestor. Rejected alternatives [judgment]: a shared `core.class_ancestry` table with an FK from every level row (hot row under concurrent inserts), and the root-to-class path stored on every row (wider rows and indexes; the fallback if ancestor locks are a problem).

### 2.5 Field overrides

Rule: a child may tighten an inherited field, never loosen it. Reason: every child record is also a parent record, and parent-level code, queries and access rules rely on the parent's constraints.

- Overrides are keyed by (child class ID, field ID), apply to the class and its descendants, and stack down the chain.

| Property | Child may | Enforced by |
| --- | --- | --- |
| Label, help text | replace | metadata |
| Default | replace, with a value valid under the parent's constraints | record service, on creates through the child's endpoint |
| Required | make optional required, never the reverse | record service, every write through any endpoint |
| Read-only | make editable read-only, never the reverse | record service |
| Max length, numeric min and max | narrow only | record service |
| Choices (Step 2) | a subset of the parent's keys (`choices` on the override); stacked subsets intersect | record service: a key outside the concrete class's subset is `unknownChoice` through every endpoint; tightening follows the preflight below [decision 0017] |
| Auto-number prefix (Step 2) | replace (`numberPrefix`); not a tightening, no preflight | record service, on creates [judgment, decision 0017] |
| Not overridable | name, ID, type, column, database nullability, unique, indexes, reference target, a condition field's class and profile, delete behavior |  |

- No database CHECK enforces overrides in v0.1: it would sit on the parent's table and be rewritten whenever the subtree grows. [judgment]
- Adding or tightening an override follows the 1.4 tightening pattern: take `SCHEMA_KEY` and run a preflight count before `CONFIG_KEY` (refused with the count if any record in the subtree violates it); the record service enforces it from the main commit; a follow-up `validate_override` step rechecks and sets enforcement. `doctor` reports violations.

### 2.6 Benchmark (Stage 0, rerun in Step 5)

- **Hierarchy:** four levels, nine classes. L1 `bench.item` (12 own fields); L2 `device`, `furniture`, `license` (8 each); L3 under device: `computer`, `network`, `peripheral` (8); L4 under computer: `laptop`, `server` (6). Records: item 10%, furniture 10%, license 10%, device 5%, network 10%, peripheral 15%, computer 5%, laptop 25%, server 10%.
- **Data:** 1M and 10M records; 50k users referenced from `item.owner`; `bench.ticket` with 20% as many rows, each referencing an item; mixed field types at each level.
- **Models run:** class-table at 1M and 10M; one table per hierarchy at 10M as the comparison baseline [judgment: it is the strongest alternative for the read queries]. The partitioned and per-concrete-class models are benchmarked only if class-table misses a budget or the baseline beats it by more than 2x.
- **Indexes:** on `item` `(status, updated_at)`, `(owner)`, `(updated_at)`; one per filtered L3 and L4 field; `ticket(item)`. Each alternative gets equivalent and natural indexes (for example partial indexes per class). Class-table may add indexes led by `class_id`.
- **Callers:** unrestricted (admin) and restricted (row rule `owner = me OR status = "shared"`, one conditional field deny, one rule attached to `bench.laptop` reading an L4 field).

| ID | Endpoint | Query |
| --- | --- | --- |
| Q1 | L1 | two L1 filters matching about 0.5%, sort `updated_at` desc, first 50 |
| Q2 | L1 | filter matching about 30%, page of 50 at keyset depth 10,000, with count |
| Q3 | L4 | one L4 and one L1 filter, sort by an L2 field, 50 |
| Q4 | L3 | L3 filter, sort by L1 field, 50 |
| Q5 | L1 and L4 | get by id with class resolution and all levels |
| Q6 | L1 | Q1 as the restricted caller |
| Q7 | ticket | filter through the reference to an L1 field, restricted |
| W1, W2, W3 | L4, L4, L1 | insert; update one L4 field (bumps root version); delete an L4 record via the root; 16 clients each |

- **Method:** Postgres 18, hardware and config recorded; reference machine 8 vCPU, 32 GB, NVMe [judgment]. Seeded generator, `ANALYZE`, 10 warm-up and 200 measured runs per read with random parameters, p50 and p95, `EXPLAIN (ANALYZE, BUFFERS)` of a median run, writes for 60 s, table plus index size. In Stage 0 the alternatives are hand-written SQL. In Step 5, class-table queries are issued through the record service (STD-generated SQL) for both callers. Results and script are committed.
- **Budgets at 10M** [judgment]: Q5 p95 at most 5 ms; Q1, Q3, Q4, Q6, Q7 at most 50 ms; Q2 at most 250 ms; writes at most 20 ms.
- **Decision rule:** keep class-table if it meets every budget and the baseline is not more than 2x faster at p95 on more than one read query. Otherwise, after trying the `class_id` index mitigations, benchmark the other two models and send the decision to Martin with the numbers.

Alternatives on their own trade-offs (the same list as the plan's storage decision):

- **One table per hierarchy:** no joins, one composite index serves any filter and sort, sibling exclusion and one version for free. But the 1,600-column cap is shared by the hierarchy (dropped columns count), siblings with the same field name need a field-to-column map, every field addition alters the busiest table, and class-specific required fields need class-conditional CHECKs.
- **One table per hierarchy, LIST-partitioned by class:** per-class storage and partition pruning, but the same column cap, and keys must include the partition key, so `id` alone cannot be unique [checked: [partitioning](https://www.postgresql.org/docs/18/ddl-partitioning.html)].
- **One table per concrete class with all inherited fields:** child reads hit one table. But parent endpoints need `UNION ALL`, parent field changes touch every class table, and there is no real FK to a parent class or unique constraint across the hierarchy.

### Acceptance tests

- As table owner: a monitor level row using a laptop's id fails (23503 or 23514); a child row with `class_id` outside its subtree fails (23514); a laptop row whose `class_id` differs from the root fails (23503); a level row without the rows above it fails (23503); `UPDATE` of `class_id` fails via the trigger.
- `DELETE` through `/acme.asset/{laptopId}` or `/acme.laptop/{id}` with the current version leaves no row with that id in either table, and writes one change entry at the next version.
- As Alice, `PATCH /acme.laptop/{id}` on `serial` raises the version seen via `/acme.asset/{id}` by exactly 1 and updates `updated_at` and `updated_by`; a parent-endpoint update with the old version gets `VersionConflict` and changes nothing.
- Setting `purchased_on` to null via `/acme.asset` is refused for a laptop (override) and accepted for a monitor.
- A body containing `class` is refused; `GET /acme.laptop/{monitorId}` returns a 404 identical to a random UUID.
- Loosening overrides are refused; a tightening override on a class with violating records is refused with the count.
- `doctor` reports a planted laptop root row with no laptop row.
- Adding a grandchild class to a populated hierarchy under `lock_timeout` rewrites every ancestor's check without a scan, `doctor` exits 0, and the sibling tests pass for the new class.
- The benchmark script runs Q1 to Q7 and W1 to W3 for class-table at 1M and 10M and one table per hierarchy at 10M (the other two models behind a flag), emits p50, p95, plans and sizes, and applies the decision rule.

## 3. Authorization

### 3.1 What exists in Step 1

- `core.user` (`name` as display field, `login`, password hash of type `password`, `active`), `core.role`, `core.user_role`. Roles are flat in Step 1; groups and nested roles come in Step 4.
- Roles are config records with a stable ID and an owner layer. They are shipped in sets, loaded in the phase before access rules (8.3), and covered by the schema revision (1.2). User-role assignments (`core.user_role`) stay data. Deleting or retiring a role that an active access rule names is refused with `DependencyConflict` (`rule_role`, 1.7).
- Permissions are protected built-in config records (`core.permission`, with stable IDs), granted to roles through `core.role_permission` (config, covered by the revision) and checked by permission ID [judgment]. v0.1 permissions: `schema.purge` (1.6), `schema.snapshot` (6.8), `rules.run_as` (4.1), `events.subscribe` (12.2), `access.explain` (11.3).
- `core.access_rule`: `effect` (allow or deny), `roles`, `class` (one class or `*`), `target` (records, or fields as a list or `*`), `actions` (read, create, update, delete; field rules cannot use delete), optional `condition`.
- Built-in roles: `admin`; `authenticated`, held implicitly by every active user [judgment]; `schema_purger`, which holds `schema.purge`. Built-in roles, permissions and rules are protected definitions.
- Password sign-in for every active user (Stage 0: the demo users). The first administrator of an install is created by `std bootstrap-admin`, as the system user through the save pipeline, once per login (decision 0016). API tokens, explain mode and the rule editor come in Step 4. The web app holds its session in an HTTP-only, `SameSite=Strict` cookie set by `POST /api/v1/auth/cookie-sign-in`; an unsafe request authenticated by it needs `STD-Client: web` (decision 0018).
- The acting user is a required Effect service of every record-service operation, so a code path with no actor does not type-check. The HTTP layer has no default actor. The system user acts only for bootstrap, definition loading and `data` migrations run by `std upgrade` (1.9), which write through the save pipeline with cause `system` naming the migration and are not checked against access rules, like definition loading: it never signs in and no session authenticates as it, even if it is activated and given a password (decision 0014).

### 3.2 Decision rule

Rules that apply to caller u, action a and record r of concrete class C: they name a role u holds, include a, are attached to C, an ancestor of C or `*`, have a matching target, and have a condition true for r.

- Any applicable deny refuses; otherwise any applicable allow grants; otherwise refused.
- Reading field f needs record read and field read on f. An update needs record update plus field update for each written field (3.9). A create needs record create plus field create for each supplied field. A delete needs record delete.
- `*` on fields of class T covers fields of T and its ancestors, never fields added by descendants. Reason: a new subclass must not expose its fields through rules written before it existed.
- Conditions use the access-rule profile (5.10): evaluated with full access, always true or false, no reference paths in Step 1.
- Decisions depend on record and caller, never on the endpoint.
- Admin is an ordinary role granted by a built-in allow-all rule; denies apply to admins too. No code checks a role name; permissions are checked by ID.
- System fields (`id`, `class`, `version`, `created_*`, `updated_*`) follow row visibility and are never writable.
- `password` and `secret` values are never returned by any read, by type rule (6.5).

Built-in rules: allow `admin` everything on `*`; allow `authenticated` read on `core.user` records and its `name` field, for `created_by` labels [judgment]; deny every role delete on `core.user` (the deny names `authenticated`, which every caller who can act holds). Everything else, including definition tables, `core.access_rule` and `core.change`, is reachable only through the admin rule.

Platform tables (1.9) are matched only by rules in the `core` owner layer: `*` in an app or local rule never matches a platform table, and an app or local rule that names one is refused at definition validation (`invalidAccessRule`). The decision uses the table's storage and the rule's owner layer, never a role name. [decision 0014]

Platform tables (1.9) are never written through the generic record routes, by any caller: a create, update or delete on one is `NotAllowed` (after visibility, 3.9), so `core.change` entries, the journal and protected definitions cannot be forged or edited outside change sets and the save pipeline. Generic writes on definition tables become one-operation change sets (1.4) before that check. [decision 0014]

### 3.3 Two-user example

- `acme.asset`: `name`, `owner` (reference to user), `status`, `cost`, `purchased_on`, `docked_to` (reference to asset). `acme.laptop` adds `serial` and `disk_key` and overrides `purchased_on` to required. `acme.monitor` adds `size_inches`.
- Alice has role `asset_manager`; Bob has `employee`.
- Fixture: Bob owns laptop L (cost 1200, docked to Alice's monitor), monitor M (cost 300, not docked) and plain asset S (cost 2500, status `lost`). Alice owns that monitor and a laptop K.

The rule numbers run 1, 2a to 2c and 3 to 10: twelve rules (`examples/acme/access.yaml`).

| # | Effect | Role | Class and target | Actions | Condition |
| --- | --- | --- | --- | --- | --- |
| 1 | allow | asset_manager | asset records | all |  |
| 2a | allow | asset_manager | asset fields `*` | read, create, update |  |
| 2b | allow | asset_manager | laptop fields `*` | read, create, update |  |
| 2c | allow | asset_manager | monitor fields `*` | read, create, update |  |
| 3 | allow | employee | asset records | read, create, update | owner = me |
| 4 | allow | employee | asset fields `*` | read |  |
| 5 | deny | employee | asset field `cost` | read |  |
| 6 | deny | employee | asset field `purchased_on` | read | status = "lost" |
| 7 | allow | employee | asset fields `name`, `status`, `owner`, `docked_to` | create, update |  |
| 8 | allow | employee | laptop field `serial` | read |  |
| 9 | deny | employee | laptop field `status` | update |  |
| 10 | deny | employee | asset field `docked_to` | read | cost > 2000 |

It exercises row visibility, a never-readable field, a conditionally readable field, a rule condition that reads a field the caller cannot read (rule 10), readable and unreadable child-only fields, a child rule applied through the parent endpoint, existing and proposed checks, a hidden reference label, and history through both endpoints.

### 3.4 Visible schema and the unknown-field rule

- For caller u, field f and class C, f is **never** (no allow, or an unconditional deny), **always** (an unconditional allow and no deny), or **conditional** with predicate `(OR of allow conditions) AND NOT (OR of deny conditions)`.
- At endpoint E, f is never if never for every class in subtree(E), always if always for every class, otherwise conditional with its predicate selected per class by `class_id`.
- Every field name in a filter, sort, selection, cursor or reference path resolves against the visible schema (non-never fields plus system fields). A misspelled name and a never-readable field produce the same `UnknownField` response (status, code, message template, code path), before any query runs.
- Write bodies resolve against readable or writable fields.
- A class where none of the caller's roles has any allow returns `UnknownTable`, identical to a nonexistent table.

### 3.5 Rows, projection, filters and counts

- Visibility compiles into the SQL `WHERE`. Classes without their own rules share the parent's predicate; otherwise `(class_id IN (group) AND predicate) OR ...`, and a group may `LEFT JOIN` its level table. Lists, counts, cursors, single reads and writes all use it. Nothing is read and then filtered in TypeScript. A record outside it is `NotFound`.
- An always field compiles to the column. A conditional field compiles to `CASE WHEN <predicate> THEN col END` plus a flag; when false the key is left out. Hidden values never leave the database. The default selection is every non-never field.
- **Masking rule:** every reference to a conditional field in filters, sorts and cursors uses its masked expression, so a hidden value behaves exactly like empty. Ties break by `id`. Cursors carry only masked values plus `id`.
- **Nulls in sorts and cursors:** ascending sorts use `NULLS LAST`, descending `NULLS FIRST` [judgment]. The cursor predicate is compiled in an expanded, null-aware form (no row comparison such as `(k, id) > ($k, $id)`, which is NULL when k is NULL) over exactly the same masked expression as `ORDER BY`.
- **Non-interference guarantee:** the rows, their order, the count and which fields are present depend only on values the caller can read and on the outcomes of the access-rule conditions that apply to the caller. Equivalently: for fixed rule outcomes (which records are visible, which fields are withheld on each), they depend only on values the caller can read.
- A rule condition may read fields the caller cannot read (rule 10). That disclosure is the rule author's choice, and the rule editor warns when a condition reads a field that some role it applies to cannot read [judgment].
- Cost: masked expressions cannot use a plain index; always fields compile bare. [judgment]
- Sorts on text compare the field's comparison key (`casefold` for case-insensitive text) under `pg_unicode_fast`, so the order is by code point, independent of the database's default collation; password, secret, json and condition fields cannot be sorted. [judgment, decision 0008]
- Branch form: when the caller's visibility has several top-level ORs (class groups or allow conditions), a page is a `UNION ALL` of disjoint branches (`AND NOT COALESCE(<earlier branches>, false)`), each with the full filter, cursor, `ORDER BY` and `LIMIT`, merged by the same order and limit; results equal the plain form's (property-tested). Counts use the plain form. Branch-form pages run unprepared with custom plans and no parallel workers (decision 0008).
- Counts use the same `FROM` and `WHERE` as the page and are returned only on request (6.6). No total or "has more" flag comes from an unrestricted query.

### 3.6 References

- A label is shown only if the caller can read the reference field, the target is visible, and the caller can read the target's display field on it. It comes from a join applying the target's visibility and masks.
- If the reference is readable but the label is not, the value is the UUID with no entry in `labels` (6.6), whether the target or only its display field is hidden. If the reference field is not readable, the key is absent.
- One hop in filters and selection: the reference's own mask first, then the target's visibility in the join condition and its field masks. A hidden target behaves like an empty reference.
- Writing a reference requires a visible target that satisfies the field's allowed-records condition in the caller's view (6.5); otherwise `InvalidReference`, identical to an unknown ID.
- Accepted leak: UUIDv7 IDs encode creation time. [judgment]
- Accepted leak: a create with a client-chosen ID that a hidden definition holds is refused with `idInUse` (1.1: IDs are never reused), so the caller learns the ID is taken, and nothing else: the refusal is the same for every occupant, visible ones included. Only a caller that already holds the ID learns anything. Under an unknown or future revision (6.4), the refusal is identical to the missing case. [judgment]

### 3.7 History access

- History is read only through `GET .../records/{id}/history`. `core.change` is admin-only, because generic filters on stored values would bypass field protection.
- An entry is visible if the caller can currently see the record. Values for field f appear only if the caller can read f on the current record under current rules; otherwise that field's change is left out entirely. Reason: knowing that a hidden field changed is information about it.
- Through any endpoint, history covers every field of the record's concrete class that the caller can read, child-only fields included (2.3).
- Entries with no visible field changes still show who, when and version, since `version` already reveals the save.
- Changes to purged fields are admin-only. Deleted records' history is admin-only in v0.1. Reason: anything more needs rule evaluation over JSON snapshots.
- History can be filtered by time, actor, kind and readable field ID, never by value.
- Delivery payloads are filtered differently (4.5).

### 3.8 Errors

All API errors are tagged errors with a PascalCase `_tag`.

| `_tag` | HTTP | When |
| --- | --- | --- |
| `UnknownTable`, `UnknownField` | 404, 400 | does not exist or never readable; identical responses |
| `NotFound` | 404 | record does not exist or is not visible; identical |
| `NotAllowed` | 403 | refused on a visible record, or create refused; names no rule |
| `ValidationFailed` | 422 | lists field errors (`InvalidValue`, `Required`, `ReadOnlyField`, `DefinitionRetired`), only for fields the caller supplied or can read |
| `VersionRequired` | 428 | `PATCH` or `DELETE` without `If-Match` (6.7) |
| `VersionConflict` | 409 | gives the current version |
| `SchemaChanged` | 409 | see 6.4 |
| `InvalidReference` | 422 | target does not exist or is not visible; identical |
| `Referenced` | 409 | delete refused because other records reference it; no count or names |
| `DefinitionInvalid` | 422 | a change set's definitions are invalid; lists problems by definition ID |
| `DependencyConflict`, `UseRetireOrPurge`, `PurgeRefused`, `ExistingDataViolates`, `SchemaNeedsAttention` | 409 | change-set refusals (1.4 to 1.7) |
| `DefinitionProtected`, `PermissionRequired` | 403 | 1.8, and a missing permission such as `schema.purge` |
| `SchemaBusy`, `SchemaLockTimeout` | 503 with `Retry-After` | another schema change holds `SCHEMA_KEY`; locks not obtained in 5 attempts (names no session) |
| `Unauthenticated` | 401 | no session token (bearer or the web app's session cookie), an unknown or expired one, an inactive user, or the session cookie on an unsafe request without `STD-Client: web` (decision 0018) |
| `InvalidCredentials` | 401 | sign-in refused; unknown login, wrong password and deactivated user alike |
| `InvalidRequest`, `InvalidFilter`, `InvalidCursor` | 400 | a malformed query parameter, a filter that does not parse or check (after names resolve), a cursor not issued for this sort |

- A deadlock (40P01) or serialization failure (40001) in a request transaction reruns the whole request transaction up to 3 times with a short jittered backoff before it is a 500; a request transaction has no effect outside the database before it commits (post-commit actions run only after the outermost commit) [judgment, decision 0017].
- Raw Postgres error text is never returned (constraint details contain values); it goes to server logs only. Constraint names encode IDs, so violations map to fields without parsing messages.
- Accepted leaks: a unique conflict reveals a value is taken; `Referenced` reveals some reference exists. Timing channels are out of scope for v0.1.

### 3.9 Existing state and proposed state

These work like RLS `USING` and `WITH CHECK`: both the existing and the proposed record must pass. The order of checks is fixed in the save pipeline (4.1).

- Field-level create and update rules follow the same rule. For each written field, the applicable field rules must allow on the existing record (updates only) and on the proposed record.
- A field counts as **written** if the caller cannot read it on r, or if its new value differs. Unchanged readable fields are ignored, because forms send whole records.
- An update is a **no-op** only if every field in the body is readable and none changed. Reason: otherwise whether the version bumps would reveal a hidden value.
- Existing-state checks are computed in the statement after the one that locks r (2.2 item 3), with a fresh snapshot. Visibility is checked before the version, so a caller never gets `VersionConflict` on a record it cannot see.
- The proposed-state check runs after before-write hooks and the row writes, re-reading through the same compiled SQL predicates, so there is one evaluator. Failure rolls back.
- Create: rules are evaluated against the proposed record (defaults and service-set fields included), after insert and before commit.
- Delete: visibility, version check, record delete against the existing record, `FOR UPDATE`.
- After a write the new state is projected with the caller's read rights; if the record is no longer visible, the response holds only `id` and `version`. [judgment]

### 3.10 Deletes and references

- Every reference FK uses `ON DELETE NO ACTION` (refusal), and platform-table FKs do too. Level FKs are the only `CASCADE`. STD never uses `RESTRICT`, `SET NULL`, `SET DEFAULT` or `CASCADE` on a reference. CI checks `pg_constraint.confdeltype` and `confupdtype` across STD schemas.
- Clear and cascade come after v0.1 as record-service operations: find referencing records, authorize each as an update or delete by the caller against both states, run hooks, bump versions, write change entries in the same operation. If any affected record is hidden or not allowed, the whole delete is refused with `NotAllowed` and no details.
- Users are deactivated, never deleted. A deactivated user cannot sign in, sessions end, the effective role set is empty, and labels still resolve.

### Acceptance tests

Each test has a name; the plan lists which belong to Stage 0.

- `rows-count`: As Bob, `GET /acme.asset` lists exactly his assets and the requested count equals the rows across all pages; no record returned to him contains `cost`.
- `hidden-names`: As Bob, filter `cost > 0`, sort `cost` and `fields=cost` each return a response identical to the same request with `nosuchfield`, apart from the name.
- `invisible-404`: As Bob, `GET /acme.laptop/{K}`, `GET /acme.asset/{K}` and `PATCH` on Alice's laptop K each return a 404 byte-identical to a random UUID.
- `noninterference`: property test. For generated filters, sorts and cursors, randomize values Bob cannot read, recompute every applicable rule outcome, and keep only samples where no outcome changed; on those, the IDs, order, count and present fields of Bob's responses are unchanged.
- `masked-filter`: As Bob, `purchased_on > D` excludes his lost asset S and `not (purchased_on > D)` includes it, whatever its stored value.
- `hidden-rule-input`: Rule 10 reads `cost`, which Bob cannot read. On S (cost 2500) `docked_to` is withheld; on L (cost 1200) it is not. Changing S's cost anywhere above 2000 changes nothing Bob sees; changing it to 1500 changes only whether `docked_to` is withheld. This one bit is the documented disclosure.
- `ownership`: Bob changing his laptop's owner to Alice gets 403, no version bump, no change entry; creating with owner Alice gets 403, with owner Bob 201.
- `child-rule-parent-endpoint`: Bob updating `status` on M via `/acme.asset` succeeds; on L via `/acme.asset` gets 403 (rule 9).
- `child-fields`: Bob sending `serial` via `/acme.asset` gets `UnknownField`; via `/acme.laptop`, `disk_key` gets `UnknownField`.
- `written-fields`: An unchanged readable field Bob may not write is accepted; a no-op body does not bump the version; an unreadable field with a value equal to its hidden value gets the same status and version effect as a different value.
- `field-rule-states`: with rule 7 replaced, for `name`, by an allow conditioned on `status = "in_use"`: Bob changing `status` from in_use to spare together with `name` gets 403 (proposed state fails); changing `status` from spare to in_use together with `name` gets 403 (existing state fails); changing only `name` while in_use succeeds.
- `references`: Bob sees `docked_to` on L with no label, Alice sees the label; Bob's filter on `docked_to.name` returns 0 rows, Alice's returns L; Bob setting `docked_to` on M to Alice's monitor gets `InvalidReference`, identical to a random UUID, and so does a create with that value.
- `cursor-nulls`: 1,000 visible rows with half the sort keys hidden from the caller, paged 7 at a time ascending and descending, return every visible row exactly once, in the order of one unpaged query.
- `history`: After Alice changes `cost` and `status` on L, Bob's history via either endpoint shows the status change and no `cost` key.
- `history-endpoint`: After Alice changes `serial` on L, Bob's history via `/acme.asset` shows the `serial` change.
- `two-user-write`: On L at version n: Bob updates `name` through `/acme.laptop` (200, version n+1). Alice, holding version n read through `/acme.asset`, updates `cost` and gets `VersionConflict` with nothing changed. Alice rereads through `/acme.asset` and updates `cost` (version n+2). Bob's update of `status` gets 403 through both `/acme.laptop` and `/acme.asset` (rule 9). Alice setting `purchased_on` to null through `/acme.asset` gets `ValidationFailed` (laptop override). Each user's history through both endpoints shows exactly versions 1..n+2, with no `cost` key for Bob.
- `referenced`: Alice deleting her monitor, which L references, gets `Referenced` with no ID or count; the monitor remains.
- `fk-actions`: CI: every FK in STD schemas has `confdeltype` and `confupdtype` `a`, except level FKs with `confdeltype` `c`.
- `platform-tables` (Step 1): As Bob, the generic `core.change` and `core.access_rule` endpoints return `UnknownTable`; so does every platform and config table on every route for every non-admin. Admin writes to platform tables through the generic routes are `NotAllowed`.
- `users` (Step 1): Admin deleting a user gets 403; a deactivated user cannot sign in, their sessions end, their effective role set is empty, and labels still resolve.
- `no-bypass` (Step 1): With the admin allow-all removed in a test database, admin requests are refused on every path; a role with another name holding the same rules gets what admin got, and no source file checks a role name.
- `error-fuzz` (Step 1): Fuzzed constraint violations (unique, FK on create, update and delete, check, NOT NULL, type and length) on every write path never return Postgres text, constraint names or values; a unique conflict reveals only that the value is taken.

## 4. History and the outbox

### 4.1 Save pipeline and hook phases

Every save (create, update, delete; single or batch) runs in one transaction:

1. Writes to config tables take the change-set path (1.4). Otherwise `begin_request()` (1.3). Check staleness and resolve names (6.4, 3.4: `UnknownField`).
2. Lock the root row alone (2.2 item 3). In the next statement check visibility (`NotFound`), load all level rows, check the expected version (`VersionConflict`).
3. Existing-state access checks (3.9) (`NotAllowed`).
4. Normalize proposed values to canonical form (6.5). If the save is a no-op (3.9), return the current record; no hooks, no writes. An aggregate save (4.9) is never a no-op and skips this check and the one in step 6.
5. Before-write hooks. From Step 3, record rules of kind `derive` and `guard` run here only on saves that are not persisted by settling (4.9); kind `invariant` runs on every save (4.10).
6. No-op check again. Validate against the concrete class's effective schema (`ValidationFailed`).
7. Write level rows; bump the root version.
8. Proposed-state access checks (`NotAllowed`, rollback).
9. Write the change entry (4.2) and one delivery row per matching subscription (4.6).
10. After-write hooks. If this is the outermost save, finalize the touched aggregates (4.9, from Step 3): settle them in memory, then persist each touched owner at most once, before commit.
11. If outermost, commit. After commit, outside the transaction, send a worker wake-up if the transaction wrote a delivery row, debounced to at most one per process every 250 ms [judgment]. Reason: a transaction that ran NOTIFY takes a database-wide lock in `PreCommit_Notify` and holds it until after commit, which would serialize the commits of all saves [checked: src/backend/commands/async.c, REL_18_STABLE; 0F probe 6, 16 clients of small saves for 60 s: after-commit wake-up 2,643 saves/s at p95 10.1 ms, in-transaction `pg_notify` 296 saves/s at p95 103.5 ms, 11% of the throughput].

Nested saves:

- A nested save joins the outer transaction and never opens a savepoint.
- If a nested save fails after its first write, the transaction is poisoned. The SQL layer counts every statement as a potential write unless the code that built it marks it read-only, so it never infers a write from statement text. The SQL layer refuses to commit a poisoned transaction (it rolls back and logs a defect), whether or not the caller handled the error. The same rule applies to hooked rows in `saveBatch` (7.7).
- The record service tracks which records are in the current save stack and refuses a nested save to any of them with `RecordInSave`, which fails the outer save. Reason: otherwise a hook that writes B, whose hook writes A, changes A after A's proposed-state check.

Hooks and record rules are selected by the record's concrete class: those attached to it and to every ancestor run, whichever endpoint is used. Order: by order number, then stable hook ID.

| Phase | Runs | May | May not | On failure |
| --- | --- | --- | --- | --- |
| before-write | in the transaction, before validation | read via the record service; change the proposed record; abort with a typed error | write any record; call external systems | save aborts |
| after-write | in the transaction, after rows, change entry and delivery rows | read; write other records via the record service (full pipeline) | write any record in the current save stack (`RecordInSave`); call external systems | whole transaction rolls back |
| after-commit | from a delivery (4.6), in the worker's delivery transaction | read; write any record as the subscription's identity; call external systems | change the committed save | retried with backoff, then dead letter |

- In-transaction hook writes run as the acting user, so access rules apply to them, unless the rule names a run-as identity, which requires the `rules.run_as` permission [judgment].
- In-transaction hooks get an Effect environment with no HTTP client, so an external call fails to type-check. [judgment]
- Nesting depth is capped at 8 (`HookDepthExceeded`), also along after-commit `cause` chains. [judgment]
- **After-commit effects (decision):** when an effect only writes through the record service, its writes and the fenced `done` update commit in one transaction, so in-database effects happen exactly once. External calls stay at least once, run outside any transaction, and receive `change_id` as their idempotency key. Reason: admins configure after-commit rules without code, so they cannot make them idempotent.
- Record rules (Step 3) are declared as in 4.10: a `before` rule is before-write, of kind `derive` (sets values), `guard` (refuses a user's transition) or `invariant` (refuses a state on every save, settled ones included); an `after` rule is after-write (synchronous, can fail the save); an `afterCommit` rule runs from a delivery (asynchronous, cannot); an `aggregate` rule runs when its class's records are settled as owners (4.9) and only proposes in-memory changes.
- A nested Effect `withTransaction` issues `SAVEPOINT` [checked: Effect 4 `SqlClient` `makeWithTransaction`], so STD's SQL layer joins the outer transaction itself, and a test asserts no `SAVEPOINT` is issued. Inside an STD transaction, Effect's nested `withTransaction` dies before it sends anything, and the SQL layer refuses `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` statements [checked: 0A smoke test].

### 4.2 Change entries

Each committed version of a logical record has exactly one change entry, written in step 9. A no-op writes none. A delete's change entry and its deliveries carry `record_version` = current version + 1.

`core.change` columns: `change_id` (UUIDv7, the idempotency key everywhere); `operation_id` (one per outermost transaction); `record_id`; `class_id` (column `record_class_id`, because `core.change` is laid out like a platform table whose own `class_id` is its platform class; decision 0009); `record_version`; `kind` (`create`, `update`, `delete`); `actor_id`; `cause` (`api`, `ui`, `import` with job and row, `hook` with hook and parent change, `after_commit` with subscription and parent change, `system`); `schema_revision`; `occurred_at` (informational, never used for ordering); `fields`, a map from field ID to `{before, after}` in canonical JSON (create: all non-empty `after`; update: changed fields; delete: all `before`). References store the ID only, never a label.

- `UNIQUE (record_id, record_version)`: every version bump, and every delete, has exactly one entry, whichever endpoint the save came through.
- Writes to other records in the same transaction are separate entries with the same `operation_id`.
- Writing history is a fixed pipeline step, not a hook, so configuration cannot disable it.

### 4.3 Secrets

- `password` and `secret` values never appear in change entries, delivery payloads, import reports, logs or errors. A change entry records them as `{"changed": true}` on create and update and omits them on delete.
- Converting a field to a secret type belongs to the deferred type-change feature, which must scrub earlier entries.

### 4.4 Interpreting old values

- `core.definition_revision (definition_id, revision, kind, effective jsonb)` is a platform table. It is written in the main transaction of every change set, and on every override change, for each definition whose effective properties changed. A reader resolves revision R from the latest row with revision <= R. `doctor` check 16 verifies that each definition's latest row equals its effective record.
- Readers order rows by the bigint `revision` column, never by a text rendering of it ("10" sorts before "9"). The overrides and choices of a field are found through the partial index `core.definition_revision_field` on `(effective ->> 'fieldId', revision)` for `kind` `override` and `choice` (platform migration 0010, a `concurrent_index` migration). [judgment, decision 0020]
- An entry stores field IDs and its schema revision, so a reader can look up label, type and choices as they were at that revision.
- The history endpoint does that lookup for the reader: each entry carries `fields`, keyed exactly like its `changes` (the field's current name), with per field its `label`, `type` (as metadata shows types, 6.3: a reference or condition field names its table only when the caller knows it now, and a reference's allowed-records condition is left out) and `choices` (`{key, label}` of the field's live choices at that revision, hidden ones included, not narrowed by a child's subset; null for other types), all as they were at the entry's revision, on the record's concrete class (overrides at that revision applied). Only fields in the entry's `changes` are described, so `fields` reveals nothing the entry does not. A purged field (admins only, 3.7) is described by the definition revisions its tombstone keeps. [judgment, decision 0020]
- Purged fields remain as tombstones (1.6), and their definition revisions are kept. The Step 2 history panel renders old values with the definitions at the entry's revision: each changed field with the entry's own `fields` (label, type, choice labels at that revision), password and secret changes only as "changed", references to users by the names the caller may read, and an entry without visible changes with who, when, kind and version [judgment, decision 0020].
- The same table resolves request names at a request's revision (6.4).

### 4.5 Reading history

Access rules for history reads are in 3.7. The same filtering applies to the API, the form panel and exports. An entry's `fields` (4.4) follows its `changes`: a field the caller cannot read has neither a change nor a description.

Delivery payloads are filtered for the subscription's identity on the version's own image (the after image; the before image for a delete), under current rules. So a delete delivery to a non-admin identity carries the filtered before image, and a payload does not depend on the record's state when the delivery runs.

### 4.6 Outbox

**Why not a global sequence as a cursor.** Transaction A takes 100; B takes 101 and commits; a consumer moves past 101; A commits 100, which is never read. Sequence values are allocated at call time, independent of commit [checked: [sequence functions](https://www.postgresql.org/docs/18/functions-sequence.html)]. UUIDv7 IDs and `occurred_at` have the same flaw.

**Decision: a transactional outbox with one delivery row per matching subscription.** Reason: each subscription keeps durable retry state, and no cursor exists that could skip an uncommitted entry.

Producer side (Step 1):

- `core.subscription` is a config record (stable ID, owner layer), written through change sets: class (descendants included; never a platform table, whose rows do not pass the save pipeline, except the config kinds below), operations, optional condition (subscription profile, 5.10), the identity it runs as, `max_attempts`, dead-letter policy, `enabled`.
- **Config subscriptions** (Step 3, decision 0021, resolved question 21). A subscription may instead name a config kind: `role` or `accessRule` [judgment: the two TMF672 projects, 11.3; more kinds only with a test like `config-events`]. Config writes do not pass the save pipeline, but every change set already writes one `core.change` entry per definition version in its main transaction (1.4). That same transaction, under `CONFIG_KEY` exclusive, now also writes one `core.delivery` row per enabled subscription on the definition's kind whose condition matches the effective record after the change set (the record before it for a delete), with `record_id` = the definition's ID and `record_version` = its definition version. This covers admin change sets, generic writes on definition tables (1.4), override changes (8.2) and set loads by `std upgrade` (8.3), which are all change sets. A change set that creates, changes, retires or deletes an access rule also bumps the definition version of every role the rule names before or after, once per role and change set, with a change entry (kind `update`, empty `fields`, `cause` `{"accessRules": [<change IDs>]}`) but no definition revision (its effective record did not change) [judgment: a role's projection includes its rules, so role events need the role's own order]; config subscriptions on `role` see these entries like any other role change. So a change set that rolls back leaves no delivery, deliveries of one definition follow its version order under the unchanged claim predicate, and a change set's deliveries become claimable only when it commits. The subscription's identity needs read on the definition table, which only `core`-layer rules can grant (3.2); the core set grants it to `canvas_system` for `core.role` and `core.access_rule` (13.2).
- In step 9 each active, enabled subscription of the record's concrete class or an ancestor that lists the operation is evaluated in TypeScript on `after` (on `before` for delete), with the request's snapshot. A stored condition that no longer checks against the snapshot is a defect and fails the save. Each match inserts into `core.delivery`: `id` (bigint identity, primary key), `subscription_id`, `change_id`, `record_id`, `record_version`, `status` (`pending`, `in_flight`, `done`, `dead`), `attempts`, `next_attempt_at`, `lease_until`, `lease_token uuid`, `last_error`, `UNIQUE (subscription_id, change_id)`; `subscription_id` and `change_id` are `NO ACTION` foreign keys (3.10, 4.8), and a lease exists exactly while a row is `in_flight`. A row holds IDs only; the payload is built from the change entry at delivery time (4.5). Decision 0013.

Worker (Step 3):

- A worker claims a few rows with `FOR UPDATE SKIP LOCKED`, sets them `in_flight` with `lease_until` and a new `lease_token`, and commits. `SKIP LOCKED` suits queue tables but gives no global order [checked: [SELECT](https://www.postgresql.org/docs/18/sql-select.html)].
- Fencing: the done and failure updates are `WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'`. If 0 rows change, the worker has lost the lease and discards its result; in a delivery transaction that holds record writes, it rolls the whole transaction back. Expired leases are claimable again, and each claim writes a new token.
- The worker interrupts its effect before `lease_until`. The lease must exceed the effect timeout plus a margin [judgment].
- Record-service effects run in one delivery transaction that ends with the fenced `done` update (4.1). External calls run outside any transaction, then the fenced `done` update commits.
- Failure returns the row to `pending` with exponential backoff and jitter, 10 s doubling to 1 h, shortened by up to 20 % [judgment]. `attempts` counts claims; a failure after `max_attempts` claims (default 10 [judgment]), or the expiry of the last allowed claim's lease (dead-lettered by the next claim), makes it `dead`, shown in an admin view and a metric, for an operator to retry or discard.
- Wake-ups (4.1 step 11) only wake workers; they also poll.
- `done` rows are deleted after 7 days [judgment]; `dead` rows stay.
- A new subscription receives changes committed after it is created; a change in flight at that moment may or may not get a row [judgment]. Backfill is later.

Claim predicate:

```sql
p.subscription_id = $1
and ((p.status = 'pending' and p.next_attempt_at <= now())
  or (p.status = 'in_flight' and p.lease_until < now()))
and not exists (
  select 1 from core.delivery e
  where e.subscription_id = p.subscription_id and e.record_id = p.record_id
    and e.record_version < p.record_version
    and e.status in ('pending', 'in_flight', 'dead'))  -- 'dead' only under block
order by p.id limit $2
for update skip locked
```

Backed by a partial index on `(subscription_id, record_id, record_version)` where `status <> 'done'`; the plan uses it both for the claimed rows and for the ordering check [checked: EXPLAIN in the `outbox-claims` test, decision 0013]. The claim commits in its own transaction before the effect starts. Per-record order holds because saves of one record are serialized by the root-row lock, so version n's delivery row commits before n+1's, and fencing stops a worker that lost its lease from releasing n+1 early. [judgment, proven at SQL level by the `outbox-claims` tests (decision 0013); the soak test is Step 3]

**Considered: a commit-visibility feed** that reads entries stamped with `pg_current_xact_id()` below `pg_snapshot_xmin(pg_current_snapshot())`. This is a safe visibility watermark but gives first-write order, not commit order [checked: [system information functions](https://www.postgresql.org/docs/18/functions-info.html), [transaction IDs](https://www.postgresql.org/docs/18/transaction-id.html)]. Rejected because one long or idle-in-transaction session anywhere in the cluster stalls every consumer, consumers would still need record versions and per-consumer retry state, and stored XIDs mean nothing after a logical restore into a new cluster [judgment].

Costs accepted: one row per matching subscription per change (a 100,000-row import with 3 subscriptions writes 300,000 rows); new subscriptions need backfill.

### 4.7 Ordering and deduplication guarantees

- **Ordered:** per subscription and logical record, in version order. Version n+1 is not claimed until n is `done`, or, under `skip`, `dead`.
- **Not ordered:** anything else, including the changes of one operation. Consumers use `operation_id` to group.
- **In-database effects exactly once; external effects at least once:** external calls repeat after worker crashes, lease expiry or a restore.
- **Dedupe by `change_id`**, not by `(record_id, record_version)`: after a restore a version number can be reused for different content. [judgment]
- Versions one subscription sees increase but can skip numbers (its condition filters). State-syncing consumers read the current record.
- Dead-letter policy per subscription: `block` (default) holds later deliveries for that record until an operator acts, while other records flow; `skip` lets them proceed, so a retried dead delivery can arrive after newer versions.

### 4.8 Retention (later)

v0.1 has no retention. Fixed now so it can plug in: `core.delivery.change_id` references `core.change` with `ON DELETE NO ACTION` (refusal, 3.10); import conflict detection (7.3) treats missing history as "changed by someone else"; versions are never renumbered.

### 4.9 Aggregates (from Step 3)

Some records are parts of another record: a ticket's notes, an order's items, an item's approvals. A TMF resource shows them as one document, so a change to a part must change the whole: its version, history and events (11.1). Decision 0021, resolved questions 20 and 23.

**Ownership.**

- An **owner reference** is a reference field declared `aggregate: true` (6.5). The records of its class are **parts**; the record it names is their **owner**.
- It is required and read-only after create (`ReadOnlyField`), so a part never changes owner; a move is a delete of the old part and a create of a new one, which changes both owners.
- A class has at most one owner reference, inherited ones included. A class that needs two kinds of owner is split into two classes (for example `helpdesk.change_approval` and `helpdesk.request_item_approval`, 14.4).
- The class graph of owner references has no cycle and is at most 3 levels deep. Definition validation refuses violations with `DefinitionInvalid` (`aggregateCycle`, `aggregateTooDeep`).
- A record's **owner chain** is its owner, that owner's owner, and so on up to the **aggregate root**, a record that is no part. Because owner references are required and never change, an existing record's chain never changes.

**Locks.**

- Every save of a record that is a part, whether create, update or delete, first reads its owner chain and locks it, aggregate root first, each owner's root row `FOR NO KEY UPDATE`. Only then does it take its own lock (2.2 item 3). After locking it reads the chain again; a missing owner is `NotFound` for an update or delete and `InvalidReference` for a create.
- An operation that touches several aggregates (a TMF write, `saveBatch`, a move) locks them all first through the record service's `lockAggregates`, ordered by aggregate root ID, each chain root first.
- A hook or rule that writes into an aggregate the operation has not locked locks it on demand in the same order. A deadlock this can still cause between two such operations is retried like any request deadlock (3.8) [judgment].

**The touched set.** Per transaction, the record service keeps the set of owners to finalize. A save of a part adds every owner of its chain; a save of an owner's own fields adds that owner and its chain. A delete of an owner removes it from the set: its delete entry and deliveries are the aggregate's last state, and it is never finalized. Deleting a part still adds the part's remaining owners.

**Finalization: settle in memory, then persist once.** When the outermost save of the operation has finished its after-write phase (4.1 step 10), the save stack is empty. Before commit the record service finalizes the touched set:

1. **Settle.** The settling set starts as the touched set. Each pass runs the aggregate rules (4.10) of every owner in the settling set, innermost first, and each owner's rules in rule order, on in-memory images that every proposal updates at once. The rules see the following, through the aggregate-rule profile (5.10): the owner's current image; its image at the start of the transaction, as `previous`; its parts as locked plus all proposals; `partsChanged.C`; and the quantifiers `anyPart` and `allParts`. They may propose new values for the owner's fields and its parts' fields, and new parts of that owner (14.4 creates approvals this way). They cannot delete records or touch another aggregate. A proposal that changes or creates a record which is itself an owner of parts (a request item, which owns its approvals) enrolls that record and its owner chain in the settling set, so its rules run in the next pass of the same bounded process. In the same pass, after the aggregate rules, every record whose in-memory image changed (owner or part) also runs its `before` rules of kind `derive` on that image, so their values are part of the settled state and count toward the fixed point. Guards and invariants do not run while settling. A rule declared `once` fires at most once per owner and transaction; the owner's settle state records that it fired, so a condition that stays true (`previous` and `partsChanged` never change within a transaction) cannot fire it again. The fixed point is a pass that proposes nothing. If pass 3 still proposes something, the transaction fails with `AggregateNotSettled` and rolls back [judgment].
2. **Persist.** Then, innermost first, the service writes each changed or created part with an ordinary save as the system effect `aggregate` (4.10), followed by exactly one **aggregate save** of each owner in the settling set whose parts or derived state changed. On these saves, `derive` rules are not applied again, since settling already applied them to the settled image, and `guard` rules are skipped, since system transitions (14.4) belong to aggregate rules alone. `invariant` rules run against the settled image, and so do schema validation, the visibility check, history, deliveries and after-write rules. An invariant that refuses fails the whole transaction with its own error (`RuleRefused` or `InvalidTransition`, with the rule's fixed message), and everything rolls back, the user's triggering write included [judgment]. A write into an owner already persisted in this transaction is `AggregateNotSettled`.
3. **Cascades.** After-write rules of aggregate saves may write other aggregates, for example a completed change updating services. The owners those writes touch are finalized in turn, settle then persist. An owner is persisted at most once per transaction, and a write into an owner that was already persisted is `AggregateNotSettled`.

**The aggregate save** is a named kind of save in the pipeline (4.1):

- It is never a no-op, even when no field changed: the owner's version goes up by 1, `updated_at` and `updated_by` are set, one change entry is written, and its deliveries are written.
- The change entry is kind `update`. Its `fields` hold only the derived fields that changed. Its `cause` is `{"aggregate": {"reason": "parts" | "derived" | "both", "parts": [<change IDs of the part writes>]}}`.
- Derived fields and the parts' system-written fields are written as the system effect: like auto-numbers (6.5), they need no write right of the acting user. They are still validated, and the proposed-state access check runs on the owner for visibility only.
- `RecordInSave` keeps its meaning (4.1). Finalization runs only when the save stack is empty, so no owner is saved while on the stack. A save of an owner that writes its own parts never re-saves the owner from inside. A request's submit, for example, only sets the request's status; its aggregate rules move the items, and the request is persisted once afterwards.

**Results.** An owner changes by exactly one aggregate version per transaction that changed any of its parts or its derived state. It gets one more version for each of its own field saves in that transaction; the TMF adapters save an owner's own fields at most once per write. So the ETag, history and events of an aggregate change exactly when the aggregate does, and the version invariant (4.2) holds. Ordering (4.7) is unchanged: an aggregate save is a version like any other.

### 4.10 Record rules and their actions (Step 3)

Record rules are config records (`core.record_rule`): stable ID, owner layer, covered by the schema revision, shipped in sets or written by admins through change sets; `active` is overridable (8.2). Workstream 3A builds exactly this, which is enough to declare every shipped rule of Contracts 14 [judgment].

| Property | Meaning |
| --- | --- |
| `class` | The class it is attached to; it applies to that class and its descendants, chosen by the concrete class (4.1) |
| `phase` | `before` (before-write), `after` (after-write), `afterCommit` (from a delivery, 4.6), `aggregate` (when records of the class are settled as owners, 4.9) |
| `order` | Order number; ties by stable ID |
| `operations` | `create`, `update`, `delete`; not for `aggregate` |
| `condition` | A condition AST in the phase's profile (5.10) |
| `kind` | `before` only, required: `derive` (only `set` actions; runs on users' writes and inside settling, 4.9), `guard` (only `refuse` actions; runs on users' writes only: user-transition guards), or `invariant` (only `refuse` actions; runs on every save, settled saves included). Mixing kinds and actions is `DefinitionInvalid` |
| `once` | `aggregate` only: the rule fires at most once per owner and transaction |
| `runAs` | `after` only: an identity, which needs `rules.run_as` (4.1) |
| `actions` | An ordered list of the kinds below |

Values in actions are a literal; `{"ctx": "now" | "me"}`; `{"copy": <path>}` reading the rule's record (`record.<field>`), the owner (`owner.<field>`, aggregate rules only) or the current source record (`source.<field>`); or `{"increment": <integer field>}`.

| Action | Phases | Effect |
| --- | --- | --- |
| `set` `{values}` | `before`, `aggregate` | Sets fields of the record: the proposed record before the write, or the owner's in-memory image while settling |
| `refuse` `{code, message}` | `before`, `aggregate` | Fails the save (`before`) or the transaction (`aggregate`) with `InvalidTransition` or `RuleRefused` (422) and a fixed message |
| `setParts` `{class, where, values}` | `aggregate` | Sets fields on the in-memory images of the owner's parts of `class` that match `where` |
| `createParts` `{class, forEach?, values}` | `aggregate` | Proposes new parts of the owner: one, or one per record of `forEach` (`{class, where}`, read as system), at most 100 |
| `updateEach` `{forEach, target, values}` | `after`, `afterCommit` | For each record of `forEach` (`{class, where}`; `where` may read `record.<field>`), saves that record (`target: "self"`) or the record its reference field names (`target: {"via": <field>}`) |
| `createEach` `{forEach, class, values}` | `after`, `afterCommit` | Creates one record of `class` per record of `forEach` |

Who acts:

- `before` actions are part of the save, as the acting user; the values they set count as supplied fields (3.9).
- `after` actions are nested saves through the pipeline as the acting user, or as `runAs`.
- `afterCommit` actions run as the subscription's identity, in the delivery transaction (4.1).
- On saves that a user, an API call, an import or an `after` action makes, every `before` rule runs: `derive`, then `guard`, then `invariant`, each kind in rule order. On the saves 4.9's persistence makes, only `invariant` rules run, because `derive` rules already ran inside settling and `guard` rules guard users' writes only.
- `aggregate` actions save nothing when they run: they propose in-memory changes, which 4.9 persists as the system effect `aggregate`. Those writes are not checked against the acting user's write rights, but they are validated as usual. Their change entries carry `actor_id` = the acting user of the operation and `cause` `{"aggregate": {"rules": [<IDs of the rules that proposed the change>], "reason", "parts"}}`, so the audit names both the user and the rules.

### Acceptance tests

- Version invariant property test: random saves, nested saves and deletes through parent and child endpoints give each record entries for exactly versions 1..n, a delete included as the last version.
- No-op save: identical values leave version, `core.change` and `core.delivery` unchanged and call no hook.
- A before-write hook's field change appears in the entry's `after`; a before-write hook that writes another record is rejected.
- An after-write hook that throws after a nested save leaves zero new rows in record tables, `core.change` and `core.delivery`.
- Poisoned transaction: an after-write hook that catches a nested save's `NotAllowed` and returns success leaves zero new rows in record tables, `core.change` and `core.delivery`.
- `RecordInSave`: a hook on A writes B, whose hook writes A; the save is refused and nothing commits.
- Hook identity: an after-write rule writing a record the acting user may not update fails the save; with a run-as identity it succeeds only if the rule's author holds `rules.run_as`.
- No `SAVEPOINT` in the statement log of a save with nested saves.
- Secret canary set via API and import appears nowhere in `core.change`, payloads, reports, logs or errors.
- Rename then purge a field: older entries still resolve label, type and choice labels at their revision through `core.definition_revision`.
- Sequence-cursor regression, SQL level (Step 1): A writes and holds its transaction, B writes and commits, B's delivery is claimed, then A commits; A's delivery row exists and is claimable for every matching subscription.
- Claim order, SQL level (Step 1): two updates to one record in two transactions; n+1 is not claimable until n is `done`, while other records remain claimable.
- Two updates to one record with the first delivery failing twice (Step 3): version n arrives strictly before n+1 while other records continue.
- Lease fencing (Step 3): pause W1 past its lease, let W2 claim and finish; W1's late done or failure changes nothing, and n+1 is claimed only after W2 marks n done.
- Crash before `done` (Step 3): kill the worker right after an after-commit rule's write and before `done`; the rerun makes zero duplicate writes. An external call repeats with the same `change_id`.
- Soak (Step 3): 8 workers, 10,000 deliveries over 500 records; all `done`, never two `in_flight` rows for one subscription and record, version order holds.
- Dead letter (Step 3): under `block` later versions wait and discarding releases them; under `skip` they proceed.
- A delete delivery to a non-admin subscription identity carries the before image filtered for that identity.
- `record-rule-actions` (4.10, Step 3): each action kind in each allowed phase, refused in the others at definition validation; `aggregate` actions write nothing until persistence, and their change entries name the acting user and the proposing rules; `after` actions are refused by access rules exactly as the acting user's own write would be.
- `aggregate-quantifiers` (5.10): property test comparing `anyPart` and `allParts`, with owner paths, against a naive evaluator over generated parts.
- `aggregate-race` (4.9, Step 3): a note added through `/api/v2/helpdesk.ticket_note` races a TMF621 `PATCH` of its ticket, with and without `If-Match`. Neither deadlocks. With `If-Match` on the version before the note, the `PATCH` is `VersionConflict`. The ticket's final version equals 1 + its own field saves + one per transaction that wrote its notes, each version has one change entry and produces its TMF621 event, and no two different states carry the same ETag.
- `aggregate-ownership` (4.9): writing a different owner into an owner reference is `ReadOnlyField`; a second owner reference on a class, a cycle and a fourth level are refused at definition validation; a move done as delete and create in one transaction persists both owners once each; two moves in opposite directions at once both complete, in either order, with no lost or doubled part; a part whose owner was deleted concurrently gets `InvalidReference`.
- `aggregate-finalize` (4.9): settling runs to a fixed point, and each touched owner is persisted exactly once:
  - a rejected change approval cancels the other approvals and rejects the change in one transaction, with one change version and one version per approval;
  - an approval of a request item settles the item and then the request, each persisted once;
  - submitting a request never fails with `RecordInSave`, and gives the request one version for the submit and one aggregate version;
  - an owner-only edit of `planned_start` on a scheduled normal change queues the change, cancels its approvals and moves it to `assess`;
  - the same edit on an emergency change in `authorize`, and on one in `scheduled`, reaches the fixed point in two passes. Each persists the cancelled old-round approvals, the new round's approvals and the change once each, advances `approval_round` by exactly 1, and raises no `AggregateNotSettled`;
  - no `guard` or `derive` rule runs on a persisted save: a spy `guard` and a spy `derive` rule on each class record no call during persistence, while the guards still refuse the same transitions written by a user and the derive rules' values appear in the settled image;
  - an `invariant` rule breaks on a settled image: with a local invariant "`planned_start` and `planned_end` are set when `status` is `scheduled`" and a normal change in `authorize` without `planned_end`, the last approval's settling proposes `scheduled`, the invariant refuses at persistence, and the whole transaction rolls back, the approver's own write included. The approver gets `RuleRefused` with that rule's message;
  - submitting a request with an approval-required item creates that item's approvals during settling, before anything is persisted (asserted with a statement-log check: no write before the last settle pass), then persists the approvals, the items and the request once each;
  - a part-only change with no derived change still gives one aggregate version, its change entry and its deliveries;
  - a TMF `DELETE` of a ticket with notes leaves the notes' and the ticket's delete entries and no aggregate save;
  - an aggregate rule that keeps changing a part ends in `AggregateNotSettled` with nothing committed.

## 5. Conditions

### 5.1 Decisions

- One AST and one set of semantics. Text syntax and the visual builder are two editors of the same AST.
- Two-valued logic: every condition is true or false for every record. Null means "empty", never "unknown". Postgres comparisons with null yield null and `WHERE` drops such rows [checked: [comparison functions](https://www.postgresql.org/docs/18/functions-comparison.html)], so the SQL compiler is defined to match (5.9).
- Unknown exists only in the browser, for data it does not have, and means "ask the server".
- Two evaluators, TypeScript (server and browser) and the SQL compiler, both held to tables 5.4 and 5.9 by the differential test.
- Context values and relative dates are resolved to literals in TypeScript before either evaluator runs, so SQL does no time-zone or calendar math.
- Profiles (5.10) restrict operators, paths, context and where a condition runs.

### 5.2 AST

```ts
type Expr =
  | { op: "and" | "or"; args: Expr[] } // and [] is true, or [] is false
  | { op: "not"; arg: Expr }
  | { op: "true" }
  | { op: "false" }
  | {
      op: "eq" | "ne" | "lt" | "le" | "gt" | "ge";
      left: Path;
      right: Path | Value;
    }
  | { op: "in" | "notIn"; left: Path; right: Value[] | { ctx: "myGroups" } }
  | { op: "empty" | "notEmpty"; arg: Path }
  | {
      op: "contains" | "notContains" | "startsWith" | "endsWith";
      left: Path;
      right: string;
    }
  | {
      op: "inPeriod";
      left: Path;
      period: {
        unit: "day" | "week" | "month" | "quarter" | "year";
        offset: number;
      };
    }
  | { op: "changed"; arg: Path }
  | { op: "anyPart" | "allParts"; class: ClassId; where: Expr }; // aggregate profile only (4.9, 5.10)
type Path = { path: FieldId[]; image?: "previous"; scope?: "owner" }; // more than one ID follows references; scope only inside anyPart/allParts
type Value =
  | { value: Json } // canonical JSON of the left field's type (6.5)
  | { ctx: "me" | "now" }
  | {
      rel: "now";
      unit: "minute" | "hour" | "day" | "week" | "month" | "year";
      offset: number;
    }
  | { rel: "today"; unit: "day" | "week" | "month" | "year"; offset: number };
```

- Conditions reference fields by ID; the text syntax resolves names when parsing and prints names back.
- The left side is a path; the right side is a literal, context value, or (for `eq` to `ge` only) a second path.
- No null literal: emptiness is `empty`. `ne`, `notIn`, `notContains`, `notEmpty` are exactly `not` of their positive form.
- When a condition is stored or edited it is **checked** against a class and a profile: field IDs exist and are not retired, operators fit the type and profile, literals convert under the type's rules (not the field's settings: a decimal literal may exceed the field's scale; a retired (hidden) but existing choice is allowed, checked against the field's whole live list, not a child class's subset [judgment, decision 0017]; an integer outside the type's range is refused).
- The not-retired check applies only when a condition is stored or edited. Stored conditions keep evaluating retired fields, whose columns still exist. Reason: skipping a deny rule that reads a retired field would fail open. Purge stays refused while any non-retired condition reads the field (1.7).
- A **condition field** (6.5) stores conditions as record values. Its definition names the class they apply to and their profile; the profile is `filter`, the only one a record can store (decision 0005, "Condition fields"). A write that changes the value checks it as stored, in the caller's view: a field the caller can never read is unknown, exactly like an ID that names nothing (3.4), and the refusal is `ValidationFailed` with `InvalidValue` reason `invalidCondition` on the condition field, naming no field the condition names. Values hold field IDs, so a rename changes none. A retire leaves stored values as they are, like stored rule conditions; the check applies again when the value is written. Unlike rule conditions, record values have no `condition_reads` edges: nothing keeps a field they name from being retired or purged, and a value naming a purged field fails the check when it is next written. [judgment]
- A text literal that converts to null is refused with a hint to use `empty` [judgment]. `in` lists hold at most 1,000 non-null elements [judgment]. Number literals keep their digits as text and never pass through a JS `number`.

### 5.3 Null, missing and empty

- **Null**: no value, stored as SQL NULL; one empty per type. Text normalizes `""` to null (5.5); for other types `""` is invalid; booleans are never null.
- **Missing**: absent from a partial record; not a value. Only in wire payloads (6.7) and browser partial records.
- On the server conditions run on complete images (an update's proposed image is the stored record merged with the patch). A missing field on the server is a defect, never coerced to false.

### 5.4 Operator semantics

`v` is a non-null literal; `≡` is the type's equality.

| Operator | True exactly when | Types |
| --- | --- | --- |
| `eq(f, v)` | f not null and f ≡ v | all except password, secret, json, condition |
| `eq(f, g)` | both null, or both non-null and f ≡ g | as above, same comparison class |
| `lt`..`ge` `(f, v)` | f not null and relates as stated | integer, big integer, decimal, date, date-time |
| `lt`..`ge` `(f, g)` | both non-null and relate as stated | as above |
| `in(f, [v...])` | f not null and f ≡ some v; `in(f, [])` is false | the `eq` types |
| `empty(f)` | f is null | all except boolean |
| `contains`, `startsWith`, `endsWith` | f not null and key(s) is a substring, prefix or suffix of key(f) | text, long text |
| `inPeriod(f, p)` | f not null and in the resolved [start, end) | date, date-time |
| `changed(f)` | previous and proposed differ under exact stored equality (json: jsonb equality, 6.5) | all |
| `not e` | e is false |  |

- So `ne(status, "closed")` is true when status is empty, `not (due < today)` is true when due is empty, and exactly one of `e` and `not e` holds for every record.
- `contains` with an empty needle is refused at check time. [judgment]
- Equality: text compares by key (5.5); integer, big integer and decimal form one numeric class compared exactly (1.5 ≡ 1.50); date by calendar date; date-time by millisecond instant; choice by key (case-sensitive); reference and uuid by UUID; boolean by value. `changed` uses exact stored values ("alice" to "Alice" is a change).
- No ordering operators on text. Reason: text order depends on collation and locale, which TypeScript and Postgres cannot reproduce identically. Sorting lists by text happens only in SQL.

### 5.5 Text: write conversion and case

The STD database uses UTF8 encoding. `std upgrade` refuses to run otherwise and `doctor` checks it. Reason: `casefold` works only with UTF8 server encoding, and `pg_unicode_fast` is UTF8-only [checked: [string functions](https://www.postgresql.org/docs/18/functions-string.html), [collation](https://www.postgresql.org/docs/18/collation.html)].

Write conversion, on the server in TypeScript, for stored values and `eq`/`in` text literals:

1. Refuse values that are not well-formed Unicode or contain U+0000 (Postgres `text` cannot hold it).
2. Normalize to NFC. Postgres never normalizes.
3. Single-line text: refuse CR, LF, U+2028, U+2029 and control characters (C0, DEL and C1) other than tab; trim with the ECMAScript `trim()` set; `""` becomes null. [judgment: U+2028 and U+2029 are line breaks too; see `docs/decisions/0003-values.md`]
4. Long text: CRLF and CR become LF; no trimming; whitespace-only becomes null.
5. Count length in code points. Needles for `contains`, `startsWith`, `endsWith` get steps 1, 2 and 5 only.

The browser evaluator applies steps 1 to 4 to proposed text before evaluating form rules. If the input contains code points unassigned in the shipped fold table's Unicode version, atoms reading it return Unknown. Reason: `String.prototype.normalize` depends on each browser's Unicode version.

**Case.** Text fields are case-insensitive by default; `caseSensitive: true` turns it off (codes, tokens, external keys). key(x) = fold(x), or x when case-sensitive.

**fold(x)** is Unicode full case folding (CaseFolding.txt, statuses C and F):

- In Postgres: `casefold(x COLLATE pg_unicode_fast)`. The explicit collation pins the implementation, since under libc `casefold` is just `lower`. Postgres 18 ships Unicode 16.0.0 data [checked: [string functions](https://www.postgresql.org/docs/18/functions-string.html), [release notes](https://www.postgresql.org/docs/18/release-18.html)].
- In TypeScript: a fold table generated at build time from Unicode 16.0.0, shipped to server and browser. `toLowerCase` differs (it keeps `ß` and maps final `Σ` to `ς`).
- An exhaustive test over every scalar value proves the tables equal. Folding is context-free, so per-code-point equality implies string equality [checked: `fold-postgres.test.ts` compares every scalar value except U+0000 and surrogates, plus "ΣΑΣ", "Straße", "İ" and 10,000 generated strings, against Postgres 18.6; all equal; `docs/decisions/0003-values.md`].

Why not a nondeterministic ICU collation [judgment]: ICU behavior changes with the ICU version Postgres is built against, Node and browsers ship their own ICU, nondeterministic collations lose B-tree deduplication, and `ILIKE`, `SIMILAR TO` and regular expressions do not support them [checked: [collation](https://www.postgresql.org/docs/18/collation.html), [pattern matching](https://www.postgresql.org/docs/18/functions-matching.html)]. A pinned fold table is reproducible and exhaustively testable.

Deterministic but surprising, identical in both engines: `ß` ≡ `ss`, `ﬁ` ≡ `fi`, `σ` ≡ `ς` ≡ `Σ`; accent-sensitive (`é` is not `e`); no Turkish rule (`İ` folds to `i` plus U+0307); folding is not re-normalized; default-ignorable characters are not ignored.

SQL forms: equality `casefold(col COLLATE pg_unicode_fast) = $1` with the literal folded in TypeScript; pattern operators use `LIKE $1` with a TypeScript-built pattern (fold, escape `\`, `%`, `_`, add `%`). Folded equality and uniqueness use an expression index on the casefold expression [checked: `casefold` is IMMUTABLE, `pg_proc.provolatile = 'i'` in Postgres 18.6; 0F probe 4: the index is built concurrently, used by bound-parameter equality (idx_scan, no seq_scan), and as a unique index refuses `STRASSE` after `Straße` and `σας` after `ΣΑΣ`]. Unique text fields are unique by key [judgment]. A Postgres upgrade with new Unicode data can change folds for newly assigned code points, so the upgrade procedure regenerates the table and reindexes folded indexes, and `doctor` compares the fold table's version with `unicode_version()` [judgment].

### 5.6 Numbers

- Integer (`int4`) is a JS `number`; big integer (`int8`) is a `bigint`.
- Decimal is `{ coefficient: bigint; scale: number }` in STD's values package; comparison rescales and compares bigints. A decimal library is chosen when arithmetic arrives and is tested against Postgres `numeric`. [judgment]
- SQL literals are bound as text with casts (`$1::numeric`). STD's SQL layer reads `numeric`, `int8`, `date`, `timestamp`, `timestamptz`, `json` and `jsonb` in Postgres's text form and parses them itself (`@std/values/postgres-text`). @effect/sql-pg 4.0.5 speaks only the binary format, so STD's SQL layer registers codecs through the driver's `types` registry option that render each binary value exactly as the type's output function does under `DateStyle = ISO` and `TimeZone = UTC` (`@std/server/sql/text-codecs`) [checked: `PgTypes.ts` in @effect/sql-pg 4.0.5, `postgres-text.test.ts`; the 0A smoke test compares every read with `::text`, edge values included; decision 0002]. The built-in codecs differ from the text form: `timestamptz` decodes to a `Date` truncated to milliseconds (sub-millisecond digits are lost silently, years outside JavaScript's range give an invalid `Date`), `date` uses astronomical years for BC, and `json`/`jsonb` go through `JSON.parse` (last duplicate wins, digits rounded); only `numeric` (a string) and `int8` (a `bigint`) are exact. Decimal literals are cast to unconstrained `numeric`, never `numeric(p, s)`, which would round. Reason: driver conversions can lose precision or shift dates. [judgment]
- Literals must fit the type's range. Decimal literals have at most 100 digits [judgment]. NaN and infinities do not exist in STD.

### 5.7 Dates, date-times and time zones

- **Date**: `YYYY-MM-DD`, years 0001 to 9999, proleptic Gregorian; kept as the canonical string, whose order equals date order.
- **Date-time**: UTC instant with millisecond precision, `timestamptz(3)`. Sessions run with `TimeZone=UTC`, `DateStyle=ISO` [checked: the driver's `startupParameters: { TimeZone: "UTC", DateStyle: "ISO" }` sets both in every connection's startup packet; `postgres-text.test.ts`; the 0A smoke test confirms them on pooled and dedicated connections and after `RESET ALL`]. Kept as epoch milliseconds.
- A date never compares directly with a date-time.
- The evaluation context carries `now`, `timeZone` (IANA) and `weekStart` (default Monday). Resolution in TypeScript turns `ctx` and `rel` into literals and `inPeriod` into `ge(f, start) and lt(f, end)`; day and larger offsets are calendar arithmetic in `timeZone`, minute and hour offsets exact durations. The resolver uses Temporal, enabled by default in Node 26 [checked: Node 26 release notes]; the web app uses a pinned polyfill where missing [unverified per browser]. The web app resolves nothing today: its list filters send `rel` and `inPeriod` to the server, which resolves them in the filter profile's zone, and date-time literals are entered and shown in UTC, since the browser knows neither the user's nor the instance zone and never uses the device's [judgment, decision 0020]. Forms enter and show date-time values the same way: a date and a time labelled "UTC" [judgment, decision 0020].
- Time zone: the filter profile uses the user's zone (falling back to the instance zone); every profile that decides what a save may do uses the instance zone. Reason: a preference must not change an access or validation outcome. [judgment] The browser never uses the device zone.
- Tricky cases, each with a resolver test: `now - 1 day` across DST is 23 or 25 hours; days without local midnight start at their first instant (Temporal `startOfDay`); Jan 31 plus 1 month is Feb 28 or 29; browser tz data and clock may differ from the server's, so browser results are advisory; `:60` seconds are refused.

### 5.8 Unavailable data and Unknown

- Only the browser evaluator returns `true | false | "unknown"`. Data is unavailable when a field is not in the loaded record, a path's target fields were not delivered, a changed reference's target is not fetched, a context value was not provided, or text holds code points newer than the fold table (5.5). Null is known data, and so is a field the caller cannot read, which counts as empty (5.10).
- Atoms reading unavailable data are Unknown; `and`, `or`, `not` follow Kleene rules. This is sound because every atom is total.
- On Unknown the UI marks the field state pending and calls the form-state endpoint (6.3). The server's verdict at save time is binding.
- Evaluators do no I/O. Paths are known statically, so callers preload them.

### 5.9 SQL compilation

1. Push `not` to the atoms (negation normal form) using the negated forms below.
2. Emit each atom so its SQL value equals its two-valued value, or is NULL only where it is false.
3. In `WHERE` emit as is; in value positions emit `COALESCE(e, false)`. AND and OR are monotone, so mapping NULL to false at the root equals mapping it at every atom. SQL `NOT` is emitted only over expressions that cannot be NULL.

| Atom | Positive SQL | Negated SQL |
| --- | --- | --- |
| `eq(f, v)` | `k(f) = $v` | `(k(f) <> $v OR f IS NULL)` |
| `eq(f, g)` | `k(f) IS NOT DISTINCT FROM k(g)` | `k(f) IS DISTINCT FROM k(g)` |
| `lt(f, v)` (and `le`, `gt`, `ge`) | `f < $v` | `(f >= $v OR f IS NULL)` |
| `lt(f, g)` | `f < g` | `(f >= g OR f IS NULL OR g IS NULL)` |
| `in(f, list)` | `k(f) = ANY($a)` | `(k(f) <> ALL($a) OR f IS NULL)` |
| `in(f, [])` | `FALSE` | `TRUE` |
| `empty(f)` | `f IS NULL` | `f IS NOT NULL` |
| pattern ops | `k(f) LIKE $p` | `(k(f) NOT LIKE $p OR f IS NULL)` |

- `IS [NOT] DISTINCT FROM` is null-safe [checked: [comparison functions](https://www.postgresql.org/docs/18/functions-comparison.html)] and used only field-to-field; literal comparisons use `=` to stay indexable [checked: `sql-postgres.test.ts` "[spike] literal eq and in use the field's index on every comparable kind": on 20,000 rows in Postgres 18, `eq` and `in` with bound literals use the field's B-tree index, with no sequential scan, for case-sensitive text and long text, integer, big integer, decimal, boolean (`eq` only), date, date-time, uuid, reference and choice, and the casefold index for case-insensitive text; the same literal under `IS NOT DISTINCT FROM` gives a sequential scan; decision 0005].
- Paths compile to one `LEFT JOIN` per distinct reference prefix, so a null reference yields null, as in TypeScript. Paths may name fields of the declared target class and its ancestors only.
- The compiler accepts a guard per joined path, which authorization uses to apply target visibility and masks (3.6).
- Every value is a bound parameter; identifiers come only from definitions.

### 5.10 Profiles

|  | Filter | Access rule | Form rule | Record rule | Subscription |
| --- | --- | --- | --- | --- | --- |
| Used for | lists, API `filter`, picker limits | allow and deny conditions | conditional required, read-only, hidden | before and after conditions | which changes create deliveries |
| Operators | the 5.2 operators except `changed` and the quantifiers | the 5.2 operators except `changed` and the quantifiers | the 5.2 operators except the quantifiers | the 5.2 operators except the quantifiers (`aggregate` record rules add them, below) | the 5.2 operators except `changed` and the quantifiers |
| `previous` | no | no | yes | yes (all-null on create) | no |
| Context | me, now, myGroups (Step 4) | me, now, myGroups (Step 4) | me, now | me, now | now only |
| Time zone | user's | instance | instance | instance | instance |
| Path hops | 1 | 0 in Step 1, 1 from Step 4 | preloaded paths only | up to 3, preloaded as system | 0 |
| Fields | caller's readable fields on every hop (3.4) | all, as system | caller's masked image: unreadable fields count as empty | all, as system | all, as system |
| Evaluated in | SQL (authoritative), server TS allowed | SQL, for reads and for both write checks (3.9); server TS only for explain mode and tests | browser (advisory), server (binding) | server TS | server TS |

- The same access-rule condition is checked against both existing and proposed states (3.9), in SQL in both cases. TypeScript evaluation of access-rule conditions is used only by explain mode and by tests; the differential test holds it to the SQL.
- Form rules evaluate the proposed image with `previous` for the stored one. They are evaluated for a caller over the masked image: fields the caller cannot read on the record count as empty, as in 3.5, in the browser, in form-state and at save. Before sending a rule to the browser, the server substitutes empty for fields never readable by the caller and simplifies, so a sent rule names no hidden field. So form-rule outcomes reveal nothing about hidden values [judgment]. Form rules are UX constraints; security belongs in access rules.
- On create `changed(f)` equals `notEmpty(f)`; on delete `changed` is false.
- Aggregate rules (4.9, 4.10, from Step 3) use the record-rule profile, with `previous` meaning the owner's image at the start of the transaction. They also read, per part class C, a synthetic boolean `partsChanged.C`, true when a part of class C was created, updated or deleted in this transaction. And they use the quantifiers `anyPart(C, where)` and `allParts(C, where)`, evaluated over the owner's in-memory parts of class C; `allParts` over no parts is true, `anyPart` false. Inside `where`, paths read the part, and a path with `scope: "owner"` (`owner.f` in the text syntax) reads the owner. Aggregate conditions are evaluated in TypeScript only, on in-memory images, and are never compiled to SQL, so the differential test (5.9) does not cover the quantifiers; their own property test compares them with a naive evaluator [judgment].
- `myGroups` may appear only as `in(f, myGroups)`.

### Acceptance tests

- Differential property test against Postgres 18 (fast-check [judgment]): generated classes covering every condition-capable type, both case settings, a child class and a reference; rows from edge pools (`ß ẞ ss`, `İ i ı I`, `Σ σ ς`, `ﬁ`, NFD, astral, ZWJ emoji, `% _ \`, whitespace; int4 and int8 limits, ±(2^53 ± 1), decimal limits; 0001-01-01, 9999-12-31, Feb 29; DST instants in America/New_York, Europe/Berlin, Australia/Lord_Howe, Asia/Kathmandu, Pacific/Apia; null references); expressions to depth 6. TypeScript on read-back rows, SQL `WHERE` and `COALESCE(e, false)` agree; `e` and `not e` partition the rows. Failures are shrunk and saved as fixtures. About 60 s per PR, 30 min nightly [judgment].
- Coverage gate: a run fails if any permitted (operator, type, profile) combination was generated zero times, for every profile including Subscription.
- Browser soundness: with random fields or targets removed, the result equals the full result or is Unknown, and is Unknown only if removed data was read. Inputs include unnormalized (NFD), padded and CRLF text.
- Fold equality for every scalar value except U+0000 and surrogates; `LIKE` escaping for every ASCII character.
- `name = "STRASSE"` matches stored "Straße"; `name = "i"` does not match "İ", in both engines.
- `in(f, [])` matches nothing and `notIn(f, [])` matches every row, as constants in the SQL.
- Compiler fuzz: SQL text never contains an AST literal. Parser: `parse(print(a)) = a`; fuzzed input yields typed errors with positions.
- `inPeriod(day, 0)` in Europe/Berlin on 2026-10-25 resolves to 25 hours; an access rule using `today` gives the same decision whatever the user's time-zone preference.
- EXPLAIN: equality on a unique case-insensitive field uses its casefold index.
- `quantifier-profiles` (Step 3): `anyPart`, `allParts` and an `owner.` path are refused at check time, with a typed error naming the operator, in a list filter, a saved filter, a condition field's value, an access rule, a form rule, a `before`, `after` or `afterCommit` record rule and a subscription; they are accepted only in an `aggregate` record rule.
- `retired-condition` (Step 1): retire `status` while rule 6 reads it; `purchased_on` on Bob's lost asset S stays hidden from him, and purge of `status` is refused.
- A form rule comparing a writable field with a field the caller cannot read gives the same outcome in form-state and at save whatever the hidden value.

## 6. Interfaces, field types and JSON

### 6.1 Three interfaces

| Interface | Consumers | Contract | Types come from |
| --- | --- | --- | --- |
| Generic admin UI | list and form pages, filter builder | runtime metadata (6.3) and runtime validation | metadata fetched at run time |
| Fixed platform endpoints | web app, CLI, SDK | one Effect `HttpApi` definition in a shared package; clients use `HttpApiClient.make` on it; OpenAPI 3.1 generated from it (`GET /api/v1/openapi.json`) [checked: `OpenApi.fromApi` in `effect/http-api` 4.0.5, decision 0014] | compile time |
| Application SDK | app code for known tables | types generated from a versioned schema snapshot (6.8) | generated code in the app's repo |

- `HttpApiClient.make` exists in Effect v4 [checked: [v4 API docs](https://effect.website/docs/v4/api)]; import paths follow the vendored source. It is tagged unstable, so the shared API-definition package and the web app allow `effect/http-api` and `effect/http` (9).
- Fixed endpoints: sign-in (bearer and cookie forms), sign-out, the current session (`GET /api/v1/auth/me`: user ID, display name and effective roles), metadata (the table list `GET /api/v1/meta/tables`, a table's metadata and its OpenAPI document, 6.3), snapshot, form-state, schema-change operations. Generic record routes (`/api/v1/tables/{table}/records`) have a fixed envelope (6.6); `values` are typed only at run time.
- Decision: table types are static only in generated SDK code. Reason: a deployed browser cannot gain compile-time types for a table created at run time.

### 6.2 Schema revision on the wire

- Every response, errors included, carries `STD-Schema-Revision: <n>.<change_set_id>`; record and list bodies carry `schemaRevision` as the number. Reason: after a restore the same number can be reached through different changes.
- Requests may send `STD-Schema-Revision`, the revision their form, query or SDK was built at. The web app and SDK always send it; plain API clients may omit it and get no stale detection [judgment]. The web app sends, with each request, the revision of the metadata that request was built from (a list page's or form's own metadata, read from that metadata response's header); requests built from no metadata send the latest revision the app has seen, and only start-up's `auth/me` and sign-in send none [judgment, decision 0020].
- Role membership changes are not revisions; access-rule changes are, but are not a relevant change kind (6.4).

### 6.3 Metadata and validation

`GET /api/v1/meta/tables/{table}` returns the effective metadata for the acting user, generated from effective definitions (8.2) at the current revision and filtered by access, cached per (revision, change_set_id, effective role set) [judgment]. Not cached in Step 2: it is computed from the cached snapshot per request. `GET /api/v1/meta/tables/{table}/openapi.json` is the same caller's OpenAPI 3.1 document for that table's record routes, built from the same metadata, with `info.version` `<n>.<change_set_id>` and `x-std-schema-revision` (decision 0017). A stated older revision is served, since stale clients fetch metadata to refresh; a malformed one is `InvalidSchemaRevision` and one the database never had `SchemaChanged` [judgment].

`GET /api/v1/meta/tables` lists the tables the caller can open: `{ schemaRevision, tables: [{ name, label, creatable }] }`, sorted by name. A table is listed exactly when its metadata answers 200 for the caller (retired tables included, purged and unknown ones not), with that metadata's `name`, `label` and `creatable`; both come from one function, so they cannot drift. The response is byte-identical, apart from `schemaRevision`, when a table the caller cannot see is added, renamed or relabeled. Revisions are checked as for a table's metadata. [judgment, decision 0020]

- Contains: class ID, name, label, ancestors, whether creatable, display field; per field: ID, name, label, type, inherited-from, required, read-only, nullable, static default, type settings, choices (key, label, order, retired), `read` and `write` as `yes`, `no` or `perRecord` (`write` is `{create, update}`; `no` also for read-only and retired fields, a table that accepts no writes, and platform tables the generic routes refuse) [judgment]; auto-number prefix; the form and list layouts (6.3a); the saved filters the caller may use (6.3b, optional property `savedFilters`); form rules, with never-readable fields substituted as empty (5.10); `relatedLists`; `schemaRevision`.
- `relatedLists` [judgment, decision 0020]: `{ table, label, field, fieldLabel }` per active reference field, on a table the caller can open, that can point at this table's records (its target is this table or one of its ancestors) and that the caller can read there (`read` `yes` or `perRecord`); `table`, `label` and `fieldLabel` are as that table's metadata shows them. A field inherited by several tables is listed once, on the most general one that has it and that the caller can open (its endpoint lists its descendants' records too). System fields (`created_by`, `updated_by`) are not listed. Ordered by table name, then field name. The web app lists related records with `GET /tables/{table}/records?filter=<field> = "<id>"`, which every listed entry accepts for that caller, below an existing record's form, one closed disclosure per entry, loaded when opened, with keyset paging [judgment, decision 0020]; a related table with no column to show is asked for `fields=id` and lists each record's ID [judgment, decision 0020]. It names no table, field or label the caller cannot see.
- Never contains: never-readable fields, access-rule or record-rule conditions, a reference's allowed-records condition (or whether it has one, 6.5), computed default expressions, secret values. A table the caller has no allow on is `UnknownTable`, byte-identical to a missing one apart from its name; a reference or condition field names its table only when the caller knows it (otherwise `null`), never by ID.
- One builder, `recordSchema(metadata, mode)` (`create`, `update`, `read`), in a plain package using Effect Schema (`@std/definitions/record-schema`; `@std/api` serves its metadata Schema from `@std/definitions/table-metadata`). The server runs its field rules (`@std/definitions/record-rules`) on full definitions, the browser on filtered metadata, so verdicts agree for every field both see. An update is validated with the metadata of the record's concrete class (record JSON's `class`), whichever endpoint it goes through, because the server applies the concrete class's overrides (2.2 item 5): the browser fetches that class's metadata, and `recordSchema` refuses metadata of another class for an update (`through` names the endpoint whose names the body uses) [decision 0017].
- Server-only checks: uniqueness, reference existence, visibility and allowed-records condition (6.5), access and record rules, a condition value's check against the caller's view of its class (`invalidCondition`) [judgment: the metadata of one table does not carry another table's visible schema], form rules the browser could not evaluate, stale revision and version.
- `POST /api/v1/tables/{table}/form-state` returns per-field required, read-only and hidden outcomes for proposed values. Outcomes are computed over the caller's masked image (5.10), so they reveal nothing about fields the caller cannot read.

### 6.3a Layouts

- A layout (`core.layout`) is a config record: table, type (`form` or `list`) and an ordered element list; form layouts hold field and section elements, list layouts field elements only, each field once. One live layout per table and type. Elements name fields of the table or its ancestors by ID, so renames never break them. [decision 0017]
- A table without its own layout uses its nearest ancestor's; a layout is replaced as a whole, by a child table's own layout or by a local override of its element list (8.2). [judgment]
- Metadata serves the effective layout for the caller: only active fields the caller can read, sections without fields dropped. Retiring a field a layout uses is allowed and reported (1.7); a purged field's entry stays in the stored layout (it does not block the purge) and is skipped when served; a table purge takes its layouts along. [judgment]
- Without a list layout (or when the caller can read none of its fields), the web app's list shows the display field, then the other active fields in metadata order, leaving out long text, json, condition, password and secret, at most six [judgment, decision 0020]. When that leaves no column (no display field, and only such fields), the list asks for `fields=id` (never an empty `fields`, which the API refuses) and shows each record's ID as its only column, linking to the record's form [judgment, decision 0020].

### 6.3b Saved filters

- A saved filter (`core.saved_filter`) is a config record: table, name (unique among the table's live filters), label and a condition AST (5.2) that names fields by ID, so renames never break it; stable ID, owner layer, covered by the revision. Shipped in sets and written by admins through the generic routes or the change-set endpoint as change sets (1.4). Its condition is checked when stored under the `filter` profile (5.10) against its table with full access. [judgment, decision 0019]
- Metadata serves the saved filters of the endpoint table and its ancestors that the list API would accept from the caller: checked against the caller's view (readable fields on every hop, retired fields refused), so a filter naming a field the caller cannot read is left out whole, exactly like one naming a missing field. Each entry carries its ID, name, label, table, the AST and the condition in the text syntax with current names, as the list API's `filter` takes it. [judgment, decision 0019]
- The list page offers the served saved filters in a select; choosing one loads its AST into the filter builder and applies it, so the list request prints the same condition the entry's `filter` text holds [judgment, decision 0020].
- Per-user filters (ServiceNow's personal filters and favourites) are data, not config, and are not in v0.1.

### 6.4 Stale requests

Request revision R (number and change set ID), current revision C:

- A malformed header gets `400 InvalidSchemaRevision`.
- If R's number is above C's, or R's change set ID differs from the journal's change set at that number, the response is `409 SchemaChanged` with kind `unknown` for every field in scope. Reason: after a restore the client's revision does not describe this database; it reloads.
- Names in the request are resolved against the definitions at R (4.4). So a form built before `foo` was renamed to `bar` and a new `foo` was created still means the old field.
- R < C: the server reads journal entries in (R, C] touching the request's scope: the class and its ancestors; for writes, every field in the payload plus, on create, fields that became required without a default; for reads, every field in filter, sort, selection and labels, and a picker's `allowedFor` reference field on its own table (6.5). An entry is also relevant if its old or new name equals any field name in the request (1.5).
- `choicesChanged` (Step 2): a choice of the field added, hidden, shown again or deleted, or an override subset on a class in the request's reach changed (a create: the endpoint class and its ancestors; reads, updates and deletes: also the endpoint's descendants, whose records they reach); a choice's label or order is not relevant. Any choice change of the field counts, even one outside the class's subset [judgment, decision 0017].
- Relevant kinds: `fieldAdded` (required without default, creates only), `fieldRenamed`, `fieldRetired`, `fieldPurged`, `typeChanged`, `settingsChanged`, `choicesChanged`, `requiredChanged`, `readOnlyChanged`, `tableRetired`. Labels, layouts, display field, new optional fields, access rules and other classes are not relevant, except a new field that takes a name used in the request.
- Any relevant change returns `409 SchemaChanged` with `requestRevision`, `currentRevision` and `changes` (`table`, `field`, `fieldId`, `kind`, `revision`). `changes` lists only fields the caller can name at C; a request name that resolves to no such field gets `UnknownField`, as in 3.4. It is checked before validation, access and version checks.
- The UI reloads metadata, keeps valid values, marks changed fields and asks the user to resubmit; it never resubmits automatically [judgment]. A newer revision on any response, or `NotAllowed`, triggers a background metadata refresh. A read refused with `SchemaChanged` is asked again after the refresh, since repeating a read changes nothing [judgment, decision 0020].
- The web app's form after `SchemaChanged` on a save [judgment, decision 0020]: it reloads the endpoint's metadata by itself (and the record, at the new revision) and does not save while that runs. Edits are kept by field ID, so a renamed field's edit is sent under its new name. An edit the new definitions still let the form send stays in its control; if its value no longer validates (a choice no longer offered, a tighter setting, a field now required) the client's verdict flags it and holds the save back until the user fixes it. An edit the form can no longer send is dropped with a note naming the field, why (removed or no longer readable, retired, now read-only or not writable, a type its input no longer fits, withheld or not delivered by the reread record) and what the user had entered (never a password or secret). Each field a refusal's `changes` names is marked with what changed; the marks and notes stay until a save succeeds, and the form waits for the user to save again. The same reconciliation runs when a background refresh moves the metadata. A delete or a history read refused with `SchemaChanged` reloads the metadata too (the history is then asked again; the delete is not).
- The web app's form also [judgment, decision 0020]: saves only a record read (or saved) at its metadata's revision; when the reread after a metadata change does not load, Save stays disabled, with "Reload the record", so values are never sent under the old record's names. Edits made while a save is in flight survive its success, on top of the saved record (only edits equal to what the save sent are cleared); after a create the page becomes the new record's form, keeping them. When the metadata moved to another revision while the save was in flight, the edits are not compared by name with the saved record: the record is read again under the current metadata, which reconciles them. The concrete class's metadata reconciles the edits again when it arrives (only an answer asked at the metadata's current revision counts), so a field the class makes read-only drops its edit with a note whichever arrives first. A reference picker's search or a related list's page refused with `SchemaChanged` (a related list's also with `UnknownField`) reloads the metadata it was built from (the form's, and the target's or the related table's) and is asked again once they loaded successfully, the related list with the back-reference field's current name; a related list keeps its identity across a rename of its back-reference. The edits are judged (kept, or dropped with a note) only against a record read or saved at the metadata's revision: whatever arrives while the record is not (definitions, the class's metadata, a save's answer) is stored and judged once, when the record is read under the current metadata. Every related list, and every request for a target table's metadata, has an identity that is never reused while the page lives (a list ID with its request numbers; a request number per target table), so an answer reaches only what asked for it.
- If the journal no longer reaches R, every field in scope counts as changed with kind `unknown`.
- Scopes by path [decision 0014]: a delete names no field, so only changes to its table are relevant. History shows the record's fields by current name, so its scope is the endpoint's default selection plus the field IDs of its `field` filter; once the record proved visible, also the default selection of its concrete class, whose child-only fields it shows through any endpoint (2.3). The OpenAPI document (`GET /api/v1/openapi.json`) and a change set's journal (`GET /api/v1/schema/change-sets/{id}`) are checked like sign-in, the journal before its entry is looked up. Sign-in and `auth/me` name no table or field: a malformed header is `InvalidSchemaRevision` and a revision the database never had is `SchemaChanged` with no changes, but no change since an older R is relevant. Sign-out checks only the header's format, so a stale client can always end its session [judgment].

### 6.5 Field types

The representation of every type is fixed in Step 1, including types implemented later.

| Type | Postgres | JSON out | JSON in | TS value | Empty |
| --- | --- | --- | --- | --- | --- |
| text | `text` + CHECK | string | string per 5.5; max length default 255, limit 4,000 code points [judgment] | `string` | null |
| long text | `text` | string | per 5.5; at most 1,000,000 code points [judgment] | `string` | null |
| integer | `int4` | number | integral JSON number in range | `number` | null |
| big integer | `int8` | string `-?(0\|[1-9][0-9]*)` | string only | `bigint` | null |
| decimal(p, s) | `numeric(p, s)`, 1 ≤ p ≤ 38 [judgment] | string with exactly s fraction digits | string; refused if not exact at scale s; never rounded; `-0` becomes `0` | `Decimal` | null |
| boolean | `boolean NOT NULL DEFAULT false` | `true`/`false` | `true`/`false` | `boolean` | never null [judgment] |
| date | `date` | `"YYYY-MM-DD"` | same; years 0001 to 9999 | branded `string` | null |
| date-time | `timestamptz(3)` | `"YYYY-MM-DDTHH:mm:ss.sssZ"` | RFC 3339 with `Z` or offset; digits past the third must be zero; no `:60` | epoch ms | null |
| choice | `text`, no database CHECK | key | an active key of the concrete class's effective list (`core.choice`, minus hidden ones, within override subsets); an unchanged hidden key is kept; a key outside the subset is `unknownChoice` | `string` | null |
| reference | `uuid`, FK `ON DELETE NO ACTION` (3.10) | lowercase UUID | UUID, any case, hyphenated | branded `string` | null |
| uuid | `uuid` | lowercase UUID | as reference | branded `string` | null |
| password | `text`, one-way hash | `{"set": bool}` | plaintext, hashed by the service | not readable | `{"set": false}` |
| secret | `bytea`, encrypted envelope, key outside the database | `{"set": bool}` | plaintext; `null` clears | not readable | `{"set": false}` |
| json | `jsonb` | any JSON value, keys in jsonb's order | finite numbers exactly representable as a double, integers within ±(2^53 - 1), no duplicate keys, no U+0000, nesting at most 1,000 deep, at most 1 MiB of canonical UTF-8 text [judgment]; `null` is SQL NULL | `unknown` | null |
| condition | `jsonb` | AST (5.2) | AST checked against the field's class and profile, in the caller's view (5.2) | `Expr` | null |

- Big integer and decimal are strings because common JSON parsers lose precision; JSON numbers are refused, not converted [judgment].
- Json: duplicate keys and numbers not exactly representable as a double are refused, because `jsonb` keeps the last duplicate and keeps digits that `JSON.parse` rounds. The canonical output is jsonb's key order (shorter UTF-8 byte length first, then bytewise), written by `stringifyJson` because JS objects put integer-like keys first. A number is exactly representable when its literal denotes the same decimal value as the shortest round-trip form of the double it parses to, so `0.1` is accepted and `0.1000000000000000055511151231257827` is refused; integral values beyond ±(2^53 - 1), such as `1e300`, are refused as well. `jsonb` refuses `\u0000` itself. Both engines compare json values by jsonb equality. [judgment]
- Choice keys: 1 to 63 characters of `[a-z0-9_]`, starting with a letter or digit; validated by the record service so lists change without DDL [judgment].
- Choices are config records (`core.choice`: field, key, label, order, hidden; stable ID, owner layer, covered by the revision). Keys never change, so stored values keep their meaning; "retired" in metadata and in 5.2 means `hidden`. A child class restricts a parent's list only through an override subset (2.5). Reads return the key; labels come from metadata (6.3) and history resolves them at the entry's revision (4.4). [decision 0017]
- **Auto-numbers.** A text field with `numberPrefix` is numbered by the record service on create, in the save transaction: `<prefix><n>`, n zero-padded to 7 digits and wider past 9,999,999, from `core.number_counter` keyed by (field, prefix) with one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per number, so concurrent creates never share a number and a hierarchy never repeats one, whichever classes use the prefix. Gaps are allowed (none come from rollbacks, since the counter row is transactional). A prefix ends with a character that is not a digit (`^[A-Za-z][A-Za-z0-9_-]{0,15}$` and not ending in 0-9), so `<prefix><n>` is unambiguous past 7 digits (`A` with 10000001 can never equal `A1` with 0000001). A child class replaces the prefix with an override; a prefix change does not renumber. The backfill step locks rows `FOR NO KEY UPDATE` before taking the counter, so creates whose foreign keys need `KEY SHARE` on those rows never deadlock with it. The field is read-only for every caller, never required, has no default, and auto-numbering cannot be switched on or off after the field exists; the value is ordinary text in the API (`"number": "INC0001001"`) and metadata names the prefix. [judgment, decision 0017]
- Adding a boolean field relies on `ADD COLUMN ... NOT NULL DEFAULT false` being catalog-only with no verification scan [checked: 0F probe 5 on 1,000,000 rows: `relfilenode` unchanged, 0.4 ms for the statement and 4.1 ms for the config commit, `seq_scan` unchanged; a volatile default rewrote the table in 448 ms; checked: `change-sets.test.ts` on 1,000,000 rows, also for `integer NOT NULL DEFAULT 1`: `relfilenode` unchanged, `seq_scan` unchanged, main transaction 3 ms; decision 0006].
- System date-times come from one clock reading per transaction, already in whole milliseconds.
- Password and secret conditions may use only `empty` and `notEmpty`, server-side.
- Type settings: text and long text take `maxLength` and `caseSensitive`; integer, big integer and decimal take `min` and `max`, decimal also `precision` and `scale`; a reference names its target class (`targetClassId`; `target: <table>` in set files); a condition names the class whose fields its conditions may name (`classId`; `class: <table>` in set files) and its profile, which must be `filter` (5.2). Both class settings are required, must name an active class when the field is created, and add a dependency edge (1.7). Neither can be overridden or changed later. A reference may also be declared `aggregate: true` (from Step 3, decision 0021): it is then its class's owner reference, and its records are parts of the target (4.9). The setting is fixed at creation; the ownership rules (one owner reference per class, required, read-only after create, no cycle, at most 3 levels) are in 4.9.
- **Allowed-records condition** [judgment, decision 0020]. A reference may also carry `allowedRecords`: a condition AST (5.2, field IDs) over its target class that every newly written target must satisfy; absent or null means none. In set files it is written like access-rule conditions there, as a JSON AST with field IDs (`type: { kind: reference, target: <table>, allowedRecords: <AST> }`). It is checked under the `filter` profile when it is stored (the field is created or the setting changes): field IDs exist on the target class or its ancestors and are not retired, operators fit, literals convert, one reference hop, `me` and `now`. Unlike the target, it may change after the field exists (a field's `type` may change in this setting only; any other type change stays `unsupportedChange`), and a set version may change it; a change is `settingsChanged` (6.4). It is not overridable locally on a shipped field in v0.1. It adds `condition_reads` edges like a stored rule condition (1.7): retiring a field it reads is allowed and reported, and the condition keeps evaluating the retired field; purging a field it reads is refused while the reference field is not retired.
  - Writes: when a create or update writes a non-null reference value (a written field, 3.9: changed, or not readable by the caller), the target must be visible (3.6) and satisfy the condition, evaluated in SQL in the caller's view (filter semantics: a field of the target the caller cannot read counts as empty, a conditionally readable one is masked per record, 3.5), with `me` and `now` as for filters; otherwise `InvalidReference`, byte-identical to an unknown ID, and nothing is written. An unchanged readable value is kept even when it no longer satisfies the condition, like an unchanged hidden choice key. Writes that bypass access rules (the system's own, `WriteAccess.allowAll`) do not apply it.
  - Pickers: `GET /api/v1/tables/{table}/records?allowedFor=<sourceTable>/<field>` ANDs the field's condition, compiled in the caller's view over the listed records, to the request's filter (and its count). The source table resolves like an endpoint (`UnknownTable` when the caller cannot name it), the field like a write body's name (readable or writable there, else `UnknownField`, identical to a missing field); a value that is not `<table>/<field>`, a field that is not a reference, or an endpoint that is not the field's target class or one of its descendants is `InvalidRequest` naming `allowedFor`. A field without a condition adds nothing. The response never shows the condition, and the source field is in the request's stale scope (6.4).
  - Metadata never shows the condition or whether one exists: it may read fields the caller cannot read, and the picker always sends `allowedFor`.
  - A condition that no longer checks against the configuration (or does not decode) allows nothing: it fails closed, like a stored access-rule condition.
- History stores canonical JSON with the schema revision (4.2).
- Deliberately later: duration, time of day, currency, multi-choice, multi-reference, attachment, comment log, rich text, email, URL and phone formats.

### 6.6 Record JSON

This is the `/api/v1` shape, frozen from Step 3; `/api/v2` uses the TMF630 representation of 10.2.

```json
{
  "schemaRevision": 1240,
  "record": {
    "id": "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f",
    "class": "helpdesk.incident",
    "version": 7,
    "values": {
      "number": "INC-1001",
      "priority": "2",
      "assignee": "01920c4e-0000-7000-8000-000000000001",
      "estimate": "12.50",
      "due": "2026-10-23",
      "opened_at": "2026-10-20T08:15:30.123Z",
      "active": true,
      "description": null
    },
    "labels": { "priority": "High", "assignee": "Alice Smith" },
    "withheld": ["salary"]
  }
}
```

- `id`, `class` (concrete class) and `version` are envelope members; filters reach them as paths. A write body naming them gets `ReadOnlyField`. The expected version travels in `If-Match` (6.7).
- `values` is keyed by field name; a followed reference appears under its dotted path. A value's shape depends only on its type.
- `labels` only on request (`labels=true`); absent when not permitted (3.6), never a placeholder.
- A path value (`docked_to.name`) is null when the reference is empty or its target or field is hidden, like a label it does not tell these apart; the key is absent only when the reference itself is withheld. [judgment, decision 0008]
- Through a parent endpoint, single reads show the endpoint's fields too (2.3); `class` names the concrete class.
- An absent key means "not delivered". `withheld` lists selected fields omitted by access rules on this record, so the UI shows "restricted"; it reveals nothing the absent key does not. `null` always means a stored empty.
- Lists: `{ "schemaRevision", "records", "nextCursor", "count" }`. `nextCursor` is null on the last page. `count` is present only on request (`count=true`) and is computed with the page's `FROM` and `WHERE` (3.5).

### 6.7 Writes: absent versus null

| Payload    | Create                    | Update            |
| ---------- | ------------------------- | ----------------- |
| key absent | default, otherwise null   | unchanged         |
| `null`     | null, default not applied | cleared           |
| value      | converted per 6.5         | converted per 6.5 |

- `PATCH` and `DELETE` require `If-Match: "<version>"`, the version the change is based on. Missing gives `428 VersionRequired`; a stale value gives `VersionConflict`. Reason: the body holds only values, so `ReadOnlyField` stays a simple rule. [judgment]
- All field errors are returned together in `ValidationFailed`. Text `""` becomes null before the required check.
- The web app's form [judgment, decision 0020]: an update sends only the fields whose value differs from the record as read, a cleared field as `null`; a create leaves out every field the user left at its default (or empty), and sends `null` for one the user cleared. It sends `If-Match` with the version the form was read at and `STD-Schema-Revision` with the revision of its own metadata, never retries a refused write, and after `VersionConflict` keeps the user's input and rereads the record only when the user asks, marking the fields someone else changed. Password and secret values are sent only when typed (a secret's "clear" sends `null`) and are never shown, prefilled or kept in the page state as plain text. The client does not hold a write back for a `Required` field the user cannot write in that mode (`write` is `no`, such as a definition's owner layer and state, which the server sets), and on a definition table it does not offer a change the schema engine refuses for that record although metadata says `perRecord` (a field definition's `type` unless it is a reference, whose type may change only in `allowedRecords`; a set `required`; an absent `number_prefix`).

### 6.8 Application SDK (Step 5)

- `GET /api/v1/schema/snapshot?namespace=helpdesk` (needs the `schema.snapshot` permission, 3.1) returns `snapshotFormat`, `schemaRevision` and tables with full field definitions, IDs and a per-table fingerprint.
- `std schema pull` writes it into the app's repo; `std codegen` emits read, create and patch types, Effect Schemas, field constants and a typed wrapper. Read properties are optional (withheld or unselected); `| null` only for nullable columns.
- The SDK sends its revision; relevant changes surface as a typed `SchemaChanged` naming the fields to regenerate. Codegen output is byte-identical for the same snapshot.

### Acceptance tests

- Text: `"  "` stored as null; NFD stored as NFC; lone surrogate, U+0000 or a line break in single-line text gives `InvalidValue`; a required text field refuses `""` and spaces.
- Decimal(10,2): `"1.005"` refused, `"1.500"` returned `"1.50"`, JSON `1.5` refused, `"-0"` returned `"0.00"`.
- Big integer `"9007199254740993"` round-trips exactly; the JSON number is refused.
- Date-time `"2026-10-20T10:15:30.123+02:00"` returns `"2026-10-20T08:15:30.123Z"`; four fraction digits and `:60` refused; dates 0001-01-01, 9999-12-31, 2024-02-29 round-trip whatever the process TZ.
- Json: duplicate keys refused; key order on output equals jsonb's; `0.1000000000000000055511151231257827` refused; `changed` agrees in both engines for reordered keys.
- Boolean omitted on create stores false; explicit null is `InvalidValue`.
- `PATCH` without `If-Match` gets 428 `VersionRequired` and changes nothing.
- Every response has the revision header, and bodies carry the same `schemaRevision`.
- A request built before `priority`'s choices changed gets `SchemaChanged` with `choicesChanged`; after only a label change it succeeds; R > C, or a different change set ID at the same number, gives `SchemaChanged` with kind `unknown`.
- Rename `foo` to `bar`, create a new `foo`, submit the stale form: `SchemaChanged` with `fieldRenamed`, and nothing is written to the new `foo`.
- A stale request naming a field the caller cannot name at C gets `UnknownField`, and `changes` never names it.
- Metadata for a user without read on `salary` omits it; a form rule reading it is sent with `salary` substituted as empty; form-state gives the same outcome whatever `salary`'s value.
- `recordSchema` from filtered metadata and from full definitions gives identical per-field errors for generated payloads.
- The web app's client is built with `HttpApiClient.make` from the shared definition, and the type check fails on an incompatible endpoint change.
- Password reads return `{"set": true}`; the plaintext never appears in history, labels or captured logs.
- SDK golden test (Step 5): identical output for the same snapshot; `SchemaChanged` surfaces as a typed error.

## 7. Import reconciliation and bulk operations

The import is a caller of the record service. Every row runs the save pipeline (4.1) as the user who started the job.

### 7.1 External identity

Decision: an external identity mapping replaces a source ID field. Reason: one field cannot hold IDs from several systems, and it adds a column everywhere.

- `core.source_system` registers sources (for example `servicenow-prod`, `hr-csv`), so a typo cannot create one.
- `core.external_identity`: `source_system_id`, `source_table`, `source_record_id` (exact text after the mapping's transforms), `record_id`, `class_id` at linking, `last_written_version` (null if linked but never written), `last_job_id`, timestamps. Primary key `(source_system_id, source_table, source_record_id)`; `UNIQUE (source_system_id, source_table, record_id)`.
- A platform table, not a class: no hooks, no history. Changed only in import batch transactions and by an audited admin unlink endpoint.
- No FK to record tables: a deleted record keeps its mapping, so a later import reports `TargetDeleted` instead of silently creating a new record.

### 7.2 Matching

Per row: (1) a mapped source ID found in `external_identity` updates that record; (2) else a declared match key: one hit links and updates, no hit creates and links; (3) else create, and link if the row has a source ID.

- A match key must be covered by an enforced unique constraint, or the job is refused at creation with `MatchKeyNotUnique`. Reason: otherwise two creates can both pass the lookup.
- Keys compare with exactly the unique index's equality (5.5) after declared transforms. No implicit trimming or folding.
- Row errors, reported per row, never stopping the job: `MatchKeyEmpty`; `IdentityConflict` (key hits a record linked to a different source ID in the same source table, or two rows share a key with different source IDs); `ClassMismatch` (hit's concrete class is not the target class or a descendant; a descendant hit is updated through the target class's fields only); `TargetDeleted` (option `recreate_deleted` creates and repoints instead); `DuplicateSourceId` and `DuplicateMatchKey` (two rows with the same source ID, or with the same match key and no source IDs: only the first occurrence is processed; found by the pre-scan, so batch boundaries do not matter).
- A unique violation on a match key during apply means a concurrent writer won; the batch is retried once and the row becomes an update or `IdentityConflict`, never a duplicate.

### 7.3 Concurrent user edits

- Prepare locks the record and computes `F_import` (mapped fields whose normalized value differs from stored; empty means unchanged, 7.5) and `F_others` (fields changed by entries above `last_written_version` not caused by an import from the same source system and table; hook writes inside such imports count as caused by them).
- Read rights apply as in 3.9. A mapped field the importer cannot read on that record always counts as written and as different, so it is always in `F_import`. `F_others` considers only fields the importer can read on the record. Reason: otherwise row results reveal hidden values or hidden edits.
- Job creation refuses a mapped field that is never readable for the importer (`MappedFieldNotReadable`) [judgment]; such a field would make every row `updated`.
- Conflict if `F_import` and `F_others` overlap. Reason: catches every edit the import would overwrite, without flagging edits to unmapped fields. [judgment]
- The first write after linking by key is not a conflict. [judgment]
- Policy per job: `skip` (default; reported as `conflict`, nothing written, mapping unchanged), `overwrite` (a normal save against the locked version; old values stay in history), `fail` (stops at the first conflict; that batch does not commit, earlier ones stay).

### 7.4 References

- By external identity: the mapping names the referenced class's source system and table; missing, deleted or unreadable targets give `ReferenceNotFound`.
- By display value or another declared lookup field: exact match under the type's equality among records the importing user may read that meet the field's allowed-records condition (6.5, evaluated in the importing user's view). The lookup compares against the masked expression of the lookup field (3.5), so a hidden value behaves like empty. None: `ReferenceNotFound`; several: `ReferenceAmbiguous` with the count of readable candidates. The import never picks one.
- Empty source value sets the reference empty, subject to required rules.
- References within one file resolve by external identity to earlier rows only. A forward reference fails, unless the mapping says `on_unresolved: leave_empty`, which writes it empty with a warning; a second run fills it [judgment].
- Lookups are set-based, one query per batch per reference field. If the referenced earlier row failed, the referencing row fails too.

### 7.5 Unchanged rows

- A row is `unchanged` when every mapped field is readable by the importer on that record and its normalized value equals the stored value (canonical forms in 6.5; text exactly as given after write conversion). A row with any unreadable mapped field is never `unchanged` (7.3).
- Unchanged rows get no version, change entry, delivery, mapping update or hook call, except that a first match by key still creates the link. This is the pipeline's no-op rule; hooks that derive fields do not re-run.

### 7.6 Jobs, batches, checkpoints and reports

- `core.import_job`, `core.import_batch`, `core.import_row_result` are platform tables with fixed endpoints.
- A job pins the uploaded file (immutable, with SHA-256), a mapping snapshot, options, the target class and its revision, and the user.
- A pre-scan streams the file without writing records: parses, checks headers, counts rows, finds duplicate source IDs and duplicate match keys.
- Batches are contiguous row ranges, default 500 [judgment], tuned in Step 5 so each commits in under 2 s, since a batch holds its record locks until commit.
- A batch's transaction writes records, row results and the batch's committed mark together. The mark is an insert into `core.import_batch` under a unique (job, batch) key, so retrying can never apply a batch twice.
- A runner claims the job with a fenced lease, like deliveries (4.6): the claim writes a new `lease_token`, and each batch transaction checks it with a conditional update whose row count is checked; if the lease is lost, the batch rolls back.
- Before each batch the runner checks for schema changes since the pinned revision with the 6.4 relevance rules, with scope set to the mapped fields across the target class, its ancestors and its descendants. A relevant change pauses the job with `SchemaChanged` until the user re-checks and resumes or cancels [judgment].
- Transient errors (serialization failures, deadlocks, lock timeouts, lost connections) are retried with backoff up to 5 times, then the job pauses. They never count against a row.
- Statuses: `queued`, `scanning`, `running`, `paused`, `completed`, `failed`, `cancelled`. Cancel takes effect between batches. A job is not atomic across batches; re-running the same file is safe by 7.1 and 7.5.
- Each row gets exactly one result: `created`, `updated`, `unchanged`, `conflict`, `error` or `warning`, with record ID, code, field ID and message. Messages never contain values the user cannot read, and raw Postgres details are never copied.
- Reports: a CSV of results, and a failed-rows file in the original format with an error column.
- Dry run: pre-scan and prepare for every batch, without locks or writes; cannot detect hook aborts or write-time constraint failures.

### 7.7 Bulk save

`RecordService.saveBatch(class, rows, options)` returns one outcome per row and runs the same pipeline and hooks as a single save.

1. **Prepare** (set-based reads): lock target root rows in record-ID order (`FOR NO KEY UPDATE`; `FOR UPDATE` for deletes and unique-column changes), which avoids deadlocks between batches; load level rows; resolve identities and references; normalize; validate; existing-state access checks; detect unchanged rows and conflicts. Failing rows are recorded and dropped.
2. **Apply** in file order:
   - Only rows whose concrete class has no hooks or record rules in any phase, whatever their conditions, join a pending group. Reason: whether a hook matches can depend on other records that earlier rows change. [judgment]
   - The group is flushed as one multi-row statement per inheritance table plus multi-row inserts of change entries, delivery rows and identity updates. Proposed-state checks run set-based right after each flush; a failure is handled like any other row failure.
   - The pending group is flushed before every hooked row. A hooked row runs the single-save pipeline in the batch transaction without a savepoint (4.1 poison rule applies).
   - After any hooked row writes any record, every remaining row of the batch is prepared again. This also turns a create into an update when a hook created a later row's match key.
3. **Finish:** row results, batch mark, commit, then one wake-up (4.1).

- Equivalence rule: the committed state equals saving the non-failing rows one at a time in file order. Grouping must not be observable. Equal means equal field values, versions, change-entry field maps and row results, compared after mapping generated IDs by source row and ignoring timestamps and operation IDs.
- Decision on a row failure during apply: roll back the batch, record the error, rerun from prepare without the failed rows. After 3 reruns, the rest of the batch runs one row per transaction. A failure inside a flushed group reruns that group row by row.
- Why not a savepoint per row: each writing savepoint is a subtransaction with its own XID, and beyond 64 cached subtransactions per backend visibility checks fall back to `pg_subtrans` with heavy I/O [checked: [subtransactions](https://www.postgresql.org/docs/18/subxacts.html)]. Whether released savepoints count toward the 64 is unclear [unverified]; this design does not depend on it.
- Why not fail the whole batch: one bad row would fail up to 499 good ones.
- Cost accepted: rows before a failing row run their hooks again, bounded by the 3-rerun rule.

### 7.8 COPY

- `@effect/sql-pg` 4.0.5 implements the wire protocol itself and fails on COPY messages with "COPY is not supported" [checked: `src/PgConnection.ts` in [sql-pg-4.0.5.tgz](https://registry.npmjs.org/@effect/sql-pg/-/sql-pg-4.0.5.tgz)]. Adding COPY means a second driver outside `SqlClient`.
- COPY is added in Step 5 only if the measurement requires it, as a loading optimization (staging tables, flushed groups). It never changes hooks, validation, access checks, change entries, deliveries or outcomes. Rows with a matching hook never use it. The equivalence test also runs on the COPY path.

### Acceptance tests

- Importing the same 10,000-row file twice: the second run reports every row unchanged, with zero new versions, change entries, deliveries or hook calls.
- A match key without a unique constraint is refused with `MatchKeyNotUnique`.
- Duplicate source IDs at rows 499 and 501 (batch size 500): row 501 reports `DuplicateSourceId`. Two rows with the same match key and no source IDs at rows 499 and 501: row 501 reports `DuplicateMatchKey`.
- Two readable users named Alice give `ReferenceAmbiguous` with count 2; a third the importer cannot read leaves it at 2.
- Importing a value equal to a hidden stored value gives the same row result and version effect as importing a different value.
- A user edit to a mapped field after an import gives `conflict` under `skip` and a write under `overwrite` (history shows both); an edit to an unmapped field gives no conflict; an edit to a field the importer cannot read gives no conflict.
- Kill the runner after batch 3 of 10: a new runner completes with one record per source row, one result per row, no duplicate identity rows. A runner paused past its lease cannot commit a batch.
- A before-write abort on row 250 of 500 commits the other 499 and reports row 250 as `error`.
- Grouped and forced one-row-per-save imports are equivalent (7.7); repeated for COPY if added.
- Equivalence fixtures: a hook whose condition reads a record changed by an earlier row; a hook that creates a later row's match key.
- A user creates a record with the key during the import: the row ends `updated` or `IdentityConflict`, and exactly one record has the key.
- A unique violation on a field the importer cannot read produces a message without the value.
- A relevant schema change to the target class or a descendant between batches pauses the job, and no further batch commits; a label change does not pause it.
- After deleting a mapped record, re-import reports `TargetDeleted`; with `recreate_deleted` it creates and repoints.
- No `SAVEPOINT` in the statement log of a 2,000-row import with an injected abort.

## 8. Configuration portability and operational recovery

### 8.1 Identity and owner layers

- Every config record has a stable ID (1.1) and an owner layer: `core`, `app` (names its set) or `local` (created on this install). The layer never changes, except that `adopt` moves a record its set removed into `local`.
- Everything loaded from files belongs to a shipped set. An install that keeps its own config in git packages it as its own app set. Reason: one rule for all file-loaded config, and UI edits on top stay visible as overrides. [judgment]
- Local additions to shipped tables and classes follow 1.8.
- Files refer to records by name; the loader resolves names within the set and its declared dependencies. Diffs compare by ID only. A missing, duplicate or foreign ID refuses the set.

### 8.2 Shipped base plus local overrides

| Table | Holds | Written by |
| --- | --- | --- |
| `core.config_set` | installed sets: ID, layer, version, hash, dependencies | `std upgrade` |
| `core.config_base` | one row per shipped record: set, version, kind, shipped properties (JSON), hash | `std upgrade` only |
| `core.config_override` | one row per overridden property: record ID, property, local value, `base_when_set`, who, when | config service on admin edits |
| `core.config_conflict` | upgrade conflicts and resolutions, and `converged` entries | opened by `std upgrade`, resolved by admins |
| definition tables | the effective record | config service only, in the same transaction |
| `core.definition_revision` | effective record per revision (4.4) | config service only, in the same transaction |

- The runtime reads only effective records, so layering stays inside the config service. [judgment]
- Admin edits to shipped records are stored as overrides; removing one restores the shipped value.
- Overridable properties [judgment]: field label, help text, default, and tightening of required, read-only and max length (never name or type); table label and display field; choice label, order, hidden (shipped choices cannot be deleted); a layout's element list as one property; a field's auto-number prefix [judgment, decision 0017]; a saved filter's label, and its condition as one property [judgment, decision 0019]; role label; rule and access rule `active` only (protected access rules cannot be disabled); protected records label and help text only.
- In v0.1 a field's max length lives in its type, which never changes, so max length is not overridable yet; and removing a `required` override (or `take_shipped` of one) is a loosening the schema engine refuses until it can drop the NOT NULL it added (decision 0012).

### 8.3 Applying sets

1. Parse and validate every file; any failure applies nothing.
2. Resolve names to IDs.
3. Build the dependency graph (1.7 kinds). An `extends` cycle is refused; reference cycles are handled by phases.
4. Apply in phases: namespaces and tables with non-reference fields (parents first); reference fields and FKs; indexes; roles and their permission grants; choices, layouts, saved filters, rules, access rules, subscriptions.
5. Topological order within a phase, ties by ID, so SQL is identical for any file order.
6. Removals in reverse order.
7. Sets in dependency order: core, then apps by `requires`; cycles refused.

Each set load is one change set (plus a `complete` revision if it has follow-up steps).

### 8.4 Upgrades when a shipped definition changes

| Case | Result |
| --- | --- |
| New record | created; a name clash with a local field, class or other local record refuses the whole upgrade at plan time; the report names the local definition, the admin renames it (1.1) and reruns |
| Changed, no override | applied |
| Changed, override exists, incoming equals `base_when_set` | nothing to do |
| Changed, incoming equals the local value | converged: override dropped, `converged` entry recorded |
| Changed, local value differs | conflict: base updated, local value stays effective, conflict opened with old shipped, new shipped and local values |
| Renamed (any kind, roles included) | applied by ID; everything that refers to it by ID keeps working |
| Removed upstream | tables and fields retired (never purged; a removed table's fields are retired explicitly, then the table), choices hidden, layouts deleted (tombstone) [judgment, decision 0017], saved filters deleted (tombstone) [judgment, decision 0019], rules deactivated, roles retired; local dependents reported; a role that an active local access rule names is refused at plan time (`rule_role`); admin may purge or `adopt` |
| Type changed | refused in v0.1; author adds a field and retires the old one |
| Tightened constraint violated by data | refused at plan time with counts |

- Conflicts resolve as `keep_local` (sets `base_when_set` to the new shipped value), `take_shipped` (drops the override) or `replace`. Open conflicts do not block the system.
- The report lists every access-rule, role and permission-grant change in a "security changes" section.
- Sets carry no data transformations in v0.1; core data changes go into platform migrations. Downgrades are refused; rerunning an upgrade changes nothing.

### 8.5 `std upgrade`

- Offline in v0.1: stop servers, run `std upgrade`, start servers. It refuses to run while any session with `application_name` `std-server` or `std-worker` (the outbox worker process, Step 3) is connected; with `--wait-for-disconnect <duration>` it first waits up to that long for them to go, then refuses, and when the database encoding is not UTF8 (5.5). Reason: rolling upgrades need expand-and-contract rules, which come with high availability.
- Order: take `SCHEMA_KEY`; compare versions; run platform migrations of kinds `tx` and `concurrent_index`; resume interrupted change sets; load core; load app sets; run `data` migrations, which need the classes the sets just loaded (1.9); write the report. A run that stops anywhere leaves servers refusing to start until a rerun finishes (1.9).
- Planning reads the catalog version-aware: before pending platform migrations ran, a definition table or column a later migration adds reads as empty or null, so the plan of a previous release's database is made without migrating it first (which `--plan` must not do, and which would change the state the `--expect` hash covers) [decision 0017].
- Release compatibility (CI): a database made by the previous release (`v0.0.1`) with that release's own quickstart data is upgraded by this version, `doctor` exits 0, and the previous release's unchanged quickstart script runs against this version's server, as does this version's own. Request schemas accept payloads of the previous release: a property added later may be absent and decodes to its default [judgment, decision 0017].
- `--plan` (and `--json`, which implies it) changes nothing and prints migrations, per-set diffs, conflicts, refusals and security changes, with a hash over all of them and the configuration state they start from. It runs while servers are connected and reports them as a warning. The real run applies that plan and stops if the database changed since: `--expect <hash>` refuses before anything runs when the plan differs; each set is planned again before it applies and must equal its plan; and its main transaction checks that no other config commit came first (decision 0012).
- After a failure, rerunning continues from the last committed migration or change set. A change set that ends in `needs_attention` stops the run with an error naming it, and every later run refuses until an admin resumes or abandons it, so unfinished change sets never look upgraded.

### 8.6 Backup and restore

- All STD state is in one Postgres database: definitions, definition revisions, layers, journal, records, history, outbox, import bookkeeping and sequences. Uploaded import files are stored there too in v0.1 [judgment]. Any feature that stores state elsewhere must extend this contract and its test.
- Supported: `pg_dump` of the whole database, and physical backups.
- A dump is one snapshot, so a dump taken during a follow-up phase restores as a change set in `applying`, which resume completes. Deliveries not yet marked `done` repeat after restore; consumers dedupe by `change_id` (4.7).
- While a dump runs, concurrent index builds wait for its snapshot (the watchdog reports it, 1.5) and DDL change sets get `SchemaLockTimeout`.
- Restore: stop STD; restore; `std upgrade`; `std doctor`; start servers. A process left running reloads because caches are keyed by `(revision, change_set_id)`.

### 8.7 Recovery from an interrupted schema change

| Interrupted during | State | Recovery |
| --- | --- | --- |
| Main transaction | rolled back, no journal rows | none |
| Follow-up step | change set `applying`, step `running` | automatic resume by probe (1.5) |
| Index build waiting on another session | step `running`, watchdog report | end the blocking session, or `std schema abandon <id>` |
| Repeatedly failing step | `needs_attention` | fix the cause and `std schema resume <id>`, or `std schema abandon <id>` |
| `std upgrade` | stopped at a boundary | rerun `std upgrade` |

`std schema status` shows open change sets, steps, last error, build progress and the `SCHEMA_KEY` holder's PID and client address. The v0.1 docs include a runbook with exact commands for each row, executed by CI.

### Acceptance tests

- Loading a set with shuffled files produces byte-identical SQL and identical IDs.
- A set defining a child before its parent, with two mutually referencing tables, loads; an `extends` cycle is refused and nothing applies.
- Fixture v1 to v2 with local label overrides on X and W: v2 changes X, sets W to the local value, changes Z (not overridden), renames a shipped role R, adds a role, and changes one access rule. Z shows v2; X keeps the local label with one conflict; W's override is gone with a `converged` entry; the access rule naming R keeps working; the access-rule and role changes appear under security changes.
- `take_shipped` on X sets the v2 label; `keep_local` survives a v3 that does not change X.
- Rerunning the same upgrade changes nothing, the revision included.
- v2 removing a field with data retires it with values intact; `adopt` moves it to `local`. v2 removing a role that a local access rule names is refused at plan time.
- A v2 that changes a type is refused at plan time; revision, catalog and config tables unchanged.
- Name clash: a v2 adding field `foo` to a shipped table where a local field `foo` exists is refused at plan time with a report naming the local field; after the admin renames it, the rerun succeeds and the local field's data and the rules reading it are intact.
- `--plan` leaves revision, catalog (schema-only dump diff) and config tables unchanged, and the real run's report equals the plan.
- `std upgrade` refuses to run while a `std-server` session is connected, and likewise while only a `std-worker` session is connected (`upgrade-refuses-worker`); with `--wait-for-disconnect` it proceeds once both are gone and refuses at the deadline otherwise; and it refuses on a non-UTF8 database.
- Release upgrade (Step 5): from the previous pre-release with helpdesk, 10,000 records with history and customizations (local field on a shipped table, overrides, a local class extending a shipped one, a local access rule, a local role), the candidate upgrade leaves `doctor` exiting 0, content checksums unchanged except for documented migrations, customizations effective, expected conflicts only.
- Backup and restore (Step 5): `pg_dump -Fc` under load during a follow-up phase, restored into an empty Postgres 18, then `std upgrade`: the change set completes, `doctor` exits 0, checksums match the snapshot, auto-numbers continue, sign-in works, a new change set succeeds.
- Restore then upgrade (Step 5): a previous pre-release backup reaches the same state as the release upgrade test.
- CI runs every runbook command against these scenarios.

## 9. Effect toolchain

- **Versions.** `effect` and the 4.x `@effect/*` runtime packages share one version and release in lockstep [checked: [Effect 4.0](https://effect.website/blog/releases/effect/40)]. STD pins them to one exact version (4.0.5 today) through a pnpm catalog, because `@effect/sql-pg` declares its peer as the range `effect: ^4.0.5`. `@effect/tsgo` has its own version line (0.54.1), releases several times a week, and is pinned exactly and upgraded in its own PR. `typescript` is pinned to a version in `@effect/tsgo`'s supported table (7.0.2).
- **Never installed:** `@effect/sql` and `@effect/platform`. They are Effect 3-era 0.x packages that still carry npm's `latest` tag; in v4 they live inside `effect` as `effect/sql` and `effect/http`.
- **Stability.** APIs tagged `@stability unstable` may break in minor releases, and `@stability experimental` ones in patch releases [checked: `repos/effect/MIGRATION.md` at `effect@4.0.5`]; since 4.0.2 every module declares its stability [checked: [Effect 4.0: The First Week](https://effect.website/blog/effect-4-first-week)]. In 4.0.5, all of `effect/sql`, `effect/http`, `effect/http-api`, `effect/rpc`, `effect/workflow`, `effect/cluster`, `effect/observability` and every module of `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` and `@effect/vitest` are unstable; `Effect`, `Layer`, `Schema`, `Stream` and most root modules are stable [checked: [effect-4.0.5.tgz](https://registry.npmjs.org/effect/-/effect-4.0.5.tgz)]. This includes `src/http-api/HttpApiClient.ts` and `src/http/HttpClient.ts` [checked: same tarball]. Unstable as whole modules in 4.0.5 are also the root modules `Arbitrary`, `ByteSize`, `ChannelSchema`, `Crypto`, `ErrorReporter`, `ExecutionPlan`, `FileSystem`, `Graph`, `HashRing`, `LayerMap`, `LayerRef`, `Newtype`, `PartitionedSemaphore`, `Path`, `PlatformError`, `Stdio`, `Terminal`, `TxChunk` and `Version`, and stable modules hold some unstable exports (`Schema` has 132 unstable and 46 experimental ones) [checked: `node_modules/effect/src`, 0A].
- **Diagnostics.** `@effect/tsgo` is the TypeScript 7 binary for editor and CI; TS 7.0 has no programmatic API, so tsserver plugins do not run on it [checked: [TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [Effect-TS/tsgo](https://github.com/Effect-TS/tsgo)]. Setup: the tsconfig plugin entry is named `@effect/language-service`, and `"prepare": "effect-tsgo patch"` makes plain `tsc` report Effect diagnostics. Because `extends` replaces the whole `plugins` array, each package's own tsconfig (a copy of its profile's template in `tooling/tsconfig/`) sets `diagnosticSeverity` to error for `unstableApiUsage`, `experimentalApiUsage`, `outdatedApi`, `obsoleteSchemaImport`, `duplicatePackage` and `floatingEffect`, and keeps `ignoreEffectWarningsInTscExitCode: false`, so CI fails in the normal type-check step (`pnpm typecheck`, `tsc -p` per package). `tooling/check-tsconfig.ts` fails a package whose entry differs from its declared profile. The diagnostics fire where an unstable export is used, not on the import statement [checked: 0A canaries].
- **Patch and pnpm.** pnpm hard-links package files from its global store, so a patch that rewrote files in place would change the store copy used by other projects. `effect-tsgo patch` renames the store-linked `lib/tsc` to `lib/tsc.original` and writes a new, unshared `lib/tsc`; the store copy keeps its inode and content, so no `package-import-method` setting is needed [checked: canary `effect-tsgo-patch-and-pnpm`, 0A].
- **Allow lists**, kept in each package's own tsconfig. The entry strings below work as written; a module entry covers its submodules (`effect/sql` allows `effect/sql/SqlClient`), `module#export` allows one export, and `effect/http` does not cover `effect/http-api` [checked: 0A canaries, `docs/decisions/0001-effect.md`]:
  - Plain packages (definitions, values, conditions, access-rule evaluation): empty.
  - Shared API-definition package and web app: `allowedUnstableApis = ["effect/http-api", "effect/http"]`. Reason: the shared `HttpApi` definition and `HttpApiClient.make` live in these unstable modules.
  - Server package: `allowedUnstableApis = ["effect/sql", "effect/http", "effect/http-api", "effect/observability", "@effect/sql-pg", "@effect/platform-node", "@effect/opentelemetry"]`.
  - Tests, in every profile: an `overrides` entry for `"include": ["test/**/*"]` adding `@effect/vitest`, repeating the server entries because overrides replace the base list. `test/**` matches no file, and the glob resolves relative to the tsconfig that declares it [checked: 0A].
  - `allowedExperimentalApis` is empty everywhere. Unstable Schema exports are allowed one export at a time, only if needed.
  - Each entry has a one-line reason in the Effect decision note. Every Effect upgrade PR checks the API reference for changes in allowed modules and removes entries for modules promoted to stable.
- **"Effect Schema only" in plain packages.** Stability diagnostics flag only unstable imports, so a plain package importing stable `Effect`, `Layer` or `Stream` would pass them. A CI import check (`tooling/check-imports.ts`) allows plain packages' `src/` to import from `effect` only `Schema`, `SchemaAST`, `SchemaGetter`, `SchemaIssue`, `SchemaParser`, `SchemaTransformation`, `Option` and `Result`; the reasons are in the Effect decision note.
- **Later:** turn on `apiStabilityLeak` for STD's published packages once they tag their exports [unverified: that it follows tags into Effect's packages].
- **Agent material.** AGENTS.md carries a short idiom guide pointing at the diagnostics above and at `AGENTS.md` and `ai-docs/` shipped in the `effect` package. Effect's source is vendored at `repos/effect` (moved from `vendor/effect` in workstream 0A-foldkit) as a squashed subtree of the `effect@<version>` tag of `https://github.com/Effect-TS/effect` matching the lockfile, not `main` (the npm metadata has no `gitHead`; tag `effect@4.0.5` is commit `7f524e2`, tree `208c4ac`) [checked: 0A]. The CI check compares `HEAD:repos/effect` with the recorded tree hash, so the vendored files themselves must match the tag.
- **Measurement log.** Each Effect upgrade PR records engineer-hours and breakages per allowed module; defects record whether Effect was the root cause and which workstream they belong to; agent PRs record Effect-related rework. The plan's thresholds are reviewed at every stage gate.

### Acceptance tests

- A canary import of `effect/sql` in a plain package fails `tsc`; the same import in the server package passes.
- A canary import of `Effect` into a plain package fails the CI import check.
- The web app and the shared API-definition package type-check with `HttpApiClient.make`; an import of `effect/sql` in the web app fails.
- A second copy of `effect` in the lockfile fails CI (`duplicatePackage` plus a lockfile check).
- An Effect 3-era API in any package fails CI (`outdatedApi`).
- The vendored Effect source tag equals the lockfile version (CI check).

## 10. The generic API under TMF630 (Step 3)

Martin's requirement (2026-10-22, decision 0021): STD's own API follows the TMF630 REST API Design Guidelines. v4.2.0 is the production version (2021) and is labelled "Available to all" (downloading it may need a free tmforum.org login, which is not a membership [unverified]); v5.0.0 is pre-production and needs a TM Forum membership. The v4.2.0 text is therefore the verified baseline: workstream 3G reads it and enters every normative rule into the requirements matrix (15) before the rules below are final. Where v5 changed a rule, the v5 OpenAPI documents (TMF621 v5.0.1 above all), their user guides and conformance profiles decide, because they are what the kits test. Until the matrix is complete, a rule this section took from the 2015 Part 1 (R14.5.1) or only from v5 documents is marked **[unverified]** (R14.5.1-only rules as **[unverified for v5]**). Where STD deviates on purpose, the rule says **[judgment]** with the reason, and the deviation is a matrix exclusion that Martin decides (15.3; the current ones were accepted on 2026-10-22). Each rule has a named test in `tmf630-conformance`.

### 10.1 Versions and paths

- STD's API v2 lives under `/api/v2`. The major version is in the path, and minor versions never change it [checked: every v5 OpenAPI document serves `{apiRoot}/tmf-api/<apiName>/v5/`; TMF656 v5.1.0 still uses `/v5`]. The `/tmf-api` prefix is kept for TM Forum's own APIs (11.1) [judgment].
- `/api/v1` is frozen from Step 3: no new endpoint, parameter or field, and every response carries `Deprecation: @<epoch of the v0.0.3 tag>` (RFC 9745) and `Link: </api/v2>; rel="successor-version"`. It is removed in `v0.1.0`. Contracts 6.6 and 6.7 describe v1; this section describes v2.
- Resource names are singular lowerCamelCase nouns [checked: `/troubleTicket`, `/troubleTicketSpecification`, `/hub` in TMF621 v5.0.1]. A table is its own collection: `/api/v2/{table}` and `/api/v2/{table}/{id}`, where `{table}` is the qualified name (`helpdesk.incident`). Fixed resources never contain a dot and table names always do, so they cannot collide [judgment]:

| v1 | v2 |
| --- | --- |
| `GET`, `POST /api/v1/tables/{table}/records` | `GET`, `POST /api/v2/{table}` |
| `GET`, `PATCH`, `DELETE .../records/{id}` | `GET`, `PATCH`, `DELETE /api/v2/{table}/{id}` |
| `GET .../records/{id}/history` | `GET /api/v2/{table}/{id}/history` (a collection of `ChangeEntry`) |
| `POST /api/v1/tables/{table}/form-state` | `POST /api/v2/formStateCheck` (a task resource) |
| `GET /api/v1/meta/tables[/{table}[/openapi.json]]` | `GET /api/v2/tableMetadata[/{table}[/openapi.json]]`; `GET /api/v2/tableMetadata/{table}/schema.json` (JSON Schema of the class's resource for the caller) |
| `POST`, `GET /api/v1/schema/change-sets[/{id}]` | `POST`, `GET /api/v2/changeSet[/{id}]` (a task resource) |
| `POST /api/v1/auth/sign-in`, `cookie-sign-in`; `GET auth/me`; `POST auth/sign-out` | `POST /api/v2/session` (`tokenDelivery`: `body` or `cookie`); `GET`, `DELETE /api/v2/session/current` |
| none | `POST /api/v2/hub`, `GET`, `DELETE /api/v2/hub/{id}` (12.2) |
| `GET /api/v1/openapi.json` | `GET /api/v2/openapi.json` |

- The session cookie's path becomes `/api` while both versions exist. `STD-Client: web`, `STD-Schema-Revision`, `Cache-Control: no-store` and the stale-request rules (6.2, 6.4) are unchanged in v2.

### 10.2 Resource representation

- A record is one flat JSON object, not an envelope [checked: v5 `*_RES` schemas]:

```json
{
  "id": "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f",
  "href": "https://std.example/api/v2/helpdesk.incident/01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f",
  "@type": "helpdesk.incident",
  "@baseType": "helpdesk.ticket",
  "@schemaLocation": "https://std.example/api/v2/tableMetadata/helpdesk.incident/schema.json",
  "version": 7,
  "createdAt": "2026-10-20T08:15:30.123Z",
  "createdBy": {
    "@type": "EntityRef",
    "@referredType": "core.user",
    "id": "…",
    "href": "…",
    "name": "Admin"
  },
  "number": "INC0001001",
  "shortDescription": "Mail is down",
  "assignedTo": {
    "@type": "EntityRef",
    "@referredType": "core.user",
    "id": "…",
    "href": "…",
    "name": "Alice Smith"
  },
  "estimate": "12.50",
  "withheld": ["customerEmail"]
}
```

- `id` and `href` are always present; `href` is the absolute URL of the record through its concrete class [checked: `Addressable`; `id` and `href` required in `TroubleTicket_RES`]. `@type` is always present [checked: v5 `Extensible` requires `@type`].
- **Attribute names** are lowerCamelCase [checked: every v5 schema]. A field's API name is its definition name with each `_x` turned into `X` (`short_description` → `shortDescription`). The schema engine refuses a field whose API name equals the API name of another live field of the hierarchy, or a reserved name (`id`, `href`, `version`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `withheld` and anything starting with `@`), with `DefinitionInvalid` problem `apiNameClash` [judgment: definition names stay snake_case so plain SQL stays readable (1.1); resolved question 9]. Filter text, `fields`, `sort` and write bodies in v2 use API names; v1 keeps definition names.
- System fields: `version` (number), `createdAt`, `createdBy`, `updatedAt`, `updatedBy`; `class` becomes `@type`.
- **Polymorphism** [checked: `@type`, `@baseType`, `@schemaLocation` in v5 `Extensible`]: `@type` is the qualified name of the concrete class; `@baseType` is the qualified name of its parent class, absent on a root's own records; `@schemaLocation` is the caller's JSON Schema of the concrete class (`/api/v2/tableMetadata/{class}/schema.json`, built from the same metadata as 6.3, so it names no field the caller cannot read). A caller who can see a record always knows its concrete class (3.4), so none of the three leaks a class name. Through a parent endpoint the record still shows only the endpoint's lineage fields (2.3); `@type` tells a client where to read the rest.
- **References** are EntityRefs [checked: v5 `EntityRef` requires `id`, adds `name`, `@referredType`, `href`]: `{"@type": "EntityRef", "id", "href", "@referredType", "name"}`. `@referredType` and `href` name the target's concrete class when the target is visible to the caller, otherwise the declared target class if the caller knows it (6.3), otherwise both are absent. `name` is the label under exactly the 3.6 rule. This replaces `labels=true`; choice labels come from metadata. In writes only `id` is read; a non-null `@referredType` must name the field's target class or a descendant, else `InvalidReference`.
- `withheld` lists selected attributes withheld on this record (6.6). It is STD's extension of the record base type, not a TMF attribute [judgment: TMF has no "restricted" marker, and a restricted field must never look empty, Step 2 gate].
- Value shapes are 6.5's, unchanged (big integers and decimals stay strings).

### 10.3 Query parameters on lists and reads

| Parameter | Meaning | Source |
| --- | --- | --- |
| `fields` | Comma-separated attribute names (one-hop paths allowed, `assignedTo.name`); `id`, `href` and `@type` are always returned | [checked: TMF621 v5.0.1 `fields`; the TMF621 conformance profile makes first-level attribute selection mandatory] |
| `<attr>=<v>` | `eq(attr, v)`; several attributes AND | [checked: TMF621 conformance profile `?severity=…&status=…`] |
| `<attr>=<v1>,<v2>` and `<attr>=<v1>&<attr>=<v2>` | `in(attr, [v1, v2])` | [unverified for v5: R14.5.1] |
| `<attr>.gt=`, `.gte=`, `.lt=`, `.lte=` | `gt`, `ge`, `lt`, `le` | [unverified for v5: R14.5.1] |
| `<ref>.id=`, `<ref>.name=`, `<ref>.<attr>=` | a one-hop path (5.9, 3.6 masks) | [judgment, from the dotted-attribute convention] |
| `@type=<class>` | `class` equals the class (2.3); `@type=a,b` is `in` | [judgment] |
| `offset`, `limit` | offset paging; `limit` 1 to 1,000, default 100 | [checked: v5 `offset`, `limit`] |
| `after`, `before` | opaque cursors (STD's keyset cursor, 3.5) | [checked: v5 `after`, `before` "opaque string"] |
| `sort` | `sort=-cost,name`; ascending by default, `-` reverses | [checked: v5 `sort`] |
| `filter` | JSONPath filter (TMF630 Part 6): refused in v0.1 with `InvalidFilter` reason `jsonPathNotSupported` | [checked: v5 `filter` "Filter a collection using JSONPath"; judgment to refuse, resolved question 13] |
| `condition` | STD's condition text syntax (Contracts 5, `@std/conditions`) with API names, ANDed with the TMF filters | STD extension [judgment] |
| `count` | `count=false` drops `X-Total-Count` | STD extension [judgment] |

- Mapping onto the condition AST (5.2): values are parsed from query text by the field type's input rules (6.5): a JSON number for integers (`5`), text for big integers and decimals, `true`/`false`, dates and date-times as in 6.5, choice keys, UUIDs. `<attr>=` with an empty value, an operator suffix the type does not support (5.4), `.regex` and `.exact` are `InvalidFilter`. Text equality uses the field's key (5.5), so `name=alice` matches `Alice` on a case-insensitive field [judgment: TMF630 does not define case]. Every name resolves against the caller's visible schema, so a hidden attribute gives `UnknownField` exactly as a missing one (3.4). Repeated parameters for the same attribute and operator are OR; everything else is AND.
- Unknown query parameters are `InvalidRequest` [judgment: an unknown attribute must not be silently ignored, because an ignored filter widens the result].
- `offset` and `after`/`before` together are `InvalidRequest`. Offset pages use the same `ORDER BY` with `OFFSET` and the same masking (3.5); STD makes no stability promise across changes for offset pages (the cursor gives that) [judgment].

### 10.4 List responses

- `200` with a JSON array of resources [checked: v5 list responses are arrays with `200`; no `206` is defined in v4 or v5 OpenAPI documents].
- `X-Result-Count`: the number of items in this response. `X-Total-Count`: the number matching the filter, computed with the page's `FROM` and `WHERE` (3.5), on every list unless `count=false` [checked: both headers on every v4 and v5 list; judgment: always on, so a TMF client gets it without asking].
- The next page: `Link: <…?after=<cursor>&…>; rel="next"` (RFC 8288) when a cursor page has more; offset pages give `rel="next"` with the next offset [judgment: v5 defines the `after` parameter but not where a client reads its value].
- History lists are `ChangeEntry` resources: `{"@type": "ChangeEntry", "id": <change ID>, "operationId", "version", "kind", "actor": EntityRef, "occurredAt", "schemaRevision", "cause", "changes", "fields"}`, filtered as in 3.7.

### 10.5 Writes

- `POST /api/v2/{table}`: `201` with the resource and `Location` [checked: v5 `201`]. `@type` is optional and defaults to `{table}`; if given it must name a class of subtree(table) the caller knows, and the body resolves against that class's fields, so a client can create a child-class record through the parent collection [judgment: TMF polymorphic create; this widens 2.2 item 5 for v2 only, and the access checks run on the class created]. `@baseType` and `@schemaLocation` in a body are ignored when they match the created class's, else `InvalidRequest`. `id`, `href`, `version` and the audit attributes are `ReadOnlyField` (6.7).
- `PATCH /api/v2/{table}/{id}` takes `application/merge-patch+json` (RFC 7396), and `application/json` as the same, and `application/json-patch+json` (RFC 6902) [checked: TMF621 user guide: merge-patch mandatory, JSON Patch optional]. `application/json-patch-query+json` is `415` [judgment, resolved question 13].
  - Merge-patch is the 6.7 update body: an absent attribute is unchanged, `null` clears. For a json field the patch value is merged into the stored value by RFC 7396 [judgment: TMF clients expect merge semantics on nested objects]; for a reference only the EntityRef's `id` counts.
  - JSON Patch operations apply in order to the caller's readable image of the record as locked by the save: the pipeline resolves every path's attribute name and runs the stale check (6.4) at the request's revision first (4.1 step 1), then locks the root row and checks visibility and the version (step 2), and only then builds the image from the locked state and applies the operations; the result becomes the update body for step 3 onwards. So a `test` or a `copy` source always sees the version the write applies to, with or without `If-Match`. The RFC 7396 merge into a json field is computed the same way, after the lock. A path is `/<attribute>` or a pointer into a json field. `test`, `copy` and `move` read their source, so a source the caller cannot read is `UnknownField`, as in 3.4. A failed `test` is `409 PatchTestFailed` and writes nothing. An operation on a read-only attribute is `ReadOnlyField`.
  - Non-patchable: `id`, `href`, `@type`, `@baseType`, `@schemaLocation`, `version`, the audit attributes, auto-numbers and read-only fields [checked: the TMF621 user guide's non-patchable list].
  - The result is `200` with the resource and `ETag: "<version>"`.
- `DELETE /api/v2/{table}/{id}`: `204` with no body [checked: v5 `204`].
- **Version checks.** `PATCH` and `DELETE` in v2 still require `If-Match: "<version>"` (`428 VersionRequired`), and every single-resource response carries `ETag: "<version>"` [judgment: TMF630 does not require a precondition, but STD's generic API never writes last-wins, 6.7; the TMF Open APIs make it optional, 11.1].
- The save pipeline (4.1) is unchanged underneath: the stale check (6.4) runs on the attributes the patch names, before validation, access and version checks; a JSON Patch's scope is every attribute its operations touch or read. Only the evaluation of the patch moves after the lock, as above.
- `PUT` is `405` [judgment: TMF630 makes it optional].

### 10.6 Errors

- Every error body is a TMF `Error` [checked: v5 `Error` requires `code` and `reason`; adds `message`, `status`, `referenceError`, and `@type` from `Extensible`]: `{"@type": "<_tag>", "@baseType": "Error", "code": "<_tag>", "reason": "<fixed text per _tag>", "status": "<HTTP status>", …}`. STD's details stay as extension attributes of the subtype: `fieldErrors` (`ValidationFailed`), `currentVersion` (`VersionConflict`), `requestRevision`, `currentRevision`, `changes` (`SchemaChanged`), `problems` (`DefinitionInvalid`), `issues` (`InvalidFilter`) [judgment: TMF630 extends by subtyping].
- `message` is a fixed template per tag, never a value or Postgres text (3.8). The identical-response rules of 3.4 and 3.8 (`UnknownTable`, `UnknownField`, `NotFound`, `InvalidReference`) hold byte for byte in v2.
- Status codes are those of 3.8; `PatchTestFailed` is 409 and an unsupported media type is 415.

### 10.7 What changes for clients

- `v0.0.1` and `v0.0.2` clients keep working on the frozen `/api/v1` until `v0.1.0`; the release-compatibility step keeps running the previous release's quickstart unchanged (architecture, "Release compatibility").
- The web app, `examples/quickstart.sh` and the typed client move to v2 in Step 3, so the `v0.0.3` quickstart already speaks v2 and the step stays meaningful when v1 is removed in `v0.1.0`.
- Request schemas in v2 decode an absent new property as its default, as v1's do (decision 0017).

### Acceptance tests

- `tmf630-conformance`: one test per rule in 10.1 to 10.6, against the acme and helpdesk fixtures: paths, the representation (every attribute name in lowerCamelCase, `@type` on every object, `href` dereferences to the same resource), `fields`, each filter form and its AST, offset and cursor paging with both count headers, `sort`, polymorphic create through a parent, merge-patch including a nested json merge, every JSON Patch operation including a failed `test`, `204` on delete, `ETag` on reads and writes, the Error shape for every `_tag`.
- `tmf-filter-equivalence`: property test. For generated TMF queries over every condition-capable type, the IDs and order of `/api/v2` equal those of the same query written in the `condition` syntax, and of `/api/v1` with the text filter.
- The Contracts 3 tests named for Stage 0 and Step 1, `error-fuzz` and `invisible-identity` run against v1 and v2.
- `api-name-clash`: a field `due_date` next to a live `dueDate` is refused with `apiNameClash`, and so are `href` and `@x`.
- `v1-frozen`: every `/api/v1` response carries `Deprecation`; the v1 OpenAPI document is byte-identical to the `v0.0.2` one apart from the version string.
- `json-patch-race`: two concurrent patches without `If-Match`, each with `test` on the same value and a `replace` of it: exactly one succeeds and the other is `409 PatchTestFailed` with nothing written; a `copy` whose source a concurrent save changes copies the value of the version it is applied to; the same holds for TMF621 `PATCH`.

## 11. TMF Open API mappings (Steps 3 and 4)

### 11.1 Common rules

- **Pinned versions** [checked: the TM Forum Open API directory and its document bucket, 2026-10-22, decision 0021]. Moving a pin is its own PR, with its kit. `packages/tmf/specs/pins.json` holds these pins with each document's source commit and SHA-256 and each kit's zip URL, SHA-256, image and default URL (Contracts 15.1):

| API | Version | Base path | Resources STD serves | CTK | Step |
| --- | --- | --- | --- | --- | --- |
| TMF621 Trouble Ticket | 5.0.1 | `/tmf-api/troubleTicket/v5` | `troubleTicket`, `hub` | `tmf621-v5.0.0-ctk-1.0.1` | 3 |
| TMF688 Event | 4.0.0 (pre-production) | `/tmf-api/event/v4` | `topic`, `topic/{id}/event`, `topic/{id}/hub`, `hub` | none: OpenAPI contract tests | 3 |
| TMF632 Party | 5.0.0 | `/tmf-api/partyManagement/v5` | `individual`, `organization`, `hub` | `tmf632-v5.0.0-ctk-1.0.1` | 4 |
| TMF669 Party Role | 5.0.0 | `/tmf-api/partyRoleManagement/v5` | `partyRole`, `partyRoleSpecification`, `hub` | `tmf669-v5.0.0-ctk-1.0.1` | 4 |
| TMF672 User Role Permission | 5.1.0 | `/tmf-api/rolesAndPermissionsManagement/v5` | `permissionSpecification`, `permissionSpecificationSet`, `permissionSet`, `checkPermission`, `hub` | `tmf672-v5.1.0-ctk-1.0.1` | 4 |
| TMF638 Service Inventory | 5.0.0 | `/tmf-api/serviceInventoryManagement/v5` | `service`, `hub` | `tmf638-v5.0.0-ctk-1.0.1` | 4 |
| TMF639 Resource Inventory | 5.0.0 | `/tmf-api/resourceInventory/v5` | `resource`, `hub` | `tmf639-v5.0.0-ctk-1.0.1` | 4 |
| TMF641 Service Ordering | 4.2.0 (no stable v5) | `/tmf-api/serviceOrdering/v4` | `serviceOrder`, `cancelServiceOrder`, `hub` | `tmf641-v4.2.0-ctk-1.0.0` | 4 |
| TMF622 Product Ordering | 5.0.0 | `/tmf-api/productOrderingManagement/v5` | `productOrder`, `cancelProductOrder`, `hub` | `tmf622-v5.0.0-ctk-1.0.1` | 4 |

The documents' `servers` entries are inconsistent (`https://serverRoot`, `{apiRoot}` with a default, a full path, and none of the v5 defaults contains `/tmf-api`), and the user guides' examples disagree with them too, so a base path follows the pinned kit's default `url` in the kit's `config.json` [checked: the `config.json` of each of the eight pinned kits; TMF688, which has no kit, from its swagger `basePath` `/tmf-api/event/v4/`; decision 0026, F638-04, F632-01, F688-07]. TMF638's kit uses `/tmf-api/serviceInventoryManagement/v5`, not the `serviceInventory` of its guide's examples. A kit that disagrees after a pin moves wins. The pinned OpenAPI documents (Apache-2.0) are vendored under `packages/tmf/specs/` with their source URL and SHA-256, and `@std/tmf`'s tests check that each base path equals its kit's default `url`.

- **One enforcement point.** A TMF API is an adapter over the record service: every read is a generic read of the mapped classes, every write a save or nested saves in one request transaction (4.1), as the calling user. No mapping reads or writes a table directly, and no mapping uses `WriteAccess.allowAll`. So access rules, masks, history, the outbox and stale checks apply unchanged, and a TMF API can never show or accept more than the generic API would. An attribute the caller cannot read is absent from the resource, and a filter on it is `UnknownField` (3.4) rendered as a TMF `Error`.
- **Where mappings live.** A mapping is code in `@std/tmf` (plain package: attribute and state maps, query translation, event rendering, payload shapes) plus its routes in `server/http/tmf/`; it names fields by the stable IDs of the shipped sets, so renames never break it. The classes come from shipped sets: `core` (parties), `helpdesk` (tickets, changes, requests), `cmdb` (configuration items). A mapping covers its class and every descendant, local ones included.
- **`@type` and local classes.** A shipped class renders the TMF type its mapping names. A local child class of a mapped class renders `@type` = its qualified STD name, `@baseType` = the TMF type of its nearest mapped ancestor, and `@schemaLocation` = its JSON Schema, which adds its local attributes (with API names, 10.2) to the pinned TMF schema [checked: the v5 extension pattern; judgment on names]. `POST` with such an `@type` creates that class.
- **Embedded arrays.** A TMF array either maps onto STD reference fields and child records (when its items name STD records: notes, related parties, order items, relationships) or is stored whole in a `json` field (value objects STD does not interpret: characteristics, contact media, external references, prices). Each mapping table says which. Child records are **aggregate parts** of the parent (4.9): their reference to it is its class's owner reference, so every write of a part, through any surface (generic API v1 or v2, TMF APIs, imports, hooks and rules), locks the aggregate and changes its version, history and events in the same transaction [resolved question 20]. A TMF write saves the owner's own attributes at most once and its parts as needed, and the owner is then persisted once more if a part or derived state changed (4.9). The TMF `DELETE` deletes the parts, innermost first and each authorized for the caller, then the owner; a deleted owner is not finalized (4.9). A generic `DELETE` of an owner that has parts is still `Referenced` (3.10).
- **Versions.** TMF responses carry `ETag: "<parent version>"`. `If-Match` is optional on TMF writes: present, it is checked as in 6.7; absent, the write applies to the version it locks [judgment: the CTKs and TMF clients send no precondition; the generic API keeps it required, 10.5].
- **Queries, paging, errors, hubs** follow 10.3, 10.4, 10.6 and 12, with TMF attribute names. Filters on an attribute stored as json or as an array are `InvalidFilter` reason `attributeNotFilterable` [judgment: the condition AST has no "any element" operator; the conformance runs record whether a kit needs one; exclusion E16]. Filtering on sub-resources is optional in every conformance profile checked [checked: TMF621 CP v5.0.0, API GET Operation Conformance p.7; TMF688 CP v4.0.0 pp.9-10; TMF632, TMF669 and TMF672 profiles (decision 0026, F632-05)].
- **Unsupported resources** of an API (for example `troubleTicketSpecification`) answer `404` with a TMF `Error` and are listed in the API's conformance note; a kit that requires one is a gap, not a pass.
- **Conformance gate.** CI downloads each pinned kit by URL, checks its SHA-256 and the image digest, never commits it, writes its `config.json` (base URL on the `tmf` Docker network, a bearer token for the `tmf_ctk` test user, payloads naming seeded STD records), runs the kit's compose service directly (not `run.sh`, which opens a browser), and decides from the report alone, never from the container's exit code: the TMF621 kit's entrypoint runs `npm start || true` and so exits 0 when tests fail [checked for TMF621's kit only; the runner trusts no kit's exit code]. The runner (`tooling/ctk/run.ts`) passes a kit only when all of these hold:
  - `reports/index.json` exists, parses, and was written by this run (its start time is after the run's start, and the reports directory was empty before);
  - `ctk_version.txt` names the pinned image;
  - `stats.failures`, `stats.pending` and `stats.skipped` are 0, and `stats.passes` equals `stats.tests`;
  - every expected mandatory case for that kit passed: the requirements matrix (15) lists the kit's mandatory test titles at the pinned version, and each must appear among the passed tests by exact title.

  Every TMF response in every test also validates against the pinned OpenAPI document (`tmf-oas-contract`). Reports are kept as CI artifacts, so a certification submission can reuse them. Version labels can differ: the TMF621 OpenAPI document is v5.0.1 while its kit and its conformance profile's cover say 5.0.0 (`tmf621-v5.0.0-ctk-1.0.1`; TMF621B v5.0.0) [checked: TMF621 UG v5.0.1 release history p.106, where 5.0.1 only fixes examples]; the pin records both.

### 11.2 TMF621 Trouble Ticket over ITIL incident and problem (Step 3)

The helpdesk set v3 (decision 0021) rebuilds `helpdesk.ticket` as the TroubleTicket base, `helpdesk.incident` and the new `helpdesk.problem` extending it. Notes are `helpdesk.ticket_note` records and other related parties `helpdesk.ticket_party` records, both referencing their ticket.

Operations [checked: TMF621 CP v5.0.0, TroubleTicket Mandatory Operations p.6 and the GET, POST, PATCH and DELETE sections pp.7-10]: `GET /troubleTicket`, `GET /troubleTicket/{id}` (`404` when absent), `POST /troubleTicket` (`201`) and `DELETE /troubleTicket/{id}` (`204`) are mandatory; `PATCH` is optional (`200`, merge-patch mandatory when offered), and STD serves it. TroubleTicket is the only mandatory resource; `hub` and `troubleTicketSpecification` are optional [checked: CP p.2]. Every ticket, however it was created (TMF621, `/api/v2`, a form, an import), renders the attributes the profile makes mandatory in responses, non-blank: `@type`, `href`, `description`, `severity` and `ticketType` [checked: CP pp.2-3]. So `description` is required on `helpdesk.ticket` itself, `impact` always has a value, and `ticketType` always renders from the class or `ticket_type` (`tmf621-mandatory-output`).

| TMF621 attribute | STD | Read-only | Notes |
| --- | --- | --- | --- |
| `id`, `href` | `id` | yes |  |
| `@type` | `TroubleTicket` for the shipped classes; a local class's own name (11.1) | yes | [judgment: the kit and TMF clients post `TroubleTicket`; the ITIL class is carried by `ticketType`] |
| `ticketType` | the concrete class: `incident`, `problem`; any other value creates a `helpdesk.ticket` and is stored in `ticket_type` | after create | Required on create [checked: TMF621 CP v5.0.0 p.8; UG v5.0.1 pp.69-70; OAS `TroubleTicket_FVO`]. Free text in TMF621 [checked: UG p.8] |
| `name` | `short_description` (display field) | no | When absent on create, a shipped before-write rule fills it from the first line of `description`, cut to 160 code points |
| `description` | `description` | no | Required on create [checked: as `ticketType`] |
| `severity` | `impact`: `Critical` ↔ 1, `Major` ↔ 2, `Minor` ↔ 3 | no | Required on create [checked: as `ticketType`]; other values `ValidationFailed`. TMF621's `severity` is free text with these three as examples [checked: OAS, no enum; UG p.8]; decision 0026 M5 asks Martin whether to accept other values |
| `priority` | `priority` label: `Critical`, `High`, `Medium`, `Low`, `Planning` (1 to 5) | yes | Computed from impact and urgency (14.2) |
| `status` | `status` (and `hold_reason`), table below | no | Writes follow the state model (14.2, 14.3) |
| `statusChangeDate`, `statusChangeReason` | `status_changed_at` (set by the pipeline rule on every status change), `status_reason` | date only |  |
| `statusChangeHistory[]` | the status changes in the record's history (3.7) | yes | Absent when the caller cannot read `status` |
| `creationDate`, `lastUpdate` | `created_at`, `updated_at` | yes |  |
| `requestedResolutionDate`, `expectedResolutionDate`, `resolutionDate` | `requested_resolution_at`, `expected_resolution_at`, `resolved_at` (set on entering `resolved`) | `resolutionDate` |  |
| `channel` | `channel` choice: key ↔ `ChannelRef.id`, label ↔ `name` | no |  |
| `note[]` | `helpdesk.ticket_note`: `author` (reference to `core.user`, rendered as its display name), `date` (= `created_at`), `text` | existing notes | Append-only: a write may add notes; changing or removing an existing one is `ValidationFailed` [judgment: ITIL work notes are a journal] |
| `relatedParty[]` | role `reporter` ↔ `caller` (reference to `core.party`); role `assignee` ↔ `assigned_to` (`core.user`, rendered as its individual, 11.3); other roles ↔ `helpdesk.ticket_party` (`party`, `role`) | no | Writes resolve `partyOrPartyRole.id` to the party, or for `assignee` to the user whose individual it is. Each item renders `{"@type": "RelatedPartyRefOrPartyRoleRef", role, partyOrPartyRole: {"@type": "PartyRef", id, name, "@referredType"}}` (11.3 for `href`); a write without `role` or `partyOrPartyRole.id` is `ValidationFailed` [checked: TMF621 CP v5.0.0 p.3]. Roles are free text in TMF621; `reporter` and `assignee` are STD's names |
| `troubleTicketRelationship[]` | `relationshipType` `causedBy` ↔ an incident's `problem` (reference to `helpdesk.problem`); `parent` ↔ `parent_incident` | no | Each item renders `@type` `TroubleTicketRelationship`, `id` and `relationshipType` [checked: TMF621 CP v5.0.0 p.4]. `relationshipType` is free text [checked: OAS, no enum], so other types are kept as given in json `ticket_relationship` |
| `relatedEntity[]` | role `affectedConfigurationItem` ↔ `configuration_item` (reference to `cmdb.ci`, from helpdesk v4 in Step 4); role `change` ↔ `caused_by_change` (Step 4); anything else kept as given in json `related_entity` | no |  |
| `troubleTicketCharacteristic[]` | `urgency` ↔ `urgency` (1 to 3), `majorIncident` ↔ `major_incident`, `holdReason` ↔ `hold_reason`, `resolutionCode` ↔ `resolution_code`, `resolutionNotes` ↔ `resolution_notes`; problems: `knownError`, `workaround`, `rootCause`; any other characteristic kept in json `characteristic` | per field | Typed as the v5 characteristic subtypes |
| `externalIdentifier[]` | first item `{owner: "STD", externalIdentifierType: "number", id: <number>}` (read-only), then json `external_identifier` | the first item |  |
| `attachment[]` | json `attachment` (references and URLs only) | no | Attachments are a later field type (exclusion E22). Each item needs `@type`, `id`, `attachmentType` and `mimeType` [checked: TMF621 CP v5.0.0 p.3; OAS `Attachment_FVO`], else `ValidationFailed`; inline `content` is refused |
| `troubleTicketSpecification` | not supported (11.1) |  |  |

- **Sub-resources** carry `@type` and, where the profile requires it, `id` [checked: TMF621 CP v5.0.0 pp.2-4]: `ChannelRef` (`id` the choice key), `Note` (`id` the `helpdesk.ticket_note` ID), `ExternalIdentifier`, `RelatedEntity` (with `entity.@type` and `entity.id`), `StatusChange`, and the characteristic subtypes. A mapped characteristic renders `id` = its name (`urgency`, …) and `@type` `IntegerCharacteristic`, `BooleanCharacteristic` or `StringCharacteristic`; a json-stored characteristic, external identifier or related entity must carry the attributes the profile names for it, and a characteristic without `id` gets one on write.
- **Read-only although the guide lists them as patchable** [checked: TMF621 UG v5.0.1 pp.73-74]: `priority` (the guide itself calls it set by the system, p.8), `statusChangeHistory` (populated by the server, p.8), `resolutionDate` (set on entering `resolved`) and `ticketType` after create (decision 0026 M6). A write of one of them is `ReadOnlyField` unless its value is unchanged (3.9), and each is a deviation row in the requirements matrix.

Status (TMF621's introduction calls its states an example set, but `status` is a closed enumeration of eight values [checked: TMF621 UG v5.0.1 p.1 and p.8; OAS `TroubleTicketStatusType`], so STD renders only these eight and maps its ITIL states onto them; the guide's life-cycle diagram, p.2, exists only as a figure):

| TMF621 `status` | Incident (read) | Problem (read) | On write |
| --- | --- | --- | --- |
| `acknowledged` | `new` | `new`, `assess` | incident `new`; problem unchanged if in the group, else `new` |
| `inProgress` | `in_progress` | `root_cause_analysis`, `fix_in_progress` | incident `in_progress`; problem unchanged if in the group, else `root_cause_analysis` |
| `pending` | `on_hold` with `hold_reason` `awaiting_caller` | none | incident `on_hold` + `awaiting_caller`; problem `ValidationFailed` |
| `held` | `on_hold` with another `hold_reason` | none | incident `on_hold`, `hold_reason` from the characteristic, else `awaiting_vendor`; problem `ValidationFailed` |
| `resolved` | `resolved` | `resolved` | `resolved` (14.2 needs resolution code and notes) |
| `closed` | `closed` | `closed` | `closed` |
| `cancelled` | `canceled` | `canceled` | `canceled` |
| `rejected` | `canceled` with `status_reason` `rejected` | the same | `canceled`, `status_reason` `rejected` |

- A filter `status=pending` compiles to `status = on_hold and hold_reason = awaiting_caller`, `status=inProgress` to the `in` of its group, so TMF filters and reads agree (`tmf-filter-equivalence` covers TMF621).
- Events (12.3): `TroubleTicketCreateEvent`, `TroubleTicketAttributeValueChangeEvent`, `TroubleTicketStatusChangeEvent` (TMF `status` changed), `TroubleTicketResolvedEvent` (entered `resolved`), `TroubleTicketInformationRequiredEvent` (entered `pending`; without the optional `informationRequired` patch), `TroubleTicketDeleteEvent` [checked: TMF621 UG v5.0.1 p.38; none is mandatory, CP v5.0.0 p.5].

### 11.3 TMF632 Party, TMF669 Party Role and TMF672 User Role Permission (party foundation in Step 3, the three APIs in Step 4)

The core set gains a party model in Step 3, because TMF621's `relatedParty` and the helpdesk's `caller` name parties and users' individuals [judgment: tickets, CIs and orders all name parties, so it belongs in `core`]: `core.party` (root: `name` as display field, `status`), `core.individual` (`given_name` and `family_name`, both required, `name` filled from them by a core rule, `birth_date`, json `contact_medium`, `individual_identification`, `external_reference`, `party_characteristic`), `core.organization` (`name` required, `trading_name`, `is_legal_entity`, `organization_type`, `exists_from`, `exists_until`, json `organization_identification`), `core.party_role` and `core.party_role_specification`. `core.user` gains `individual` (unique reference to `core.individual`), created with the user by a core hook; JIT users from the identity provider (13.4) get one too. Existing users get theirs from a `data` migration (1.9) in the same upgrade. Until Step 4 serves TMF632, a `PartyRef` in TMF621 carries `id`, `name` and `@referredType` but no `href` [judgment]. The TMF632, TMF669 and TMF672 adapters, `core.party_role`'s use in them, and the TMF672 hub that the Canvas listens to are Step 4.

| TMF resource | STD | Notes |
| --- | --- | --- |
| TMF632 `Individual` | `core.individual` | `givenName`, `familyName` required [checked: TMF632 CP v5.0.0 pp.6, 21; OAS `Individual_FVO`]; `status` choice `initialized`, `validated`, `deceased` [checked: OAS `IndividualStateType`]. GET, POST, PATCH (merge) and DELETE are mandatory [checked: CP p.18]; an individual a user or a ticket references is `Referenced` on delete (3.10), so the kit's payloads delete only parties it created |
| TMF632 `Organization` | `core.organization` | `name` required [checked: TMF632 CP v5.0.0 pp.11, 21]; `status` choice `initialized`, `validated`, `closed` [checked: OAS `OrganizationStateType`]; `tradingName` is mandatory in responses, not on create [checked: CP p.11], so it renders `name` when `trading_name` is empty. Operations as `Individual` |
| TMF669 `PartyRole` | `core.party_role`: `name`, `role`, `engaged_party` (reference to `core.party`), `party_role_specification`, `status` (text: the spec has no enum [checked: TMF669 OAS `PartyRole`; CP v5.0.0 p.13]), `status_reason`, `valid_from`, `valid_until`; json for characteristics, accounts, agreements, contact media, payment methods, credit profiles | `name` and `engagedParty` required [checked: TMF669 CP v5.0.0 p.13; OAS `PartyRole_FVO`]. PartyRole is TMF669's only mandatory resource, with GET, POST, PATCH and DELETE [checked: CP pp.5, 11]. Business roles (customer, supplier, agent); they grant no STD access [judgment] |
| TMF669 `PartyRoleSpecification` | `core.party_role_specification`: `name`, `description`, `status`, `lifecycle_status`, `permission_specification_set` (references to `core.role`: TMF669's `permissionSpecificationSet` is an array [checked: TMF669 OAS `PartyRoleSpecification`; UG v5.0.0 p.77]) | Optional in TMF669 [checked: CP v5.0.0 p.5]. The link from a business role to an STD role is informational in v0.1: TMF672's guide intends a set on a party role specification to grant its permissions to every party playing the role (TMF672 UG v5.1.0 p.15), and STD deliberately does not [judgment: party roles grant no access] |
| TMF672 `PermissionSpecificationSet` | `core.role` (config): `name`, `label` as description | Writes run as one-operation change sets with the caller as requester (1.4); `permissionSpecification[]` lists the role's projected rules, and the profile requires at least one, in responses and on `POST` [checked: TMF672 CP v5.1.0 pp.14, 22]. A `POST` item given by reference adds the set's role to that rule; one given by value creates an allow rule as `PermissionSpecification` `POST` does; a reference to a read-only rule (below), multi-action rules included, is `NotRepresentable`, because adding a role there would grant every action. Events come from config subscriptions on `role` (4.6): create → Create, a change to `name` or `label` (override included) → AttributeValueChange, retire or delete → Delete [judgment: a retired role grants nothing]; an access-rule change gives an AttributeValueChange of every set whose role the rule names before or after, from that role's own version bump (4.6), so all of a set's events follow the role's version order |
| TMF672 `PermissionSpecification` | a projection of one access rule and one action: `function` = the rule's class (`*` as `*`), `action` = `read`, `create`, `update` or `delete`; `id` = UUIDv5 of the rule's ID and the action; `name` (mandatory in responses [checked: TMF672 CP v5.1.0 p.13]) = the rule's name, else `<class> <action>`; `specificationCharacteristic` entries (the resource has no `characteristic`) carry `effect`, `target`, `fields` and the condition in the text syntax | `POST` creates an allow rule on records of `function` for `action` with no condition and no role; adding it to a set adds the set's role to the rule's `roles`. A rule that is a deny, targets fields, has a condition or several actions is read-only through TMF672 (`PATCH` and `DELETE` give `NotRepresentable`, 422) [judgment, resolved question 11; `PATCH` and `DELETE` are optional on every TMF672 resource: TMF672 CP v5.1.0 pp.6, 23-24]. A `function` that names no class the caller knows, or an `action` other than the four, is `ValidationFailed` (the kit's default payloads use placeholders, so STD's kit `config.json` names real ones). A `POST`ed `specificationCharacteristic` is ignored |
| TMF672 `PermissionSet` | `core.user_role` (gains `valid_from`, `valid_until`): `user` ↔ a `RelatedSecurityPrincipal` whose `securityPrincipal` is a `PartyRef` to the user's individual and whose mandatory `role` is the STD role's name; `permissionSetSpecification` (the set reference; `permissionSpecificationSet` exists only inside each `Permission`) ↔ the role; `granter` ↔ `created_by`'s individual, with `role` `granter`; `permission[]` derived, read-only [checked: TMF672 OAS `PermissionSet`; CP v5.1.0 pp.12-13; UG v5.1.0 p.38] | A `PermissionSet` with ad-hoc `permission[]` and no set is `NotRepresentable`; a principal other than a `PartyRef` to a user's individual is `InvalidReference`. `POST permissionSet` is mandatory and its required input is `user` and `permission[]`, not a set (CP pp.6, 9, 21-22), so decision 0026 M9 asks Martin how much of it to accept |
| TMF672 `CheckPermission` | explain mode (Step 4): for `user`, `permissionSpecification` and each `entity`, the decision and the rule that decided | A task resource; needs the `access.explain` permission, and entities the caller cannot see answer as missing |

- Effective roles (3.1, 13.4) are `authenticated`, the user's `core.user_role` rows valid now, and, for OIDC sessions, the token's role claims that name live STD roles. A role name STD does not know grants nothing.
- Events: TMF632 and TMF669 have the Create, AttributeValueChange, StateChange (where the resource has a status) and Delete events of each resource; TMF672 has Create, AttributeValueChange and Delete for `PermissionSpecification`, `PermissionSpecificationSet` and `PermissionSet` (no StateChange), and Create and StateChange for `CheckPermission`; no profile makes one mandatory [checked: TMF632 UG v5.0.0 p.50; TMF669 UG v5.0.0 p.92; TMF672 UG v5.1.0 p.71 and CP v5.1.0 p.17; decision 0026, F672-09].

### 11.4 TMF638 Service Inventory and TMF639 Resource Inventory: the CMDB (Step 4)

The `cmdb` app set (requires `core`): `cmdb.ci` (root: `name`, `description`, `category`, `owned_by` reference to `core.party`, `lifecycle` choice, json `characteristic`, `external_identifier`, `place`), `cmdb.ci_relationship` (`source` and `target` references to `cmdb.ci`, `relationship_type` choice, unique per triple), `cmdb.service` and `cmdb.resource` extending `cmdb.ci`, `cmdb.logical_resource` and `cmdb.physical_resource` extending `cmdb.resource`, `cmdb.software_resource` and `cmdb.resource_function` extending `cmdb.logical_resource` (as `SoftwareResource` and `ResourceFunction` extend `LogicalResource` in TMF639 [checked: TMF639 OAS v5.0.0; UG v5.0.0 p.16]), and `cmdb.service_specification` and `cmdb.resource_specification` (`name`, `version`).

| TMF | STD | Notes |
| --- | --- | --- |
| TMF638 `Service` | `cmdb.service`: `service_specification` (required reference), `state` choice `feasibilityChecked`, `designed`, `reserved`, `inactive`, `active`, `terminated`, `suspended` (v5.0.0 [checked]), `operating_status` choice (10 values [checked]), `service_type`, `is_bundle`, `is_service_enabled`, `has_started`, `start_mode`, `is_stateful`, `start_date`, `end_date`; json `feature`, `intent`; `serviceDate` ↔ `created_at` (read-only; mandatory in responses and non-patchable [checked: TMF638 CP v5.0.0 pp.5-6, 20; UG v5.0.0 p.13]) | `@type`, `serviceSpecification` (with `id` and `@type`) and `state` required on `POST`; `href`, `id` and `serviceDate` in every response [checked: TMF638 CP v5.0.0 pp.5-6, 19; OAS `ServiceStateType`, `ServiceOperatingStatusType`]. GET, POST and PATCH are mandatory, DELETE and the hub optional, and no notification is mandatory [checked: CP pp.5, 16-17]. `serviceSpecification` is a reference to an STD record, not to a TMF633 catalog (out of scope) |
| `serviceRelationship[]`, `supportingService[]`, `supportingResource[]` | `cmdb.ci_relationship` rows with `relationship_type` = the TMF relationship type, `supportingService` or `supportingResource` | Real references, so a CI with relationships cannot be deleted while they exist (3.10); the TMF `DELETE` removes the CI's own outgoing relationships first. A `serviceRelationship` item renders `@type` and `relationshipType`, and its `service` the target's `id`, `@type`, `serviceDate`, `serviceSpecification` and `state` [checked: TMF638 CP v5.0.0 p.9] |
| `serviceOrderItem[]` | change items referencing the service (11.5) | read-only |
| TMF639 `Resource` and subtypes | `cmdb.resource`, and `@type` `LogicalResource`, `PhysicalResource`, `SoftwareResource`, `ResourceFunction` ↔ the four child classes | Only `@type` required [checked: TMF639 UG v5.0.0 p.82; the conformance profile's mandatory-attribute tables are unrendered placeholders in the published PDF, CP v5.0.0 pp.5-10]; `POST` with a subtype creates that class (10.5); `@baseType` of a software resource or resource function is `LogicalResource` |
| resource states | choices `administrative_state` (`locked`, `unlocked`, `shuttingDown`), `operational_state` (`enabled`, `disabled`), `usage_state` (`idle`, `active`, `busy`), `lifecycle_state` (`planned`, `installed`, `pendingRemoval`); the other v5 status attributes in json `status_detail` | [checked: TMF639 OAS v5.0.0 `Resource{Administrative,Operational,Usage}StateType`, `ResourceLifecycleStateType` (as named there)]; the other six status attributes (`alarmStatus`, `allocationStatus`, `availabilityStatus`, `controlStatus`, `proceduralStatus`, `unknownStatus`), and `PhysicalResource`'s power and standby states, go to `status_detail` |
| `resourceRelationship[]` | `cmdb.ci_relationship` |  |

- ITIL configuration records are these records; ITIL "configuration item classes" are STD classes, so local CI types are local child classes and appear in TMF639 or TMF638 with their own `@type` (11.1).
- Events: Create, AttributeValueChange, StateChange (any mapped state attribute changed), Delete; TMF638 also `ServiceOperatingStatusChangeEvent` [checked].

### 11.5 TMF641 Service Ordering and TMF622 Product Ordering: change and service requests (Step 4)

The helpdesk set v4 adds `helpdesk.change` (ITIL change request) with `helpdesk.change_item`, `helpdesk.change_cancellation`, `helpdesk.request` (ITIL service request) with `helpdesk.request_item`, `helpdesk.request_cancellation`, `helpdesk.catalog_item` (a minimal request catalog: `name`, `description`, `approval_required`, `fulfilment_group`) and approvals: `helpdesk.approval` with its two classes `helpdesk.change_approval` and `helpdesk.request_item_approval` (14.4).

| TMF641 v4.2.0 `ServiceOrder` | `helpdesk.change` | Notes |
| --- | --- | --- |
| `category` | `change_type` choice `standard`, `normal`, `emergency` | [judgment: the ITIL change type is the order's category] |
| `description`, `priority` | `description`, `priority` |  |
| `requestedStartDate`, `requestedCompletionDate`, `expectedCompletionDate`, `startDate`, `completionDate`, `orderDate` | `planned_start`, `planned_end`, `expected_end`, `actual_start`, `actual_end`, `created_at` | the last three read-only |
| `serviceOrderItem[]` | `helpdesk.change_item`: `item_id` (text, unique per change), `action` (`add`, `modify`, `delete`, `noChange`, `other` [checked: TMF641 v4.2.0 swagger `ServiceOrderItemActionType`]; `noChange` and `other` have no CMDB effect), `service` (reference to `cmdb.service`), json `service_value` (the TMF service value, kept as given) with `service_name`, `service_specification` and `target_state` taken from it for `add` and `modify` (14.4), `state` (TMF641 item `state`: `acknowledged` while the change is open, `completed` or `failed` after it closes (14.4), `cancelled` when it is canceled or rejected) | `serviceOrderItem`, and per item `id`, `action`, `service` required [checked: TMF641 CP v4.2.0 §2.3 p.7, §5.1 p.14]. A `POST` that sets `state`, `cancellationDate`, `cancellationReason`, `completionDate`, `orderDate` or an item's `state` is `ReadOnlyField`; a change is created `new` [checked: TMF641 spec v4.2.0 p.74] |
| `state` | `status` and `close_code`, table below |  |
| `note[]`, `relatedParty[]`, `externalReference[]`, `orderRelationship[]` | as 11.2; `requested_by` ↔ role `requester`, change authority ↔ role `changeAuthority` |  |
| `CancelServiceOrder` | `helpdesk.change_cancellation`: `change`, `reason` (`cancellationReason`), `requested_date`, `state` (`accepted`, `inProgress`, `done`, `terminatedWithError` [checked: TMF641 v4.2.0 swagger `TaskStateType`]), `completion_message` (`completionMessage`) | 14.4 says when it succeeds. `done` means the request was assessed, whether the change was canceled or kept; `terminatedWithError` means the assessment could not be completed, not that it was refused [checked: TMF641 spec v4.2.0 p.53], so STD uses it only for an internal failure. `serviceOrderSpecification` and `cancelServiceOrder` are optional; `serviceOrder` with GET and POST is TMF641's only mandatory resource [checked: TMF641 CP v4.2.0 §2.1 p.6, §3.1 p.12] |

| ITIL change `status` | TMF641 `state` |
| --- | --- |
| `new`, `assess` | `acknowledged` |
| `authorize` | `pending` |
| `scheduled`, `implement`, `review` | `inProgress` |
| `closed` with `close_code` `successful`, `unsuccessful`, `partial` | `completed`, `failed`, `partial` |
| `canceled` | `cancelled` |
| `rejected` | `rejected` |

TMF641 never shows `held` (an ITIL change has no hold state), and never `assessingCancellation` or `pendingCancellation`, because a cancellation is decided in the transaction that requests it (14.4) [judgment; matrix exclusions, 15.3; neither state nor the Milestone, Jeopardy and ErrorMessage events is mandatory: TMF641 CP v4.2.0 has no notification section, TMF622 CP v5.0.0 p.17 makes no notification mandatory]. TMF622 v5.0.0 `ProductOrder` maps onto `helpdesk.request` the same way: `productOrderItem[]` ↔ `helpdesk.request_item` (items need `id`, `action` and `@type` [checked: TMF622 CP v5.0.0 p.6; OAS `ProductOrderItem_FVO`]; `item_id`, `action`, `product_offering` reference to `helpdesk.catalog_item`, `quantity`, json `product`, `state`); `requestedInitialState` `draft` ↔ status `draft`, otherwise `submitted`; request states `draft` ↔ `draft`, `acknowledged` ↔ `submitted`, `pending` ↔ `awaiting_approval`, `inProgress` ↔ `in_fulfilment`, `held` ↔ `on_hold`, `completed` ↔ `fulfilled`, `partial` ↔ `partially_fulfilled`, `failed` ↔ `failed`, `rejected` ↔ `rejected`, `cancelled` ↔ `canceled`; item states the same, with item `draft` and `new` both `acknowledged` (TMF622's item states have no `draft`); `CancelProductOrder` ↔ `helpdesk.request_cancellation`, decided in the transaction that creates it (14.4), so `assessingCancellation` and `pendingCancellation` never show; neither does `inProgress.accepted`, which only the OpenAPI document lists, nor item `partial`, which the guide says does not exist at item level (TMF622 UG v5.0.0 p.8). TMF622's `TaskStateType` has no `accepted` [checked: OAS; UG v5.0.0 p.9], so a cancellation STD holds as `accepted` renders `acknowledged`, and one refused renders `done` with the reason in `cancellationReason`. Billing account, agreements, quotes, prices and payments are json, kept as given [judgment: STD is not a commerce system]. Events: each API's Create, AttributeValueChange, StateChange, Delete and InformationRequired events; Milestone, Jeopardy and ErrorMessage events are not produced in v0.1 [judgment].

### 11.6 Acceptance tests

- `tmf-ctk-<api>` for every row of 11.1 with a kit: passed under the runner's criteria (11.1), report kept.
- `ctk-runner`: the runner itself, against fixture reports: one failing test, one skipped, one pending, a missing expected case, a malformed `index.json`, a missing report, a report older than the run and a wrong `ctk_version.txt` each fail; a clean fixture passes.
- `tmf-oas-contract`: every TMF response of every test validates against the pinned OpenAPI document.
- `tmf-noninterference`: Bob's view through TMF621 of tickets with hidden fields equals his generic view: a hidden field is an absent attribute, a filter on it is `UnknownField`, an invisible ticket is `NotFound` identical to a random ID, and the `noninterference` property holds through TMF621 queries.
- `tmf-local-class`: a local `local.vip_incident` extending `helpdesk.incident` appears in TMF621 with its own `@type`, `@baseType` `TroubleTicket` and a schema naming its local field; a `POST` with that `@type` creates it.
- `tmf621-mandatory-output`: tickets, incidents and problems created through `/api/v2`, a form and an import read through TMF621 with non-blank `@type`, `href`, `description`, `severity` and `ticketType`, and every sub-resource with the attributes 11.2 lists.
- `tmf-arrays`: adding a note through TMF621 creates one `helpdesk.ticket_note`, bumps the ticket's version once for the note and writes one change entry per version; adding a note through the generic API does the same; changing an existing note is refused with nothing written.
- `party-foundation`: upgrading a `v0.0.2` database with 1,000 users gives each exactly one individual through the `data` migration, with change entries; killing `std upgrade` mid-migration and rerunning completes it, and a second rerun changes nothing; users created concurrently with the migration end with exactly one individual each.
- `tmf672-roles`: a set created through TMF672 is a `core.role` with a change-set journal entry; a non-admin's TMF672 write is refused exactly as the generic write is; a conditional rule is read-only through TMF672.

## 12. Events: hubs, listeners and TMF688 (Step 3)

### 12.1 What an event is

- An event is one rendering of one committed change entry (4.2) for one API: the generic API (`Record*Event`), or a TMF API for its mapped classes (11). It is produced only from the outbox: one delivery row per matching subscription and change, written in the save transaction (4.6). So no event exists for a rolled-back save, and per subscription and record events follow version order (4.7).
- Envelope [checked: v5 `Event`; `@type` is the event type and `@baseType` `Event`: TMF621 UG v5.0.1 p.40 samples, OAS `TroubleTicket*Event` schemas, TMF630 v5.0.0 Part 1 §11.5-11.6 pp.194-199]: `{"@type": "<eventType>", "@baseType": "Event", "id" (= `eventId`), "href" (where the API serves events, TMF688), "eventId", "eventTime", "eventType", "timeOccurred", "correlationId", "domain", "title", "description", "priority", "source", "event": {"<resourceName>": <resource>}}`. `eventId` is the UUIDv5 of the change ID and the event type, so a retry sends the same `eventId` and two types of one change differ [judgment]. `timeOccurred` is the change's `occurred_at`; `eventTime` is when the delivery was rendered; `correlationId` is the operation ID (4.2); `domain` is the API name; `source` is an EntityRef to the record.
- Payload per event kind [checked: TMF630 v5.0.0 Part 1 §11.6.1-11.6.4 pp.199-204]: a Create event carries the resource as the identity may read it; an AttributeValueChange event carries `id`, `href`, `@type` and the readable changed attributes (a merge-patch delta); a StatusChange or StateChange event carries at least the status; a Delete event carries only `id` and `href`.
- Event types per change: generic API `RecordCreateEvent`, `RecordAttributeValueChangeEvent`, `RecordDeleteEvent`; each TMF API its own (11.2 to 11.5), where one change can give several (an update that changes the TMF status gives AttributeValueChange and StatusChange) [checked: the TMF621 notification list].
- **Event authorization.** Whether an event exists can reveal as much as its payload, so every event type is authorized by what triggered it, at delivery time, for the subscription's identity, under the rules current then (4.5), with conditional fields evaluated per record (3.4, 3.5):
  - the record must be visible to the identity on the version's own image (the before image for a delete);
  - each event type names its **trigger fields**, which must be readable by the identity on the before image and on the after image, and a trigger field that is derived counts as readable only when every one of its sources is too: a TMF attribute's sources are those its mapping names, and a stored field's sources are the fields that the active record rules writing it read (from the dependency index, `rule_writes` and `condition_reads`, 1.7, transitively) [judgment: events are stricter than reads here, because an event's existence is all a listener needs to learn that a hidden source changed]: Create and Delete none beyond visibility; AttributeValueChange at least one changed attribute, and only the readable changed attributes are reported; StatusChange and StateChange the fields its TMF status or state is derived from (TMF621: `status` and `hold_reason`); Resolved and InformationRequired the same as StatusChange; OperatingStatusChange `operating_status`; an aggregate save (4.9) the owner's array attributes whose parts changed, which needs at least one changed part visible and its array attribute readable, plus the sources of any derived field the save changed;
  - a **derived attribute** in the payload (TMF621 `status`, `priority`, `statusChangeHistory`; TMF641 `state`; any rule-computed field) is present only when every field it is derived from is readable on that image; the rest of the payload is masked as in 4.5;
  - an event that fails any check is not sent, and its delivery is marked `done` with the reason `notAuthorized`, without a listener call [judgment: retrying would not change the decision].

### 12.2 Hubs

- Every API has `POST /hub` (`{callback, query}`, `@type` optional, `201` with `Location` and `{"@type": "Hub", id, href, callback, query}`), `GET /hub/{id}` (`200`) and `DELETE /hub/{id}` (`204`); `PATCH /hub/{id}` is `405` [checked: TMF621 OAS v5.0.1 `/hub`, `/hub/{id}`; TMF630 v5.0.0 Part 1 §11.1-11.4 pp.184-194; TMF621 UG v5.0.1 p.103's prose says 204, its sample and the OAS 201]. TMF688 v4.0.0 defines no `GET` on its top-level `/hub/{id}`; STD serves it anyway [checked: TMF688 swagger].
- A hub registration is a `core.subscription` (4.6) created through a one-operation change set: owner layer `local`, class = the API's mapped class (or the table for the generic hub), operations = all, identity = the registering user, a `callback`, the API and its `query`. It needs the new built-in permission `events.subscribe` (3.1), not access rules on `core.subscription`. Only the registering user or an admin may read or delete it [judgment]. A registration is a config commit, so registrations are rate-limited to 10 per user per minute [judgment on the value].
- `query` uses the 10.3 grammar on the event: `eventType=a,b` selects event types, and attribute filters on the resource become the subscription's condition (subscription profile, 5.10). Only attributes the registering user can always read (3.4) may be named, checked at registration; at delivery, an event is dropped when the identity can no longer read every attribute the query names on that record [judgment: the subscription profile evaluates as system, so the check keeps a query from testing hidden values].
- Events are `POST`ed to exactly the registered `callback` URL, path and query string unchanged, with the event as body; the listener tells types apart by `eventType` [checked: TMF621 v5.0.1 defines `callback` as the address events are delivered to; the `/listener/<eventName>` paths in the documents are the client's own endpoints, which a client may register as its callback]. A 2xx answer is success; anything else, a timeout (10 s [judgment]) or a refused connection fails the delivery and retries with the 4.6 backoff and dead letters. The callback is called outside any transaction, at least once; listeners dedupe by `eventId`. Callback URLs must be `https` except loopback, and redirects are not followed [judgment: no plaintext events, no SSRF through redirects].
- STD as a listener: `POST /api/v2/listener/{eventType}` is not offered in v0.1; STD subscribes to nothing (13.3).

### 12.3 TMF688 Event (pre-production v4.0.0)

- Operations [checked: TMF688 CP v4.0.0 pp.8-12; swagger]: `GET /topic`, `GET /topic/{id}`, `POST /topic` (client topics; `name` required), `DELETE /topic/{id}` (client topics, `204`; `405` on a resource topic, a status the swagger declares), `GET` and `POST /topic/{id}/event`, `GET /topic/{id}/event/{eventId}`, `GET` and `POST /topic/{id}/hub`, `GET` and `DELETE /topic/{id}/hub/{hubId}`, `POST /hub` (`201` with an `EventSubscription`) and `DELETE /hub/{id}`; `fields` on every `GET`. The profile makes Hub, Event and Topic mandatory resources, with Topic `GET`, Event `POST` and Hub `GET` and `POST` mandatory operations. Lists take TMF688's own `fields`, `offset` and `limit`; the cursor, `sort` and `condition` are STD extensions there.

- `topic` resources: one read-only topic per mapped resource type (`troubleTicket`, `individual`, `service`, …) and per table (`record:<table>`), plus topics clients create for their own events (`core.event_topic` records: `name`, `header_query`, `content_query`). Every topic renders `id`, `href` and `name` [checked: TMF688 CP v4.0.0 p.7]; a resource topic's `id` and `name` are the resource type or `record:<table>`.
- `GET /topic/{id}/event`: the events of that topic visible to the caller, rendered from change entries (12.1) for resource topics and from `core.event` records for client topics, newest first, with 10.3 paging.
- `POST /topic/{id}/event` on a client topic stores a `core.event` record (data, so it gets history and deliveries); on a resource topic it is `405` [judgment: those events come only from saves].
- An event read through TMF688 carries `id` (= `eventId`) and `href` (`…/topic/{id}/event/{eventId}`) besides the 12.1 envelope [checked: TMF688 CP v4.0.0 p.6], although the swagger's `Event` has neither; it spells `timeOccurred` as the guide does (spec v4.0.0 p.12), the swagger's `timeOcurred` being an upstream defect. `POST /topic/{id}/event` requires `@type`, `event`, `eventId` and `eventType` (the union of CP p.12 and spec p.27); `eventTime` defaults to the time it is received. A `relatedParty` item needs `@referredType` and `id` (CP p.6).
- `POST /topic/{id}/hub` registers a subscription as 12.2, on the topic's class, or on `core.event` with the condition `topic = id` for client topics.
- No CTK exists for TMF688 [checked: the directory lists no kit], but a conformance profile does (TMF688B v4.0.0, pre-production), whose mandatory items are rows of the requirements matrix; the gate is `tmf-oas-contract` against the pinned swagger plus `tmf688-topics`, which together cover every mandatory profile item. TMF688's own notifications (`EventCreateEvent`, `TopicCreateEvent`, `TopicChangeEvent`, `TopicDeleteEvent`; spec v4.0.0 p.17), none of them mandatory, are not offered in v0.1 until Martin decides decision 0026 M8.

### Acceptance tests

- `hub-delivery`: Alice registers on TMF621 and on `/api/v2` with `eventType` and attribute queries; creates, updates and deletes produce exactly the expected event types with the 12.1 envelope, in version order per record.
- `hub-payload-filter`: Bob's hub never receives an event for Alice's tickets, never an attribute he cannot read, and no AttributeValueChange for a change only to a field hidden from him; a query naming `internalCost` is refused at registration.
- `hub-soak`: 8 workers, a listener that fails 20% of calls and a worker killed mid-delivery: every committed change arrives at least once, duplicates share `eventId`, per-record order holds, and rolled-back saves never arrive.
- `hub-unregister`: after `DELETE /hub/{id}` no new deliveries are created; a registration without `events.subscribe` is `NotAllowed`.
- `hub-callback-path`: callbacks `https://listener.test/a/b/listener/troubleTicketCreateEvent`, `https://listener.test/hooks?id=7` and `https://listener.test/` receive their events at exactly those URLs, query string included, and nothing else is requested.
- `hub-event-authz`: with `impact` hidden from Bob and `priority` readable, a change of `impact` that changes `priority` gives his hub no event, and `priority` is absent from his payloads; with `status` hidden from Bob, his hub gets no StatusChange, Resolved or InformationRequired event and no `status` or `priority` in any payload, and an AttributeValueChange only when a readable attribute changed; with `status` readable only on tickets assigned to Bob (a conditional mask), a status change is delivered exactly when he can read `status` on both images; a role revoked, or Bob deactivated, between commit and delivery leaves the pending events `done` with `notAuthorized` and never sent.
- `tmf688-topics`: a client topic's posted event reaches its hub; a resource topic lists the same events a hub receives; `POST` on a resource topic is `405`.

## 13. ODA Component (Step 5; Canvas probe in Step 3)

### 13.1 Specification and packaging

- STD ships as one ODA Component per install, `apiVersion: oda.tmforum.org/v1`, `kind: Component` [checked: v1 is served and is the storage version, v1beta2 is served and deprecated, v1beta3 and v1beta4 are served: `oda-component-crd.yaml` (oda-crds 1.3.4) `spec.versions`; v1 is the oda-canvas 1.2.0 release (its README); the December 2024 date is from the Canvas release notes]. It is a custom component, not one of TM Forum's golden components: none of the 35 examined golden specifications exposes TMF621, and STD's APIs share one database [checked: the 35 golden specifications in TM Forum's publication repository; decision 0021, resolved question 10].
- Packaging: a Helm chart in `deploy/oda/std/` with the Component resource, the server (`std serve`, `application_name` `std-server`) and worker (`std worker`, `std-worker`) Deployments from the release image, their Services, a Postgres 18 StatefulSet or an external database URL, and one upgrade Job per release attempt. The chart has no Helm hooks [judgment]. `std bootstrap-admin` is not run; the first administrator comes from the identity provider (13.4).
- **Why no hooks.** Helm runs pre-install hooks before it creates any of the chart's resources, so a bundled database would not exist yet. With `--wait`, it runs post-install hooks only after every resource is ready, so pods that wait for a post-install Job deadlock [checked: [Helm chart hooks](https://helm.sh/docs/topics/charts_hooks/)].
- **One lifecycle for install and upgrade, with or without `--wait`** [judgment]:
  1. **Attempt ID.** Each attempt has one ID. By default every render generates it: a `uuidv4` computed once in the single template that renders the Job and both Deployments, so every `helm install` and `helm upgrade` is a new attempt, even when the release name, its revision or the database is reused. The chart value `upgradeAttempt`, when set, is used instead (resolved question 28). Template-based GitOps tools such as Argo CD render the chart repeatedly and treat random output as drift [checked: [Argo CD, Helm random data](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/#random-data)], so with them the procedure is to set `upgradeAttempt` to a new value for every rollout (for example the commit that changes the chart's values) and never reuse one.
  2. **The upgrade Job** `std-upgrade-<attempt>` is an ordinary resource, created with everything else. `<attempt>` is the first 12 hexadecimal digits of the SHA-256 of the attempt ID, so the name fits Kubernetes' 63-character limit and every new attempt is a new Job. A Job's pod template is immutable, so a new attempt must never reuse a name. A GitOps tool that only re-renders templates, without a new Helm revision, still gets a new Job for each new `upgradeAttempt`, and prunes the old one as a resource no longer rendered [judgment]. It waits until the database accepts connections (10 minutes), then runs `std upgrade --wait-for-disconnect 5m --attempt <ID>`, which waits until no `std-server` or `std-worker` session is connected (8.5). On success, its last transaction records the attempt in `core.release_attempt` (`attempt_id`, release name, revision, STD version, completion time; a platform table created by a migration).
  3. **Deployments** use the `Recreate` strategy and carry the attempt ID in their pod template. Every attempt therefore replaces their pods, and Kubernetes terminates all old pods before it creates new ones [checked: [Kubernetes Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment)], so the old servers and workers disconnect while the Job waits.
  4. **Init containers.** Every server and worker pod has an init container, `std wait-upgraded --attempt <ID>`, that waits for that exact attempt's row; a missing table or row means "not yet". So no pod starts before this attempt's `std upgrade` has succeeded, even on an external database that an earlier attempt already upgraded.
  - With `--wait`, Helm waits for the Deployments, whose pods become ready after the Job has finished, and nothing waits on Helm, so nothing deadlocks; `--wait-for-jobs` also waits for the Job [checked: `helm install` flags]. `--timeout` must cover the upgrade, as the runbook says. Without `--wait`, `kubectl wait` on the Job and the Deployments is the readiness check.
  - The ODA Canvas does not install a component's chart; it reconciles the Component resource the chart creates (13.3), so no Helm flags come from the Canvas side. Its own installation guide warns against `--wait` only for its own chart, which has post-install hooks [checked: TMFOP001 README, the Canvas installation README].
- **A failed attempt.** The Job does not retry (`backoffLimit: 0`). If `std upgrade` fails, no attempt row is written and the new pods stay in their init containers. The old pods are already gone, so no server or worker of either version runs against a partly upgraded database. With `--wait`, Helm reports the release failed when its timeout expires. Without `--wait`, Helm reports success as soon as it has applied the manifests, because it does not watch ordinary Jobs [checked: Helm v3.19.0 `pkg/action/upgrade.go`], so the failure shows only in Kubernetes: the Job is `Failed` and the pods wait. The runbook's readiness check is `kubectl wait` on the Job and the Deployments. Recovery is to fix the cause and run `helm upgrade` again: that is a new attempt, and `std upgrade` continues from the last committed migration or change set (8.5).
- **Going back to an older version is a restore, then a `helm upgrade` of the older chart.** Restore the pre-upgrade backup (8.6), then `helm upgrade` with the older chart and image; that renders a new attempt, whose Job runs the older `std upgrade` against the restored database. `helm rollback` is not supported for a release whose upgrade ran migrations: Helm reuses the earlier revision's rendered manifest on rollback, attempt ID included [checked: Helm v3.19.0 `pkg/action/rollback.go`], so an existing completion row for that ID could release the init containers before any Job has validated the database. If someone runs it anyway, the older servers still refuse to start against the newer ledger (1.9), so it never serves; the runbook says so.
- `componentMetadata`: `id` `STD`, `name` `std`, `version` = the STD release, `functionalBlock` `Production` [judgment for the choice; the value set is Party, Core Commerce, Production, Intelligence and Engagement: IG1329 v1.1.0 §2.3 p.12; the CRD takes any string], `description`, `maintainers`, `owners`. The v1 CRD requires none of these, but its descriptions of `id` and `name` say they name a published TM Forum component specification, which a custom component cannot (decision 0026 M13).

### 13.2 Exposed and dependent APIs

- `coreFunction.exposedAPIs`: one entry per row of 11.1 except TMF672 (below), each with `id` (`TMF621`, …), `name`, `specification` (exactly one entry: the pinned OpenAPI URL and version), `apiType: openapi`, `apiSDO: TMForum`, `implementation` (the server Service), `path` (the 11.1 base path), `port`; plus STD's own API (`id` `STD-API`, `apiSDO` `STD`, path `/api/v2`, its `openapi.json`). `apiType`, `implementation`, `path` and `port` are set at the API level, where the `ExposedAPI` resource the operator creates from each entry requires them, and since oda-crds 1.3.2 they may also appear inside `specification[]`; one specification entry with the fields at the API level is valid in both layouts [checked: `oda-component-crd.yaml` and `oda-exposedapi-crd.yaml` v1]. Each API's `name` is a lowercase DNS-1123 label, unique across the component (`troubleticket`, `stdapi`, `metrics`, …), because the Canvas names child resources `<component>-<name>` and `<release>-std-<name>` must fit 63 characters (oda-canvas BDD UC002-F001, UC012-F002).
- `coreFunction.dependentAPIs`: none in v0.1 [judgment: STD masters parties, CIs and orders itself; an external party master through TMF632 is later].
- `managementFunction.exposedAPIs`: the metrics endpoint, `name` `metrics`, `apiType: prometheus` [checked: the CRD v1 enum for management APIs is `openapi`, `prometheus`, `openmetrics`, `mcp`, `a2a`].
- `securityFunction`: `canvasSystemRole` `canvas_system`, an STD role holding `events.subscribe` and, through `core`-layer rules, read on `core.role` and `core.access_rule` (4.6); `exposedAPIs`: exactly one entry, TMF672 (`name` `userrolesandpermissions`, `id` `TMF672`, the 11.1 base path, `implementation`, `port`), the Canvas identity operator's preferred dynamic-role API [checked: TMFOP003 README; `oda-identityconfig-crd.yaml` v1 `permissionSpecificationSetAPI`, where the party-role API "will be deprecated"]. TMF632 and TMF669 are only in `coreFunction`, so the Canvas never copies business party roles into Keycloak. Which field the component operator matches to pick the security API is not in the Canvas extract; the probe confirms it [unverified].
- `eventNotification.publishedEvents`: one entry per event type of 11.2 to 11.5, with a DNS-safe lowercase `name`, a `description`, and one `specification` entry with `url`, `version`, `apiType: openapi` (the only value `PublishedNotification` takes), `implementation` (the server Service), `hub` (the API's hub path) and `port` [checked: CRD v1 `eventNotification`; `oda-publishednotification-crd.yaml` v1]; `subscribedEvents`: none.

### 13.3 What the Canvas does with it

- The component operator splits the Component into `ExposedAPI`, `DependentAPI`, `PublishedNotification`, `SubscribedNotification`, `SecretsManagement` and `IdentityConfig` resources; the API operator (Istio by default) publishes each exposed API through the gateway; the identity operator creates one Keycloak client for the component, adds `canvas_system` as a client role, registers a listener on STD's TMF672 hub and mirrors every `PermissionSpecificationSet` (STD role) into a Keycloak client role [checked: TMFOP001 and TMFOP003 READMEs; oda-canvas BDD UC005-F001 to F003, which also show the client named after the Component resource and removed on uninstall]. The events it listens to are config events (4.6), produced in the change set's own transaction, so Keycloak never sees a role that did not commit.

### 13.4 Security: STD stays the policy decision point

- With `STD_OIDC_ISSUER` set, the server accepts `Authorization: Bearer <JWT>` from that issuer: signature by the issuer's JWKS, `iss`, `aud` containing the component's client ID, `exp` required, `nbf` and `iat` checked when present (RFC 7519 makes them optional), with 60 s clock skew [judgment]. The client ID is the Component resource's `metadata.name`, which the chart passes as `STD_OIDC_CLIENT_ID`; ODA leaves its own JWT profile "for further study", so these rules rest on OIDC and RFC 7519 [checked: IG1330 v2.0.0 §8.1 p.37; oda-canvas BDD UC005-F002]. Whether Keycloak puts the client in `aud` for a user who holds none of its roles is [unverified] until the probe records a real token. The subject is mapped to a `core.user` through the external identity mapping (7.1, source system = the issuer), and a missing user is created by the system user through the save pipeline with its individual (just-in-time provisioning). Password sessions keep working beside it.
- Roles: the token's client roles for the component's client (`resource_access.<client>.roles`) that name live STD roles join the user's effective roles for that request (11.3); unknown names grant nothing; the role names are logged, never the token.
- Every record, field and permission decision is still STD's access rules on those roles (3.2). Keycloak decides who the caller is and which STD roles they hold, never what a role may do [checked: the component that provides an API holds its policy decision point and role definitions, and the Canvas helps enforce them: IG1330 v2.0.0 §5.1 p.15 and requirement IG1330-Sec002 p.44; GB1008 v1.1.0 §5.2.7 pp.24-25; so the decision rule stays in one place and the Contracts 3 tests keep meaning].
- The Canvas system role reaches only what `canvas_system` allows.

### 13.5 Versions

- The Canvas chart is pinned (`canvas-oda` 1.2.5 [checked: the chart index, 2026-10-22; the newest release in the oda-canvas README]) with Kubernetes 1.30 on kind and Istio as the Canvas CI pins it [unverified: not in the Canvas extract]; Vault is disabled [judgment]. The Component CRD that `oda-component-schema` validates against is taken from that chart's package, with its oda-crds version and SHA-256 recorded. A Canvas upgrade is its own PR.

### 13.6 CI

- **Step 3 probe (`oda-canvas-probe`)**: a workflow that creates a kind cluster, installs Istio and the pinned Canvas, deploys a stub component (one exposed API, static roles), and records bring-up time, disk use, the component's time to `Complete` and failures; 10 runs, results committed with the decision note. Expected from TM Forum's own workflow: about 30 minutes per full run on `ubuntu-latest`, and about half of recent upstream runs failed (sampled 2026-10-22, [runs](https://github.com/tmforum-oda/oda-canvas/actions/workflows/trigger_tests.yml)).
- **Step 5 gate (`oda-canvas-deploy`)**: nightly, on release candidates and by hand, not on every PR. It installs the Canvas, then STD's chart, and asserts 13.3: the component `Complete`, every exposed API published, the Keycloak client with exactly STD's roles and a role created afterwards mirrored; then it runs every CTK of 11.1 through the gateway with Keycloak-issued tokens, the OIDC versions of the Contracts 3 tests, and the Canvas BDD features for managing components, exposed APIs and bootstrap roles (oda-canvas test kit, use-case-library numbering: UC002-F001 to F006, UC003-F001 to F005, UC005-F001 to F003; IG1329 numbers its use cases differently) [judgment on the feature list, confirmed by the probe]. Those features name TM Forum's example packages in their Examples tables, so the gate runs them unchanged against those packages, to show the Canvas works, and runs STD-adapted copies (Apache-2.0, attributed) whose Examples name STD's chart; UC005-F002's role writes to TMF672 use an STD administrator's token, since `canvas_system` only reads and subscribes (13.2). Infrastructure steps (cluster, Istio, Canvas install) retry twice; test steps never retry.
- **Every PR (`oda-component-schema`)**: the rendered chart validates against the pinned Component CRD's v1 schema, each exposed API also in the form of the `ExposedAPI` v1 resource it becomes (whose `name`, `apiType`, `implementation`, `path` and `port` are required), and every exposed API's path and spec URL match 11.1. The Component CRD itself requires little (no field at the root, `spec` or `componentMetadata` level), so the CRD's normative field descriptions are matrix rows too (15.2).

### Acceptance tests

- `oda-component-schema`, `oda-canvas-deploy` and the probe as above.
- `oda-helm-lifecycle` (part of `oda-canvas-deploy`), each case with and without `--wait` unless it says otherwise, and with the generated attempt ID and with `upgradeAttempt` set:
  - Install with the bundled Postgres, and separately with an external database: no server or worker container starts before the attempt's `core.release_attempt` row is written (container start times against the row's completion time); the component reaches `Complete`; `doctor` exits 0.
  - Install under a reused release name against an external database that an earlier install already upgraded: the pods wait for the new attempt's row, and the Job's `std upgrade` is not refused.
  - Upgrade from an image built from the previous release tag, with data: no `std-server` or `std-worker` session exists while `std upgrade` migrates (sampled every second); `doctor` exits 0; the component returns to `Complete`; the CTKs pass again.
  - A CI-only candidate image carrying an extra migration that fails: the Job ends `Failed`, the new server and worker pods stay in their init containers with no application container started, and the database's ledger shows the failed migration not applied (all checked through Kubernetes and SQL in both modes). Only with `--wait` (and `--wait-for-jobs`), Helm also reports the release failed. A `helm upgrade` with the fixed image, a new attempt, completes.
  - Going back: after an upgrade that ran migrations, restoring the pre-upgrade backup and running `helm upgrade` with the previous chart and image starts the previous version on a new attempt, with `doctor` exiting 0. An unsupported `helm rollback` without a restore never serves a request: its servers refuse to start against the newer ledger.
  - Rendering the chart twice with the same `upgradeAttempt` gives byte-identical manifests; rendering without it gives a new attempt ID each time.
  - Two GitOps rollouts in a row, each `helm template` with a new `upgradeAttempt` applied by `kubectl apply --prune` (the Argo CD template-only model, no Helm release revision), each create their own `std-upgrade-<attempt>` Job, which completes. The second apply is never refused for changing an existing Job. The pods of each rollout start only after their own Job's row exists.

- `oidc-roles`: a token with role `agent` gets exactly what a local `agent` session gets through `/api/v2` and TMF621 (the Contracts 3 hidden-field tests repeated); a token naming an unknown role gets what `authenticated` gets; an expired token, a wrong audience and a wrong issuer are `Unauthenticated`.
- `oidc-jit`: the first request of a new subject creates one user and one individual, with change entries, and a concurrent second request does not create another.

## 14. ITIL practices (Steps 3 and 4)

### 14.1 Edition and wording

- STD follows the ITIL 4 practice guides for incident management, problem management, change enablement, service request management and service configuration management [judgment: ITIL 4 is the edition most organizations certify against and runs until the end of 2027; ITIL (Version 5), launched in 2026, keeps the 34 practices; resolved question 8]. Service level management is not in v0.1 (plan, "Deliberately later"); TMF fields such as `expectedResolutionDate` are plain fields.
- ITIL defines practices and outcomes, not tool states [unverified: the practice guides are behind PeopleCert's paywall]. The state models below are STD's, chosen to match common practice (ServiceNow's models, decision 0021) and the TMF state sets (11). STD's docs describe ITIL concepts in their own words, quote nothing beyond short attributed phrases, and carry "ITIL® is a registered trademark of the PeopleCert group".
- Every behavior here is shipped configuration (record rules, choices, access rules in the helpdesk and cmdb sets), so admins can change it through overrides and local rules, and every test runs through the generic API, the TMF API and, where a form exists, the browser.
- The rule kinds, actions and execution identities these behaviors need are those of 4.10, which workstream 3A builds; the shipped rules of 14.4 are listed there in that form.

### 14.2 Incident (helpdesk v3, Step 3)

- `impact` and `urgency`: choices 1 (high), 2 (medium), 3 (low), both required; `urgency` defaults to 3, so a TMF621 create that names only `severity` is valid [judgment]. `priority` (1 critical to 5 planning) is read-only and set by nine shipped before-write rules, one per cell: (1,1)→1, (1,2)→2, (2,1)→2, (1,3)→3, (2,2)→3, (3,1)→3, (2,3)→4, (3,2)→4, (3,3)→5 [judgment: the common matrix; ITIL prescribes none]. An admin changes a cell by deactivating its rule and adding a local one.
- States: `new`, `in_progress`, `on_hold` (with `hold_reason`: `awaiting_caller`, `awaiting_change`, `awaiting_problem`, `awaiting_vendor`, required exactly while on hold), `resolved`, `closed`, `canceled`. Allowed transitions: `new` → `in_progress`, `on_hold`, `resolved`, `canceled`; `in_progress` → `on_hold`, `resolved`, `canceled`; `on_hold` → `in_progress`, `resolved`, `canceled`; `resolved` → `in_progress` (reopen), `closed`; `closed` and `canceled` are final. One before-write rule per source state refuses every other change of `status` with `InvalidTransition` (422).
- Entering `resolved` needs `resolution_code` and `resolution_notes` and sets `resolved_at`; leaving it clears `resolved_at`. Entering `closed` keeps them.
- Major incident: `major_incident` (boolean) may be set only by the `major_incident_manager` role (an access rule on the field) and only while `priority` is 1 [judgment]; it is rendered in TMF621 as a characteristic, and a saved filter lists open major incidents. Child incidents name it through `parent_incident`; resolving a major incident resolves its open children with the same resolution (an after-write rule).

### 14.3 Problem (helpdesk v3, Step 3)

- States: `new`, `assess`, `root_cause_analysis`, `fix_in_progress`, `resolved`, `closed`, `canceled`, with transitions `new` → `assess`, `canceled`; `assess` → `root_cause_analysis`, `canceled`; `root_cause_analysis` → `fix_in_progress`, `resolved`, `canceled`; `fix_in_progress` → `resolved`, `root_cause_analysis`; `resolved` → `closed`, `root_cause_analysis`; final `closed`, `canceled`.
- Known error: `known_error` (boolean) may be true only with a non-empty `workaround`; `root_cause` is required to enter `fix_in_progress` and `resolved`. A problem is a known error from the moment the flag is set, whatever its state [judgment: ITIL treats "known error" as a status of the analysis, not a lifecycle step].
- Incidents name their problem through `problem`; when a problem enters `resolved`, its linked incidents that are `on_hold` with `awaiting_problem` return to `in_progress` (an after-write rule), and none is resolved automatically [judgment].

### 14.4 Change enablement and service requests (helpdesk v4, Step 4)

Aggregates (4.9): `helpdesk.change_item`, `helpdesk.change_cancellation` and `helpdesk.change_approval` are parts of their change; `helpdesk.request_item` and `helpdesk.request_cancellation` of their request; `helpdesk.request_item_approval` of its request item, which makes the request a three-level aggregate. Every write to any of them, or to the change or request itself, locks the aggregate root first, which serializes the concurrent outcomes below, and queues the owners. Every transition below that depends on parts (approval rounds and outcomes, invalidation, item and request state, cancellations) is an **aggregate rule**: it is settled in memory when the owners are finalized and persisted once per transaction (4.9), never by a nested save of an owner that is still on the save stack. Aggregate rules may also create parts of the owner they settle, here only approvals [judgment: the one creation 4.9 allows].

**Change types and states.** `change_type` is `standard` (needs a `standard_change_template` reference), `normal` or `emergency`, and is read-only after `new`. Allowed `status` transitions; anything else is `InvalidTransition` (422) and writes nothing. "System" transitions are made only by the aggregate rules below; a user's write of them is `InvalidTransition`. The transition guards are `before` rules of kind `guard`, which never run on the saves that settling persists (4.9), so they guard users' writes only:

| From | `standard` | `normal` | `emergency` |
| --- | --- | --- | --- |
| `new` | `scheduled`, `canceled` | `assess`, `canceled` | `authorize`, `canceled` |
| `assess` | none | `authorize`, `canceled` | none |
| `authorize` | none | `scheduled` (system), `rejected` (system), `assess`, `canceled` | `scheduled` (system), `rejected` (system), `canceled` |
| `scheduled` | `implement`, `canceled` | `implement`, `assess`, `canceled` | `implement`, `authorize` (system), `canceled` |
| `implement` | `review` | `review` | `review` |
| `review` | `closed` | `closed` | `closed` |
| `closed`, `canceled`, `rejected` | final | final | final |

Entering `implement` sets `actual_start`; entering `closed` needs `close_code` (`successful`, `unsuccessful`, `partial`) and sets `actual_end`.

**Approvals.** Two classes, so each has one owner reference (4.9): `helpdesk.change_approval` (owner `change`) and `helpdesk.request_item_approval` (owner `request_item`), both extending `helpdesk.approval`, which holds `approver` (a user) or `approver_group`, `round` and `state` (`requested`, `approved`, `rejected`, `cancelled`) and is never created directly [judgment]. The change authority is a set of `helpdesk.change_authority_member` records (change type, and a user or a group); a catalog item's approvers are `helpdesk.catalog_item_approver` records (catalog item, and a user or a group). An approver may move only their own `requested` approval to `approved` or `rejected` (an access rule). For users, decided and cancelled approvals are final: a user's write of `cancelled`, or any user write to a decided approval, is `InvalidTransition`. The one exception is the system: the change's or item's aggregate rules move `requested` and `approved` approvals of the current round to `cancelled` on invalidation, rejection or cancellation, as below [judgment].

- **Rounds.** A change's `approval_round` (integer, default 0) advances in exactly one place, the `create-round` aggregate rule. While a settled change is in `authorize` and has no current approval that is `requested`, `approved` or `rejected`, it increments the round and creates one `requested` change approval per user and per group of the type's authority, with the new round; any member of a group decides for it [judgment]. So a first entry, a re-entry after `assess`, and an emergency invalidation from `authorize` or from `scheduled` each start exactly one new round. Outcomes read only the current round's approvals.
- **Outcome.** When a change in `authorize` is settled: if any current approval is `rejected`, the change goes to `rejected` and the other current `requested` approvals to `cancelled`; else if every current approval is `approved`, the change goes to `scheduled`.
- **Invalidation.** When a change that was in `authorize` or `scheduled` at the start of the transaction is settled, and the transaction changed its `planned_start` or `planned_end` (an owner-only edit queues the change too, 4.9) or created, updated or deleted any of its items (`partsChanged.helpdesk.change_item`, 5.10), its current `requested` and `approved` approvals become `cancelled`, a normal change moves to `assess`, and an emergency change re-enters `authorize` with a new round, which creates fresh approvals. Leaving `authorize` for `assess` or `canceled` cancels its current open approvals the same way. Standard changes have no approvals [judgment].

**Completing a change.** When a change closed with `close_code` `successful` is settled, its items become `completed`; with `unsuccessful`, `failed`; with `partial`, the user sets each item's outcome before closing. An item that becomes `completed` is applied to the CMDB by its own `after` rule, as the CMDB integration user [judgment]. The service writes cascade into the CMDB aggregates (4.9):

- `add` creates a service from the item's `service_name`, `service_specification` and `target_state`;
- `modify` sets the referenced service's `state` to `target_state`;
- `delete` sets it to `terminated` and never deletes it [judgment].

**Cancelling a change** (`CancelServiceOrder`). The cancellation is created `accepted` as a part of the change and decided when the change is settled in the same transaction: if the change is `new`, `assess`, `authorize` or `scheduled`, it goes to `canceled`, its current open approvals to `cancelled`, and the cancellation to `done`; otherwise the cancellation is `done` with reason `notCancellable` and the change is unchanged. `done` means the cancellation was assessed, whatever the outcome; `terminatedWithError` is kept for a cancellation the server could not assess [checked: TMF641 spec v4.2.0 p.53; TMF622 UG v5.0.0 p.9; decision 0026, F641-04].

**Request items.** `helpdesk.request_item.state`: `draft` while the request is a draft; when the request is settled after its submit, `awaiting_approval` when its catalog item has `approval_required`, else `new`. An item has its own `approval_round` (integer, default 0), advanced only by its `create-round` rule. An item in `awaiting_approval` with no current approval that is `requested`, `approved` or `rejected` gets a new round, with one `requested` request item approval per user and group of its catalog item's approvers [judgment]. Items may be added or removed only while the request is a draft. Transitions: `awaiting_approval` → `new` (system, when the item is settled with every current approval `approved`), `rejected` (system, when it is settled with any `rejected`, which cancels the rest), `canceled`; `new` → `in_fulfilment`, `canceled`; `in_fulfilment` → `on_hold`, `fulfilled`, `failed`, `canceled`; `on_hold` → `in_fulfilment`, `failed`, `canceled`; `fulfilled`, `failed`, `rejected`, `canceled` are final. Invalidation: changing an `awaiting_approval` item's `product_offering` or `quantity` cancels its current open approvals, and `create-round` then starts a new round.

**Request state.** A user moves a request only `draft` → `submitted` (which needs at least one item) or `draft` → `canceled` (whose settling cancels its draft items). The submit is the request's own save; settling then moves every item out of `draft`, settles the items, and derives the request's state, and the request is persisted once more (4.9). `fulfilled`, `partially_fulfilled`, `failed`, `rejected` and `canceled` are terminal: a terminal request is never derived again, and its items are all final. Otherwise `status` is read-only and derived when the request is settled, only while it is `submitted`, `awaiting_approval`, `in_fulfilment` or `on_hold`. Such a request always has at least one item, none in `draft`, so the first matching row decides:

| Item states                      | Request `status`      |
| -------------------------------- | --------------------- |
| any `in_fulfilment`              | `in_fulfilment`       |
| else any `awaiting_approval`     | `awaiting_approval`   |
| else any `new`                   | `submitted`           |
| else any `on_hold`               | `on_hold`             |
| else (all final) all `fulfilled` | `fulfilled`           |
| else some `fulfilled`            | `partially_fulfilled` |
| else any `failed`                | `failed`              |
| else any `rejected`              | `rejected`            |
| else (all `canceled`)            | `canceled`            |

**Cancelling a request** (`CancelProductOrder`). The cancellation is created `accepted` as a part of the request and decided when the request is settled in the same transaction. It succeeds only when the request is not terminal and no item is `fulfilled` or `failed`: then every non-final item goes to `canceled` (`rejected` items stay `rejected`), every open approval to `cancelled`, the request's `status` is set to `canceled` (terminal, not derived), and the cancellation is `done`. Otherwise, including a request already `canceled`, the cancellation is `done` with `notCancellable` and nothing changes. A single item is cancelled by writing its state.

**Concurrent outcomes.** All of these serialize on the change's or request's root lock, so the second writer sees the first's result:

- Two last approvals decided at once: the second transaction locks the change after the first commits, so the change moves to `scheduled` exactly once.
- An approval and a rejection of the same change at once: both approvals were `requested`, so neither is the last approval and the change ends `rejected`. If the approval commits second, it finds its approval already `cancelled` and gets `InvalidTransition`.
- A cancellation and `implement` at once: whichever commits first wins; a later `implement` on a `canceled` change is `InvalidTransition`, a later cancellation of an implementing change is `notCancellable`.
- Two cancellations: the second is `notCancellable`.
- An item fulfilled while the request is cancelled: if the fulfilment commits first, the cancellation is `notCancellable`; otherwise the fulfilment is `InvalidTransition`.
- Submitting a request: its items move and the request is derived in one settling, and the request is persisted once by its aggregate save; no save of the request happens while it is on the save stack.

**Shipped rules.** The behavior above is these record rules (4.10) in the helpdesk set v4. "Current" means `round = owner.approval_round`, and "open" means `state in ("requested", "approved")`. Within a class, rules run in the listed order:

| Class | Rule | Phase | Condition | Actions |
| --- | --- | --- | --- | --- |
| `change` | `invalidate-normal` | `aggregate`, `once` | `previous.status in ("authorize", "scheduled") and change_type = "normal" and (changed(planned_start) or changed(planned_end) or partsChanged.helpdesk.change_item)` | `setParts` current open approvals → `cancelled`; `set` `status` `assess` |
| `change` | `invalidate-emergency` | `aggregate`, `once` | the same with `change_type = "emergency"` | `setParts` current open approvals → `cancelled`; `set` `status` `authorize` (the round advances in `create-round`) |
| `change` | `leave-authorize` | `aggregate` | `previous.status = "authorize" and status in ("assess", "canceled") and anyPart(change_approval, current and open)` | `setParts` current open approvals → `cancelled` |
| `change` | `create-round` | `aggregate` | `status = "authorize" and change_type != "standard" and not anyPart(change_approval, current and state in ("requested", "approved", "rejected"))` | `set` `approval_round` `{increment}`; then `createParts` `change_approval`, `forEach` `change_authority_member` where `change_type = owner.change_type`: `approver` ← `source.user`, `approver_group` ← `source.group`, `round` ← `owner.approval_round` (the incremented value), `state` `requested` |
| `change` | `reject` | `aggregate` | `status = "authorize" and anyPart(change_approval, current and state = "rejected")` | `set` `status` `rejected`; `setParts` current `requested` approvals → `cancelled` |
| `change` | `approve` | `aggregate` | `status = "authorize" and anyPart(change_approval, current) and allParts(change_approval, not current or state = "approved")` | `set` `status` `scheduled` |
| `change` | `cancel` | `aggregate` | `anyPart(change_cancellation, state = "accepted") and status in ("new", "assess", "authorize", "scheduled")` | `set` `status` `canceled`; `setParts` current open approvals → `cancelled`; `setParts` accepted cancellations → `done` |
| `change` | `cancel-refused` | `aggregate` | `anyPart(change_cancellation, state = "accepted")` | `setParts` accepted cancellations → `done`, `reason` `notCancellable` |
| `change` | `complete-items` | `aggregate` | `status = "closed" and close_code = "successful" and anyPart(change_item, state != "completed")` | `setParts` items → `completed` |
| `change` | `fail-items` | `aggregate` | `status = "closed" and close_code = "unsuccessful" and anyPart(change_item, state != "failed")` | `setParts` items → `failed` |
| `change_item` | `apply-to-cmdb` | `after` (update), `runAs` the CMDB integration user | `changed(state) and state = "completed"` | `add`: `createEach` `cmdb.service` from the item; `modify`: `updateEach` `target: {via: service}`, `state` ← `source.target_state`; `delete`: the same with `state` `terminated` |
| `request` | `submit-items` | `aggregate` | `status = "submitted" and anyPart(request_item, state = "draft")` | `setParts` draft items whose `product_offering.approval_required` → `awaiting_approval`; `setParts` other draft items → `new` |
| `request` | `cancel-draft` | `aggregate` | `status = "canceled" and anyPart(request_item, state = "draft")` | `setParts` draft items → `canceled` |
| `request` | `cancel` | `aggregate` | `anyPart(request_cancellation, state = "accepted") and status in ("draft", "submitted", "awaiting_approval", "in_fulfilment", "on_hold") and not anyPart(request_item, state in ("fulfilled", "failed"))` | `setParts` non-final items → `canceled`; `set` `status` `canceled`; `setParts` accepted cancellations → `done` |
| `request` | `cancel-refused` | `aggregate` | `anyPart(request_cancellation, state = "accepted")` | `setParts` accepted cancellations → `done`, `reason` `notCancellable` |
| `request` | `derive-1` to `derive-9` | `aggregate` | `status in ("submitted", "awaiting_approval", "in_fulfilment", "on_hold")`, row n of the request-state table, and none of rows 1 to n−1 | `set` `status` to row n's value |
| `request_item` | `invalidate` | `aggregate`, `once` | `previous.state = "awaiting_approval" and (changed(product_offering) or changed(quantity))` | `setParts` current open approvals → `cancelled` (the round advances in `create-round`) |
| `request_item` | `create-round` | `aggregate` | `state = "awaiting_approval" and not anyPart(request_item_approval, current and state in ("requested", "approved", "rejected"))` | `set` `approval_round` `{increment}`; then `createParts` `request_item_approval`, `forEach` `catalog_item_approver` where `catalog_item = owner.product_offering`, values as for changes |
| `request_item` | `reject` | `aggregate` | `state = "awaiting_approval" and anyPart(request_item_approval, current and state = "rejected")` | `set` `state` `rejected`; `setParts` current `requested` approvals → `cancelled` |
| `request_item` | `approve` | `aggregate` | `state = "awaiting_approval" and anyPart(request_item_approval, current) and allParts(request_item_approval, not current or state = "approved")` | `set` `state` `new` |
| `request_item` | `close-approvals` | `aggregate` | `state in ("canceled", "rejected") and anyPart(request_item_approval, current and open)` | `setParts` current open approvals → `cancelled` |

Every shipped `before` rule (4.10) has an explicit kind:

| Set and class | Rule | Kind |
| --- | --- | --- |
| helpdesk `ticket` (11.2) | fill `short_description` from `description`; set `status_changed_at` on a status change; set and clear `resolved_at` | `derive` |
| helpdesk `incident` (14.2) | the nine priority-matrix cells | `derive` |
| helpdesk `incident` (14.2) | one transition guard per source state | `guard` |
| helpdesk `incident` (14.2) | `resolved` needs `resolution_code` and `resolution_notes`; `hold_reason` exactly while `on_hold`; `major_incident` only at priority 1 | `invariant` |
| helpdesk `problem` (14.3) | one transition guard per source state | `guard` |
| helpdesk `problem` (14.3) | `known_error` needs `workaround`; `root_cause` needed in `fix_in_progress` and `resolved` | `invariant` |
| helpdesk `change` (14.4) | the transition table's guards, users' writes of system transitions, and `change_type` read-only after `new` | `guard` |
| helpdesk `change` (14.4) | `closed` needs `close_code`; `standard` needs `standard_change_template` | `invariant` |
| helpdesk `change` (14.4) | set `actual_start` on entering `implement` and `actual_end` on entering `closed` | `derive` |
| helpdesk `request` and `request_item` (14.4) | users' request transitions (`draft` → `submitted` or `canceled` only); item transitions; items added or removed only while `draft` | `guard` |
| helpdesk `request` (14.4) | a non-draft request has at least one item | `invariant` |
| helpdesk `approval` classes (14.4) | users' approval writes (only `requested` → `approved` or `rejected`, by the approver) | `guard` |
| cmdb `ci_relationship` (14.5) | no `contains` cycle within 3 hops | `invariant` |

How settling reaches its fixed point (4.9). Two examples:

- **Emergency invalidation**, from `authorize` or from `scheduled`. Pass 1 runs `invalidate-emergency` once: it cancels the current open approvals and sets `authorize`; then `create-round` finds no live approval of the current round, advances the round once and creates its approvals. In pass 2, `once` keeps the invalidation from firing again, and `create-round` sees live current approvals, so nothing is proposed. Persistence writes the cancelled approvals, the new ones and the change once each, running only invariants, so no other rule advances the round.
- **Submitting a request.** Pass 1 runs `submit-items`, which moves the items and so enrolls them (4.9). In pass 2, each item's `create-round` creates its approvals, then `derive` sets the request's state. Pass 3 proposes nothing. Only then is anything persisted: the approvals, the items and the request, each once.

### 14.5 Service configuration management (cmdb, Step 4)

- Configuration items are `cmdb.ci` records (11.4); incidents, problems and changes reference the affected CI. Relationship types are a choice list (`dependsOn`, `runsOn`, `contains`, `connectedTo`, `supportingService`, `supportingResource`, and TMF relationship types as given) [judgment]. A `contains` cycle is refused (a before-write rule walks at most 3 hops, the record-rule limit, 5.10) [judgment]; longer cycles are reported by a saved filter, not refused.
- CI data can be loaded with imports (Contracts 7) keyed by an external identity per discovery source.

### Acceptance tests

- `itil-incident`: all nine matrix cells through `/api/v2`, TMF621 (as `severity` and the `urgency` characteristic) and the browser; a change of impact or urgency recomputes priority; every disallowed transition is `InvalidTransition` and writes nothing; resolve without code or notes is refused through `/api/v2/helpdesk.ticket`; reopen clears `resolved_at`; only the major incident manager sets `major_incident`, and only on priority 1; resolving a major incident resolves its open children.
- `itil-problem`: every disallowed transition refused; `known_error` without a workaround refused; resolving a problem returns exactly its `awaiting_problem` incidents to `in_progress`.
- `itil-change`: every cell of the 14.4 transition table, allowed and refused, for each change type; system transitions refused to users; approvals created per authority member and group; invalidation by a date or item change in `authorize` and in `scheduled`; the concurrent outcomes of 14.4 (two last approvals, approve against reject, cancel against implement, two cancellations), each run 50 times with forced interleavings.
- `change-updates-cmdb`: `successful`, `unsuccessful` and `partial` closes apply exactly the `completed` items, once.
- `itil-request`: the derivation over every combination of one to three items in the eight non-draft item states (property test) equals the 14.4 table, and every non-draft, non-terminal request has an item; a terminal request is never re-derived; submit finalizes the request once without `RecordInSave`; approval and invalidation per item; cancellation succeeds and is refused exactly per the rule (a draft, an awaiting request, one with a `rejected` item, one already `canceled`, one with a `fulfilled` item); an item fulfilled concurrently with a cancellation.
- `approval-finality`: the system moves an `approved` approval to `cancelled` on invalidation; the approver's own write of `cancelled`, and any write to an `approved` or `rejected` approval, is `InvalidTransition`.
- `config-events` (4.6): a TMF672 hub receives Create, AttributeValueChange and Delete events for roles created, relabelled (an override included), retired and deleted, in each role's version order, from admin change sets, generic definition writes and a set load by `std upgrade`; a change set that fails after its role write produces no delivery; deliveries of two change sets follow commit order.
- `helpdesk-v3-upgrade`: helpdesk v2 with the Step 2 upgrade test's local overrides and 1,000 incidents upgrades to v3; every incident, its history and the overrides remain, `doctor` exits 0, and every incident is readable through TMF621.

## 15. Conformance evidence: the requirements matrix (Steps 3 to 5)

"Strict compatibility" is shown, not asserted: every normative requirement of every pinned specification maps either to a test that proves it or to an exclusion that Martin decided. The matrix is a gate artefact, checked in CI (decision 0021).

### 15.1 Files and rows

- One file per pinned specification, `docs/conformance/<spec>@<version>.yaml` (for example `TMF630@4.2.0.yaml`, `TMF621@5.0.1.yaml`, `ODA-Component@v1.yaml`, `STD-ITIL@14.yaml`), and one decision log, `docs/conformance/decisions.yaml`. Pins come from one source, `packages/tmf/specs/pins.json`, which 11.1's table states. It names every specification that has a matrix file (TMF630, the nine Open APIs, `STD-ITIL@14`, `ODA-Component@v1`), each with the step whose gate first covers it, and for each Open API its base path, served resources, vendored OpenAPI document (upstream repository and commit, SHA-256, licence) and kit (zip URL and SHA-256, image, default URL). A pin whose file a later workstream writes names that workstream in `awaitingMatrix` until the file exists [judgment: so a step's work can merge before the next step's files exist; decision 0026].
- A row: `id` (stable, for example `TMF621@5.0.1/CP/3.2/post-required-severity`); `source` (document, version, and section and page, or an OpenAPI pointer such as `#/components/schemas/TroubleTicket_FVO/required`); `level` as the source states it (`mandatory`, `optional`, `recommended`); `requirement` in STD's own words (RAND documents may be copied but not modified, and ITIL text is licensed, so rows paraphrase and cite); `status` `tested` (with `tests`, a list of `<test file>#<exact test title>`), `excluded` (with `decision`, an ID in the decision log) or `pending`; for kits, `kitCases`, the kit's mandatory test titles at the pinned version, which the CTK runner requires (11.1); optionally `step`, at or after its specification's step, when a file holds rows of several steps (`STD-ITIL@14.yaml`), and `note`. A profile's conditional item (mandatory when its parent is present) has level `mandatory`, with the condition in the requirement. A file also lists its `sources` (document, version, licence) and, for a kit, a `kit` note on how its case titles were obtained.
- The decision log already exists, with the twelve exclusions of 15.3 accepted by Martin on 2026-10-22. Their `rows` lists are filled in as workstreams 3G and 3T write the matrix files; until then an accepted entry with no rows satisfies nothing and blocks nothing. The decision log holds, per exclusion: `id`, the rows it covers (`rows`), what is excluded in STD's words (`requirement`), STD's `reason` and `recommendation`, `state` (`proposed` or `decided`), and when decided, the `outcome` (`accepted` or `rejected`), `decidedBy`, Martin's `words` and the `date`; an entry from decision 0021 also names its number there (`decision0021`). Only an `accepted` exclusion satisfies a row; a `rejected` one leaves the row needing a test, and the row must change to `tested` before its gate.

### 15.2 What must have rows

- **TMF630:** every normative statement of the v4.2.0 text, the verified baseline (10), and every v5 change seen in the pinned v5 OpenAPI documents, user guides and conformance profiles. Rows taken only from R14.5.1 or v5 documents before the v4.2.0 text is read stay `pending` (10).
- **Each pinned TMF Open API:** its conformance profile's mandatory resources, operations, attributes, filters and notifications; its OpenAPI document's required properties, enumerations, operations, status codes and media types; its kit's mandatory cases.
- **ODA:** the fields the `oda.tmforum.org/v1` Component CRD and its child CRDs (`ExposedAPI`, `DependentAPI`, `PublishedNotification`, `IdentityConfig`) require, the CRD's normative field descriptions, every field 13.1 and 13.2 set, and the Canvas behaviors 13.3 relies on (install, upgrade, uninstall, exposed APIs, dynamic roles). The Component CRD alone requires almost nothing, so its required fields are too thin a basis [checked: `oda-component-crd.yaml` v1; decision 0026, FODA-02].
- **ITIL:** one row per behavior of 14, citing the ITIL 4 practice concept it implements (STD's own wording); ITIL defines no testable states, so these rows test STD's statement of the practice, and the edition review is resolved question 8.

### 15.3 Exclusions Martin accepted

Every deliberate gap is an exclusion with a decision-log entry. Martin accepted all twelve on 2026-10-22 (decision 0021, decisions 14 to 25), and `docs/conformance/decisions.yaml` records each as `decided`, outcome `accepted`. A new exclusion starts `proposed` and blocks its step's gate until he decides it: JSONPath `filter` (10.3); JSON Patch Query (10.5); filters on array and json attributes (11.1); the `.regex` and `.exact` operators (10.3); `If-Match` required on the generic API (10.5); STD's extensions to the generic API (`withheld`, `condition`, `count=false`, refusal of unknown query parameters; 10.2, 10.3); resources not served (`troubleTicketSpecification`, TMF641 `serviceOrderSpecification`; 11.1); TMF641 and TMF622 Milestone, Jeopardy and ErrorMessage events and the never-shown `assessingCancellation` and `pendingCancellation` states (11.5); TMF621 notes append-only and attachments as references only (11.2); TMF672 writes that are `NotRepresentable` (11.3); `POST` of events on TMF688 resource topics (12.3); no subscribed events or dependent APIs in the ODA Component (13.2).

### 15.4 The CI check

`check-conformance-matrix`, part of `pnpm check:tooling`, fails when:

- a file does not parse against the row schema, an `id` repeats, a file's specification or version differs from its pin or no pin names it, or a pinned specification in `pins.json` has no file (outside gate mode, a pin with `awaitingMatrix` is reported as a note instead);
- a `tested` row names a test file that does not exist or a title that no `describe`, `it` or `it.effect` in that file has (read statically);
- an `excluded` row names a decision that does not exist or whose `rows` do not list it, or a decision lists a row it does not exclude (rows of a file not yet written are not checked) [judgment: keeps the two directions of 15.1 consistent];
- the decision log does not parse against its schema, so a `decided` entry without an `outcome` fails;
- in gate mode (`--gate step3`, `step4`, `step5`, run by the release workflow of that step's tag), any row of that step's specifications is `pending`, or is `excluded` by a decision that is `proposed` or `rejected`; rows count for a step when their `step` (or their specification's) is at most that step, and a specification of the step whose file is missing or has no rows for it fails too.

`--summary` prints the row counts per file, source document and status that the gate review records.

Completeness against the sources cannot be checked mechanically: the gate review records, per source section, how many rows it has, and a second reviewer signs the file in `docs/gates.md`.

### Acceptance tests

- `conformance-matrix-check`: fixtures with a missing test file, a misspelt title, an unknown decision, a `pending` row, a `proposed` decision and a `rejected` decision in gate mode, a `decided` decision without an outcome, a pin that differs from `pins.json`, and a duplicate `id` each fail; a clean fixture with an `accepted` exclusion passes.

## Open questions for Martin

1. **Global pause on config commits.** Every config commit, including a label edit, briefly pauses all requests through the exclusive `CONFIG_KEY`. Per attempt the pause is bounded by the `CONFIG_KEY` wait (200 ms) plus the 2 s DDL lock budget (1.4 step 2) plus the main transaction's own work; index or catalog maintenance running at the same time can add up to the remaining budget per internal lock it contends. Default: accept for v0.1 and measure the pause in Stage 0; per-table locking only if measured pauses are a problem. Measured (decision 0007): a small change set pauses requests about 3 ms (p95 5 ms); a commit blocked by a long request costs 200 ms per attempt, 5 attempts; DDL waiting for a lock held outside STD costs up to the 2 s lock budget per attempt, which 1.4 now enforces per attempt by taking every table lock of a DDL statement explicitly under the remaining budget, from an inventory a CI guard keeps complete (`lock_timeout` alone is per lock); index and catalog locks taken inside the DDL are capped at the remaining budget each, and only direct index or catalog maintenance contends them. Recommendation: accept, and keep index and catalog maintenance out of schema-change windows.
2. **Offline upgrades.** Default: v0.1 upgrades run with servers stopped. The alternative, rolling upgrades now, needs expand-and-contract rules for every migration and definition change.
3. **Case-insensitive text by default.** Default: yes, Unicode full case folding, accent-sensitive, with a per-field `caseSensitive` opt-out.
4. **One access-rule condition for both states.** Default: one condition is checked against the existing and the proposed record, for record and field rules alike, so handing a record to someone else needs a broader rule. The alternative is a separate proposed-state condition, like RLS `WITH CHECK`.
5. **Dead-letter default.** Default: `block`, which keeps per-record order unconditional but holds one record's later deliveries for that subscription until an operator acts. The alternative is `skip`.
6. **Benchmark gate.** Default: the budgets in 2.6 (Q5 at most 5 ms, list queries at most 50 ms, Q2 at most 250 ms, writes at most 20 ms, p95 at 10M records on 8 vCPU, 32 GB, NVMe) and the 2x rule against one table per hierarchy decide whether class-table storage is kept.

### Resolved by Martin on 2026-10-22 (decision 0021)

Questions 7 to 28 came from Martin's TM Forum, ODA and ITIL requirement. He accepted every one as recommended; the sections above state the outcome, and decision 0021 records it.

7. **TMF630's text.** Decided: build on the free v4.2.0 text now as the verified baseline (10, 15); join TM Forum, or have a TM Forum member check the v5 rules, before `v0.1.0` (a Step 5 gate item); decide on certification after `v0.1.0` (decision 0021, decision 1).
8. **ITIL edition.** Decided: ITIL 4 practice concepts, in STD's own words; review against ITIL (Version 5) before `v0.1.0` (14.1; decision 0021, decision 5).
9. **Attribute names in v2.** Decided: lowerCamelCase API names derived from snake_case definition names, with clashes refused (10.2). The alternative is keeping snake_case in v2 as a marked deviation (decision 0021, decision 7).
10. **ODA packaging.** Decided: one STD component per install, a custom component (13.1). The alternatives are components along TM Forum's golden boundaries sharing one database, or separate databases with federated references (decision 0021, decision 8).
11. **TMF672 writes.** Decided: simple allow rules are writable through TMF672; denies, field rules and conditional rules are read-only there (11.3; decision 0021, decision 10).
12. **CTKs in public CI.** Decided: download the pinned kits in CI and never commit them, plus OpenAPI contract tests; ask TM Forum to confirm the kits' licence (11.1; decision 0021, decision 2).
13. **TMF630 parts 5 and 6.** Decided: no JSONPath `filter` and no JSON Patch Query in v0.1 (10.3, 10.5; decision 0021, decision 11).
14. **TMF API versions.** Decided: the pins of 11.1, including TMF641 v4.2.0 and the pre-production TMF688 v4.0.0 (decision 0021, decision 3).
15. **Compatibility of the existing API.** Decided: `/api/v1` frozen and deprecated from Step 3, removed in `v0.1.0` (10.1, 10.7; decision 0021, decision 6).
16. **Incident and problem API.** Decided: TMF621 for both, as Martin decided, not TMF724 Incident or TMF656 Service Problem (decision 0021, decision 4).
17. **Canvas CI cadence.** Decided: the Canvas deployment runs nightly and on release candidates, not on every PR (13.6; decision 0021, decision 9).
18. **Preconditions in v2.** Decided: `If-Match` stays required on the generic API's `PATCH` and `DELETE`, and is optional on TMF APIs (10.5, 11.1; decision 0021, decision 12).
19. **Scope of v0.1.** Decided: five steps; minimal approvals, the CMDB and OIDC bearer tokens move into v0.1; service level management stays later (plan; decision 0021, decision 13).
20. **Aggregate parts.** Decided: a reference may be declared the owner reference of its class (6.5, 4.9); every write of a part or owner, through every surface, locks the aggregate root first and queues the owner; at the end of the outermost save the touched owners are settled in memory to a fixed point and each persisted at most once, by an aggregate save that is never a no-op. It changes Contracts 2.2's lock order for parts, 4.1's pipeline and 4.2's entries (decision 0021, decision 26).
21. **Config subscriptions.** Decided: Contracts 4.6 allows subscriptions on the `role` and `accessRule` config kinds, with deliveries written in the change set's transaction, and an access-rule change bumps the version of each role it names, so role events follow each role's own order (decision 0021, decision 27).
22. **Matrix exclusions.** Decided: every exclusion of 15.3 is accepted; `docs/conformance/decisions.yaml` records each as `decided`, outcome `accepted` (decision 0021, decisions 14 to 25).
23. **Aggregate ownership.** Decided: one required owner reference per class, read-only after create (a move is a delete and a create), no cycle, at most 3 levels; a class needing two owner kinds is split (`helpdesk.change_approval`, `helpdesk.request_item_approval`); multi-aggregate operations lock by root ID (4.9; decision 0021, decision 28).
24. **`data` migrations.** Decided: a ledger `state` (`running`, `applied`) that startup and `doctor` check, run by `std upgrade` after set loads as the system user (1.9, 1.10, 3.1, 8.5; decision 0021, decision 29).
25. **Events stricter than reads.** Decided: an event whose trigger is a derived field fires only for identities that can read all its sources, although the same identity can read the derived field itself through the API and history (12.1; decision 0021, decision 30).
26. **Helm lifecycle.** Decided: a hook-free chart with a per-attempt upgrade Job, `Recreate` Deployments and init containers waiting for that attempt's completion, which works with and without `--wait` and with a bundled or external database (13.1; decision 0021, decision 31).
27. **Aggregate rule language.** Decided: record rules as declared in 4.10, with `before` rule kinds `derive`, `guard` and `invariant`, with the aggregate-only quantifiers `anyPart` and `allParts` and owner paths in the condition AST, evaluated in TypeScript only (5.2, 5.10; decision 0021, decision 33).
28. **Attempt IDs and GitOps.** Decided: the chart accepts an externally supplied `upgradeAttempt` and generates one per render only when it is absent; GitOps users set a new value for every rollout (13.1; decision 0021, decision 32).
