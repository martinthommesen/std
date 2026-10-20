# STD core contracts

Status: draft, 2026-10-20. Companion to "STD platform core: plan".

## How to read this

Sections 1 to 8 match the eight points of Martin's review, in order. Section 9 covers the Effect toolchain. Each section states decisions with a one-line reason, then lists acceptance tests. The plan says in which stage each part lands. Markers: **[checked: link]** is a fact verified in the Postgres 18 docs, the Postgres or Effect source, or another primary source; **[unverified]** is not verified; **[judgment]** is a design choice or claim that is the author's judgment; **[spike]** must be confirmed in Stage 0 before Step 1 relies on it. All paths and command names are placeholders until implemented.

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

## 1. Schema lifecycle

Covers how definitions change without breaking references, stalling the application or losing data. Field type changes on tables with data stay deferred.

### 1.1 Stable identity and names

- Every namespace, table, field, index, child-class override, choice, layout, rule, access rule, role, permission and subscription has a stable UUID. It never changes and is never reused. Reason: renames and upgrades must not break anything that points at a definition.
- Names are separate and can change. Table names are unique per namespace. Field names are unique per hierarchy, counting active and retired fields.
- Stored configuration refers to definitions by ID only: layouts, rules, access rules (including the roles they name), stored conditions, indexes, the dependency index (1.7), change entries. Names appear only at the edges (API paths, filter text, definition files) and are resolved when parsed.
- Physical names: tables and columns use STD names, so plain SQL stays readable, and a rename runs `ALTER TABLE ... RENAME [COLUMN]`. Index and constraint names are built from the stable ID (`std_ix_<32 hex>`, `std_nn_<32 hex>`), so renames never touch them and recovery finds them by ID. Identifiers are limited to 63 bytes [checked: [limits](https://www.postgresql.org/docs/18/limits.html)].
- Shipped definitions carry their ID in the definition file, so they have the same ID on every install. Records and API-created definitions get a UUIDv7 from `uuidv7()` [checked: [UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html)]. STD relies only on uniqueness, not on monotonicity, which the docs do not promise.
- Generated SQL never uses `SELECT *`. Reason: adding a column must not change the row shape of a prepared statement.
- Admins can rename local tables and fields. Core and app definitions are renamed only by a new version of their set (8.4).
- No aliases: after a rename, the old name is an unknown field. Reason: aliases make filter text ambiguous. [judgment]
- Moving a table between namespaces is not supported in v0.1.

### 1.2 Schema revision

- `core.config_state` holds one row: `revision bigint` and `change_set_id uuid`. Sent on the wire with the change set ID (6.2); the number is a JSON number (it cannot reach 2^53 in practice). [judgment]
- Each config commit adds exactly 1 inside its own transaction. Config commits are serialized (1.4), so revisions have no gaps and follow commit order. This is deliberately not a Postgres sequence: `nextval` is never rolled back and values are allocated at call time, independent of commit order [checked: [sequence functions](https://www.postgresql.org/docs/18/functions-sequence.html)].
- The revision covers every configuration kind the runtime caches: namespaces, tables, fields, indexes, choices, layouts, rules, access rules, roles, role permission grants, subscriptions and overrides. Reason: a request must see one consistent combination of fields and rules. User-role assignments are data, not configuration, and do not bump it.
- A change set with follow-up steps ends with a `complete` step that takes its own revision.

### 1.3 How requests and caches see a revision

- Every record-service call, reads included, runs in one READ COMMITTED transaction whose first statement is `SELECT revision, change_set_id FROM core.begin_request()`. The SQL layer refuses isolation levels other than READ COMMITTED for request, batch and worker transactions. Reason: under REPEATABLE READ the snapshot is taken before the lock wait.
- `core.begin_request()` is a VOLATILE PL/pgSQL function. It takes `pg_advisory_xact_lock_shared(CONFIG_KEY)`, then reads `(revision, change_set_id)`. A VOLATILE function takes a fresh snapshot per query, so the read sees a config commit that finished while the lock call waited [checked: [function volatility](https://www.postgresql.org/docs/18/xfunc-volatility.html)].
- Every config commit takes `pg_advisory_xact_lock(CONFIG_KEY)` exclusively first. So no request overlaps a config commit, and each request runs at one revision.
- Derived artifacts (per-class Effect Schemas, generated SQL, OpenAPI, metadata) are cached under `(revision, change_set_id)`. A process whose cache differs loads the new snapshot before compiling; one load at a time per process. Including `change_set_id` catches a restored database that reaches the same number through different changes. [judgment]
- Every config commit runs `pg_notify('std_config', '<revision>')` inside its transaction, delivered only on commit [checked: [NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html)]. This is acceptable because config commits are serialized anyway (see 4.1 for why saves do not). Processes LISTEN and reload early. Correctness comes from `begin_request()`, not from NOTIFY.
- The `listen` stream does not reconnect by itself [checked in effect-smol `main` before 4.0; re-check against the pinned 4.0.5 source]. STD wraps it with retry and re-reads the revision after reconnecting.
- Request transactions set `statement_timeout = 30s` and `idle_in_transaction_session_timeout = 10s` [judgment on values], so an abandoned request cannot hold back a change for long.
- Long jobs run in batches, each with its own transaction and `begin_request()` (7.6).
- Every API response carries the revision it was served at (6.2).

### 1.4 Change sets, serialization and locks

- Writes to config tables (definitions, roles, access rules, layouts and other config records) through the generic record API become a one-operation change set. They are routed onto the change-set path before `begin_request()`. That transaction takes `CONFIG_KEY` exclusive as its first lock and runs the save steps (access checks, history) under it, never upgrading a lock. Reason: two requests holding `CONFIG_KEY` shared and both asking for exclusive would deadlock.
- A fixed admin endpoint accepts several operations as one change set. Each operation names the definition's `version`.
- `DELETE` on a definition record is refused with `UseRetireOrPurge`. Reason: an ordinary delete must never destroy a column.

| Lock | Kind | Holder | Purpose |
| --- | --- | --- | --- |
| `SCHEMA_KEY` | session advisory, exclusive | coordinator of a change set with DDL or a data preflight, from start through `complete`; `std upgrade` | one such change set at a time, including non-transactional steps |
| `CONFIG_KEY` | transaction advisory | requests shared (via `begin_request()`); config commits exclusive | a request never overlaps a config commit |

- `SCHEMA_KEY` is taken with `pg_try_advisory_lock`, never a blocking call under `lock_timeout`. Reason: a timed-out advisory lock request was reported to fail although the lock was granted ([pgsql-bugs #17686](https://www.postgresql.org/message-id/17686-fb1fa3870138e394%40postgresql.org)) [checked the report, not whether it is fixed]. For `CONFIG_KEY` that race does no harm: the timeout aborts the transaction, which releases a transaction-level lock.
- If another change set holds it, the caller gets `SchemaBusy` (503 with `Retry-After`) naming that change set. No queue in v0.1.
- The coordinator holds `SCHEMA_KEY` on one dedicated connection outside the pool, connected directly to Postgres, and runs every statement of the change set on it. [spike: the Effect API for a dedicated connection]
- Changes without DDL or data preflight (labels, layouts, rules, access rules) take only `CONFIG_KEY`.
- Lock order is always `SCHEMA_KEY`, `CONFIG_KEY`, table locks. Requests take `CONFIG_KEY` before any table lock. So STD sessions cannot deadlock on these.
- Nothing that scans record tables runs while `CONFIG_KEY` is held exclusively. Data counts and preflights run under `SCHEMA_KEY`, before `CONFIG_KEY`.

Main transaction of a change set:

1. `BEGIN`; `SET LOCAL lock_timeout = '200ms'` [judgment]; `pg_advisory_xact_lock(CONFIG_KEY)`, which also drains STD requests.
2. `SET LOCAL lock_timeout = '2s'`; `SET LOCAL statement_timeout = '15s'` [judgment on values].
3. Load definitions, validate, run dependency checks (1.7), in memory.
4. Run the DDL, only in the forms below.
5. Write definition rows, definition revisions (4.4), the dependency index, the journal and the audit entry.
6. Bump `core.config_state`.
7. `pg_notify`, `COMMIT`.

- Locks are held until the end of the transaction [checked: [explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html)], and without `lock_timeout` a request waits indefinitely [checked: [client defaults](https://www.postgresql.org/docs/18/runtime-config-client.html)].
- Postgres queues a new lock request behind any waiting request it conflicts with [checked: `waitMask` test in src/backend/storage/lmgr/lock.c, REL_18_STABLE]. So while a config commit waits for `CONFIG_KEY`, new STD requests wait too, and while its DDL waits for a table lock, later requests on that table wait, plain reads included. Per attempt, the request pause is at most the `CONFIG_KEY` wait (200 ms) plus the DDL lock wait (2 s) plus the main transaction's time. Between attempts requests run normally.
- On lock timeout the transaction rolls back and retries after 0.5, 1, 2 and 4 s with jitter, 5 attempts in total [judgment]. Then `SchemaLockTimeout`, naming the sessions holding conflicting locks (from `pg_locks` and `pg_stat_activity`). Nothing applied, revision unchanged.

DDL forms STD generates [checked: [ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html), [CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html)]. ALTER TABLE takes `ACCESS EXCLUSIVE` unless the page notes a lower lock, and that is the only mode that blocks plain `SELECT`.

| Operation | Postgres form | Lock | Rewrite or scan | Runs in |
| --- | --- | --- | --- | --- |
| Create table (including child table and level FK) | `CREATE TABLE`, plain `CREATE INDEX` | new table invisible until commit; FK takes SHARE ROW EXCLUSIVE on the parent | none | main |
| Add field | `ADD COLUMN`, no default or a constant default | ACCESS EXCLUSIVE | none: a non-volatile default is stored in the catalog | main |
| Add reference field | `ADD COLUMN` without `REFERENCES`, then `ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID` | ACCESS EXCLUSIVE on the table; SHARE ROW EXCLUSIVE on both tables for the FK, which blocks writes to the target briefly | none; `VALIDATE` scans | main, then validate as follow-up |
| Rename | `RENAME`, `RENAME COLUMN` (cannot combine with other subcommands) | ACCESS EXCLUSIVE | none | main |
| Set or drop default | `ALTER COLUMN SET/DROP DEFAULT` | ACCESS EXCLUSIVE | none | main |
| Retire a required field | `ALTER COLUMN DROP NOT NULL` | ACCESS EXCLUSIVE | none | main |
| Purge field | `DROP COLUMN` | ACCESS EXCLUSIVE | none; column becomes invisible, its indexes and constraints are dropped | main |
| Make required on a table with rows | `ADD CONSTRAINT std_nn_<id> NOT NULL col NOT VALID`, then `VALIDATE CONSTRAINT` (new in 18) | add: ACCESS EXCLUSIVE; validate: SHARE UPDATE EXCLUSIVE | validate scans without blocking reads or writes | add in main, validate as follow-up |
| Check constraint (max length) | `ADD CONSTRAINT ... CHECK (...) NOT VALID`, then `VALIDATE` | as above | as above | as above |
| Index or unique index on a table with rows | `CREATE [UNIQUE] INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | two scans | follow-up, outside any transaction |
| Drop index | `DROP INDEX CONCURRENTLY` | does not block reads or writes [checked: [DROP INDEX](https://www.postgresql.org/docs/18/sql-dropindex.html)] | none | follow-up, outside any transaction |

- STD adds a reference's FK constraint separately as `NOT VALID`, so no validation scan runs under ACCESS EXCLUSIVE.
- Refused in v0.1, because each rewrites or scans under ACCESS EXCLUSIVE [checked]: `ADD COLUMN` with a volatile default, identity, stored generated column or constrained domain; `ALTER COLUMN TYPE`; `SET NOT NULL` without a validated constraint that proves it.
- Adding a required field to a table with rows needs a constant default; without one it is refused with `ExistingDataViolates` before any SQL runs.
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
- Step kinds: `validate_constraint`, `validate_override`, `create_index_concurrently`, `drop_index_concurrently`, `complete`; Step 2 adds `backfill` (batched, resumes from a stored keyset cursor).
- The coordinator runs steps in order on its `SCHEMA_KEY` connection, marking `running` and `done` in autocommit.
- Concurrent index statements cannot run in a transaction block, and a concurrent build waits for transactions that modified the table and for older snapshots [checked: [CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html)]. The coordinator keeps no transaction open while such a step runs. These steps use `lock_timeout = 0` plus a watchdog.
- Watchdog: after 10 minutes in a waiting phase [judgment], it reports the PIDs the build is waiting for (from `pg_stat_progress_create_index.phase`, `pg_locks` and `pg_stat_activity`) in the step's `last_error`, in `std schema status` and as a metric. It never cancels on its own; cancelling is an operator decision through `std schema abandon`.
- `complete` is a short transaction under `CONFIG_KEY`: sets enforcement states, bumps the revision, marks the change set `completed`.
- Each step defines a **probe** (reads the catalog: `done`, `not_started` or `partial`), the **action**, and an **abandon action** (drop the index or NOT VALID constraint, set enforcement `failed`).

Coordinator connection:

- It runs `SET tcp_keepalives_idle = 30, tcp_keepalives_interval = 10, tcp_keepalives_count = 3` [judgment on values]. Reason: after a network partition or a host crash with no TCP reset, an idle backend otherwise keeps `SCHEMA_KEY` until the OS keepalive fires, often after 2 hours.
- STD assumes `client_connection_check_interval = 0` (the default), so a running build is not cancelled when its client disappears. `doctor` reports a different setting.
- `std schema status` shows the lock holder's PID and client address.

Resume:

- Each server process and `std upgrade` tries `pg_try_advisory_lock(SCHEMA_KEY)` at startup and every 30 s [judgment], on a dedicated connection. Getting it proves no coordinator is alive, because a session lock is released when its backend ends. If nothing is open, it releases the lock at once.
- The holder resumes change sets in `applying`, probing each unfinished step: `done` is recorded; `partial` is cleaned up and rerun (an invalid index is dropped first, as the docs recommend); `not_started` runs.
- A build runs on the backend holding `SCHEMA_KEY`, so if the coordinator process dies mid-build, the lock stays held until the build ends and no resume can race it.
- A step that errors is retried 3 times [judgment], then the change set moves to `needs_attention` and `doctor` reports it. An admin fixes the cause and runs `std schema resume <id>`, or runs `std schema abandon <id>` (abandon actions plus `complete`).
- A failed concurrent unique build leaves an invalid index that still enforces uniqueness [checked], so abandon drops it at once.

### 1.6 Field and table lifecycle

| State | Column or table | Reads | Writes | Forms and default selection | Next |
| --- | --- | --- | --- | --- | --- |
| `active` | exists | yes | yes | shown | `retired` |
| `retired` | kept with data | only when selected explicitly, under access rules | refused (`DefinitionRetired`) | hidden | `active`, `purged` |
| `purged` | dropped | no | no | no | none (tombstone) |

- Retiring keeps the data and drops `NOT NULL` (catalog-only), so inserts without the field work. A reactivated field comes back optional.
- Retiring a parent field retires it on every child class. A retired table accepts reads only.
- Purge needs the `schema.purge` permission (3.1; held by the built-in `schema_purger` role, not by `admin`), a target retired in an earlier committed revision, no blocking dependents (1.7), and a confirmation naming the target's ID and version. It is journaled and audited with the number of values or rows destroyed. The count runs under `SCHEMA_KEY` before `CONFIG_KEY`; a retired field or table refuses writes, so the count is stable.
- A tombstone keeps ID, last name, type, label and purge revision, so history can interpret old values. The name becomes free; the ID is never reused.
- A purge does not free a column slot: dropped columns count toward the 1,600-column limit [checked: [limits](https://www.postgresql.org/docs/18/limits.html)].
- A purge leaves history values in place; erasure is deliberately later.

### 1.7 Dependency checks

- `core.config_dependency (from_id, to_id, kind)` records every reference between config records, maintained in the same transaction as each config write. Kinds: `extends`, `field_of`, `references_table`, `index_on`, `display_field`, `layout_uses`, `condition_reads`, `rule_writes`, `access_rule_on`, `rule_role` (access rule to role), `choice_of`, `overrides`, each registered when its feature lands.
- Dependency checks read only config tables and run in the main transaction under `CONFIG_KEY`, so no concurrent write can add a dependent. Data counts run before it (1.4).

| Operation | Refused when | Reported but allowed |
| --- | --- | --- |
| Rename | target is protected, or owned by core or an app and the caller is not its set | nothing |
| Retire field | protected; display field; an active rule writes it; part of a multi-field unique index | layouts, conditions, access rules that read it |
| Retire table | protected; has a child class not retired; a non-retired reference field points at it | other dependents |
| Purge field | not retired; any non-retired dependent except layout entries and single-field indexes | count of non-null values (counted under `SCHEMA_KEY`) |
| Purge table | not retired; a child class or incoming reference not purged | row count (counted under `SCHEMA_KEY`) |
| Delete or retire role | protected; an active access rule names it (`rule_role`) | user-role assignments |
| Tighten required, unique, max length, override | existing rows violate it (preflight, 1.4) |  |
| Change type | always, in v0.1 |  |

- Refusal: `DependencyConflict` (409), listing each blocking dependent by ID, kind and name.

### 1.8 Protected core definitions and local additions

- Core definitions carry `protected = true`, settable only by core definition files. They accept no local change except label and help-text overrides (8.2), for every caller.
- The check lives in the schema service, not in access rules, so a misconfigured rule cannot weaken it. Built-in access rules add a second layer.
- Admins may add `local` fields to app tables and to core tables marked `extensible` (the user table now), and may create `local` child classes of app classes and of `extensible` core classes. Platform tables (1.9) are never extensible.
- An upgrade whose set adds a name already used by a local field or class is refused at plan time. The report names the local definition; the admin renames it (1.1) and reruns.
- The `core` namespace and installed apps' namespaces are reserved.

### 1.9 Minimal migration mechanism

- **Platform tables** (`core.config_state`, definition tables, `core.definition_revision`, journal, config layer tables, migration ledger, outbox, import bookkeeping) are owned by platform migrations. Core definition files describe them so they appear in the API; the loader verifies them and never changes them. Reason: a change set cannot create the tables it writes into.
- **Core definition tables** (for example `core.user`) are ordinary STD tables loaded through change sets.
- Migrations are numbered, forward-only files, recorded in `core.platform_migration (id, checksum, std_version, applied_at)`. No down migrations; rollback is restoring the backup taken before the upgrade. Reason: down migrations are rarely tested and lose data.
- Kind `tx` (default) runs in one transaction with its ledger row. Kind `concurrent_index` is one `CREATE INDEX CONCURRENTLY` with a fixed name: the runner probes `pg_index` (valid: record; invalid: drop and rebuild; missing: build).
- Migrations follow the DDL table and timeouts in 1.4.
- The server refuses to start if a migration is pending, if the ledger holds one the code does not know, or if an applied checksum differs.
- Migrations run only through `std upgrade` (8.5), never at server start. Docker compose runs `std upgrade` as a one-shot service the server waits for.

### 1.10 `doctor`

`std doctor [--json]` only reads. Exit 0 clean, 1 on any error, 2 for warnings only. Informational findings do not affect the exit code. "Clean" means exit 0. Repairs are separate commands with normal authorization and journaling. [judgment]

Checks:

1. Migration ledger matches the code.
2. Every active and retired table and field matches the catalog (type, nullability, default, keys, level FK).
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
13. Mappings in `core.external_identity` that point at missing records (informational: this is the expected `TargetDeleted` state, 7.1).
14. The fold table's Unicode version equals the server's `unicode_version()` [checked: [system information functions](https://www.postgresql.org/docs/18/functions-info.html)] (5.5).
15. The database encoding is UTF8 (5.5), and `client_connection_check_interval` is 0 (1.5).
16. Each definition's latest `core.definition_revision` row equals its effective record (4.4).

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
- Purge is refused when active, retired in the same change set, without `schema.purge`, with a non-retired access rule reading it, or in a multi-field unique index; once causes are removed it succeeds and older history shows the tombstone label.
- Deleting or retiring a role that an active access rule names is refused with `DependencyConflict`.
- Every operation other than a label or help-text override on every protected definition, as admin, through both the generic API and the change-set endpoint, is refused and leaves `pg_catalog` unchanged; a label override on a protected definition succeeds and changes no catalog object.
- Adding a field with a constant default to a 1,000,000-row table leaves `relfilenode` unchanged, finishes under 100 ms [judgment] and does not increase `pg_stat_user_tables.seq_scan`. Adding a required field without a default to a table with rows is refused with `ExistingDataViolates` before any SQL runs.
- Every DDL statement in the SQL snapshots matches the 1.4 table; volatile defaults, type changes and direct `SET NOT NULL` are refused before any SQL runs.
- While psql holds an open transaction on `acme.asset`, adding a field fails after 5 attempts with `SchemaLockTimeout` naming its PID; nothing applied; per attempt no STD request waits longer than the `CONFIG_KEY` wait plus the DDL lock wait plus the main transaction's time.
- Request latency is measured during a config commit while a 30 s request and an import batch are in flight; the result is committed with the 0F probes.
- Tightening an override on a 1,000,000-row subtree: the request pause is measured and does not include the preflight scan; rows written during the window are reported and the `validate_override` step ends `enforced` or `failed`.
- A second DDL change set during the first one's follow-up phase gets `SchemaBusy`, while a label change at the same moment succeeds.
- Making a field required on a table with nulls is refused with count and samples; after a backfill it succeeds with a validated constraint.
- For "make serial unique" on 1,000,000 rows, SIGKILL of the coordinator at each step boundary and during the build always ends completed with one valid index and `doctor` exiting 0.
- A duplicate inserted during a unique build leaves `needs_attention`; `std schema abandon` drops the invalid index, sets enforcement `failed`, bumps the revision, and `doctor` exits 0.
- An index build blocked by an idle-in-transaction session is reported by the watchdog with that session's PID and is not cancelled.
- The server refuses to start with a pending, unknown or changed migration; killing `std upgrade` during a `tx` and a `concurrent_index` migration and rerunning applies each once.
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
   - Lock order: every write first locks the root row alone (`SELECT version ... FOR NO KEY UPDATE`), then computes visibility and existing-state checks in the next statement, which takes a fresh snapshot, then writes level rows top down. Reason: under READ COMMITTED, after a lock wait only the locked row is re-fetched, so a single statement could judge joined level rows on stale data.
   - Updates use `FOR NO KEY UPDATE`, except that a patch changing a column with a non-partial, non-expression unique index locks `FOR UPDATE` from the start, because such an UPDATE takes `FOR UPDATE` anyway [checked: [explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html)]. Deletes use `FOR UPDATE`. `FOR NO KEY UPDATE` does not block the `FOR KEY SHARE` locks other transactions' FK checks take [checked: same page].
4. **Whole-record delete.** The service deletes the root row with a version check; level FKs remove level rows in the same statement. One change entry holds all levels; it and its deliveries carry `record_version` = current version + 1. This is not a cascade between records: no other record changes. A reference from any other record refuses the delete (3.10).
5. **Child rules through the parent endpoint.** The service reads and locks the root row to learn the concrete class C, validates against C's effective schema (its fields plus overrides from C and its ancestors), applies access rules attached to C and every ancestor, and runs hooks and record rules attached to C and every ancestor, whichever endpoint is used. The parent endpoint can name only fields of its class and ancestors; a child-only field gets `UnknownField`. A create makes a record of exactly the endpoint's class. [judgment]
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
3. No VALIDATE. The NOT VALID check already applies to new rows, and the old validated check implies the new one, so a scan of every ancestor would gain nothing. The widened check is recorded as `enforced` with a note saying so, and `doctor` check 3 accepts that state. [judgment]

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
| Choices (Step 2) | a subset of the parent's values | record service |
| Not overridable | name, ID, type, column, database nullability, unique, indexes, reference target, delete behavior |  |

- No database CHECK enforces overrides in v0.1: it would sit on the parent's table and be rewritten whenever the subtree grows. [judgment]
- Adding or tightening an override follows the 1.4 tightening pattern: take `SCHEMA_KEY` and run a preflight count before `CONFIG_KEY` (refused with the count if any record in the subtree violates it); the record service enforces it from the main commit; a follow-up `validate_override` step rechecks and sets enforcement. `doctor` reports violations.

### 2.6 Benchmark (Stage 0, rerun in Step 4)

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

- **Method:** Postgres 18, hardware and config recorded; reference machine 8 vCPU, 32 GB, NVMe [judgment]. Seeded generator, `ANALYZE`, 10 warm-up and 200 measured runs per read with random parameters, p50 and p95, `EXPLAIN (ANALYZE, BUFFERS)` of a median run, writes for 60 s, table plus index size. In Stage 0 the alternatives are hand-written SQL. In Step 4, class-table queries are issued through the record service (STD-generated SQL) for both callers. Results and script are committed.
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

- `core.user` (`name` as display field, `login`, password hash of type `password`, `active`), `core.role`, `core.user_role`. Roles are flat in Step 1; groups and nested roles come in Step 3.
- Roles are config records with a stable ID and an owner layer. They are shipped in sets, loaded in the phase before access rules (8.3), and covered by the schema revision (1.2). User-role assignments (`core.user_role`) stay data. Deleting or retiring a role that an active access rule names is refused with `DependencyConflict` (`rule_role`, 1.7).
- Permissions are protected built-in config records (`core.permission`, with stable IDs), granted to roles through `core.role_permission` (config, covered by the revision) and checked by permission ID [judgment]. v0.1 permissions: `schema.purge` (1.6), `schema.snapshot` (6.8), `rules.run_as` (4.1).
- `core.access_rule`: `effect` (allow or deny), `roles`, `class` (one class or `*`), `target` (records, or fields as a list or `*`), `actions` (read, create, update, delete; field rules cannot use delete), optional `condition`.
- Built-in roles: `admin`; `authenticated`, held implicitly by every active user [judgment]; `schema_purger`, which holds `schema.purge`. Built-in roles, permissions and rules are protected definitions.
- Password sign-in for every active user (Stage 0: the demo users). API tokens, explain mode and the rule editor come in Step 3.
- The acting user is a required Effect service of every record-service operation, so a code path with no actor does not type-check. The HTTP layer has no default actor. The system user acts only for bootstrap and definition loading.

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

Built-in rules: allow `admin` everything on `*`; allow `authenticated` read on `core.user` records and its `name` field, for `created_by` labels [judgment]; deny every role delete on `core.user`. Everything else, including definition tables, `core.access_rule` and `core.change`, is reachable only through the admin rule.

### 3.3 Two-user example

- `acme.asset`: `name`, `owner` (reference to user), `status`, `cost`, `purchased_on`, `docked_to` (reference to asset). `acme.laptop` adds `serial` and `disk_key` and overrides `purchased_on` to required. `acme.monitor` adds `size_inches`.
- Alice has role `asset_manager`; Bob has `employee`.
- Fixture: Bob owns laptop L (cost 1200, docked to Alice's monitor), monitor M (cost 300, not docked) and plain asset S (cost 2500, status `lost`). Alice owns that monitor and a laptop K.

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
- Counts use the same `FROM` and `WHERE` as the page and are returned only on request (6.6). No total or "has more" flag comes from an unrestricted query.

### 3.6 References

- A label is shown only if the caller can read the reference field, the target is visible, and the caller can read the target's display field on it. It comes from a join applying the target's visibility and masks.
- If the reference is readable but the label is not, the value is the UUID with no entry in `labels` (6.6), whether the target or only its display field is hidden. If the reference field is not readable, the key is absent.
- One hop in filters and selection: the reference's own mask first, then the target's visibility in the join condition and its field masks. A hidden target behaves like an empty reference.
- Writing a reference requires a visible target; otherwise `InvalidReference`, identical to an unknown ID.
- Accepted leak: UUIDv7 IDs encode creation time. [judgment]

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
- `platform-tables` (Step 1): As Bob, the generic `core.change` and `core.access_rule` endpoints return `UnknownTable`.
- `users` (Step 1): Admin deleting a user gets 403; a deactivated user cannot sign in and labels still resolve.
- `no-bypass` (Step 1): With the admin allow-all removed in a test database, admin requests are refused.
- `error-fuzz` (Step 1): Fuzzed constraint violations never return Postgres text or values.

## 4. History and the outbox

### 4.1 Save pipeline and hook phases

Every save (create, update, delete; single or batch) runs in one transaction:

1. Writes to config tables take the change-set path (1.4). Otherwise `begin_request()` (1.3). Check staleness and resolve names (6.4, 3.4: `UnknownField`).
2. Lock the root row alone (2.2 item 3). In the next statement check visibility (`NotFound`), load all level rows, check the expected version (`VersionConflict`).
3. Existing-state access checks (3.9) (`NotAllowed`).
4. Normalize proposed values to canonical form (6.5). If the save is a no-op (3.9), return the current record; no hooks, no writes.
5. Before-write hooks.
6. No-op check again. Validate against the concrete class's effective schema (`ValidationFailed`).
7. Write level rows; bump the root version.
8. Proposed-state access checks (`NotAllowed`, rollback).
9. Write the change entry (4.2) and one delivery row per matching subscription (4.6).
10. After-write hooks.
11. If outermost, commit. After commit, outside the transaction, send a worker wake-up, debounced to at most one per process every 250 ms [judgment]. Reason: a transaction that ran NOTIFY takes a database-wide lock in `PreCommit_Notify` and holds it until after commit, which would serialize the commits of all saves [checked: src/backend/commands/async.c, REL_18_STABLE].

Nested saves:

- A nested save joins the outer transaction and never opens a savepoint.
- If a nested save fails after its first write, the transaction is poisoned. The SQL layer refuses to commit a poisoned transaction (it rolls back and logs a defect), whether or not the caller handled the error. The same rule applies to hooked rows in `saveBatch` (7.7).
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
- Record rules (Step 3): a "before" rule is before-write; an "after" rule chooses after-write (synchronous, can fail the save) or after-commit (asynchronous, cannot).
- A nested Effect `withTransaction` issues `SAVEPOINT` [checked: Effect 4 `SqlClient` `makeWithTransaction`], so STD's SQL layer joins the outer transaction itself, and a test asserts no `SAVEPOINT` is issued.

### 4.2 Change entries

Each committed version of a logical record has exactly one change entry, written in step 9. A no-op writes none. A delete's change entry and its deliveries carry `record_version` = current version + 1.

`core.change` columns: `change_id` (UUIDv7, the idempotency key everywhere); `operation_id` (one per outermost transaction); `record_id`; `class_id`; `record_version`; `kind` (`create`, `update`, `delete`); `actor_id`; `cause` (`api`, `ui`, `import` with job and row, `hook` with hook and parent change, `after_commit` with subscription and parent change, `system`); `schema_revision`; `occurred_at` (informational, never used for ordering); `fields`, a map from field ID to `{before, after}` in canonical JSON (create: all non-empty `after`; update: changed fields; delete: all `before`). References store the ID only, never a label.

- `UNIQUE (record_id, record_version)`: every version bump, and every delete, has exactly one entry, whichever endpoint the save came through.
- Writes to other records in the same transaction are separate entries with the same `operation_id`.
- Writing history is a fixed pipeline step, not a hook, so configuration cannot disable it.

### 4.3 Secrets

- `password` and `secret` values never appear in change entries, delivery payloads, import reports, logs or errors. A change entry records them as `{"changed": true}` on create and update and omits them on delete.
- Converting a field to a secret type belongs to the deferred type-change feature, which must scrub earlier entries.

### 4.4 Interpreting old values

- `core.definition_revision (definition_id, revision, kind, effective jsonb)` is a platform table. It is written in the main transaction of every change set, and on every override change, for each definition whose effective properties changed. A reader resolves revision R from the latest row with revision <= R. `doctor` check 16 verifies that each definition's latest row equals its effective record.
- An entry stores field IDs and its schema revision, so a reader can look up label, type and choices as they were at that revision.
- Purged fields remain as tombstones (1.6), and their definition revisions are kept. The Step 2 history panel renders old values with the definitions at the entry's revision.
- The same table resolves request names at a request's revision (6.4).

### 4.5 Reading history

Access rules for history reads are in 3.7. The same filtering applies to the API, the form panel and exports.

Delivery payloads are filtered for the subscription's identity on the version's own image (the after image; the before image for a delete), under current rules. So a delete delivery to a non-admin identity carries the filtered before image, and a payload does not depend on the record's state when the delivery runs.

### 4.6 Outbox

**Why not a global sequence as a cursor.** Transaction A takes 100; B takes 101 and commits; a consumer moves past 101; A commits 100, which is never read. Sequence values are allocated at call time, independent of commit [checked: [sequence functions](https://www.postgresql.org/docs/18/functions-sequence.html)]. UUIDv7 IDs and `occurred_at` have the same flaw.

**Decision: a transactional outbox with one delivery row per matching subscription.** Reason: each subscription keeps durable retry state, and no cursor exists that could skip an uncommitted entry.

Producer side (Step 1):

- `core.subscription` is a config record (stable ID, owner layer): class (descendants included), operations, optional condition (subscription profile, 5.10), the identity it runs as, `max_attempts`, dead-letter policy.
- In step 9 each enabled subscription for the class is evaluated in TypeScript on `after` (on `before` for delete). Each match inserts into `core.delivery`: `id` (bigint identity, primary key), `subscription_id`, `change_id`, `record_id`, `record_version`, `status` (`pending`, `in_flight`, `done`, `dead`), `attempts`, `next_attempt_at`, `lease_until`, `lease_token uuid`, `last_error`, `UNIQUE (subscription_id, change_id)`. The payload is built from the change entry at delivery time (4.5).

Worker (Step 3):

- A worker claims a few rows with `FOR UPDATE SKIP LOCKED`, sets them `in_flight` with `lease_until` and a new `lease_token`, and commits. `SKIP LOCKED` suits queue tables but gives no global order [checked: [SELECT](https://www.postgresql.org/docs/18/sql-select.html)].
- Fencing: the done and failure updates are `WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'`. If 0 rows change, the worker has lost the lease and discards its result; in a delivery transaction that holds record writes, it rolls the whole transaction back. Expired leases are claimable again, and each claim writes a new token.
- The worker interrupts its effect before `lease_until`. The lease must exceed the effect timeout plus a margin [judgment].
- Record-service effects run in one delivery transaction that ends with the fenced `done` update (4.1). External calls run outside any transaction, then the fenced `done` update commits.
- Failure returns the row to `pending` with exponential backoff and jitter, 10 s doubling to 1 h [judgment]. After `max_attempts` (default 10 [judgment]) it is `dead`, shown in an admin view and a metric, for an operator to retry or discard.
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

Backed by a partial index on `(subscription_id, record_id, record_version)` where `status <> 'done'`. Per-record order holds because saves of one record are serialized by the root-row lock, so version n's delivery row commits before n+1's, and fencing stops a worker that lost its lease from releasing n+1 early. [judgment, proven by the SQL-level claim tests and the soak test]

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
  | { op: "changed"; arg: Path };
type Path = { path: FieldId[]; image?: "previous" }; // more than one ID follows references
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
- When a condition is stored or edited it is **checked** against a class and a profile: field IDs exist and are not retired, operators fit the type and profile, literals convert under the type's rules (not the field's settings: a decimal literal may exceed the field's scale; a retired but existing choice is allowed; an integer outside the type's range is refused).
- The not-retired check applies only when a condition is stored or edited. Stored conditions keep evaluating retired fields, whose columns still exist. Reason: skipping a deny rule that reads a retired field would fail open. Purge stays refused while any non-retired condition reads the field (1.7).
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
3. Single-line text: refuse CR, LF and C0/C1 controls other than tab; trim with the ECMAScript `trim()` set; `""` becomes null.
4. Long text: CRLF and CR become LF; no trimming; whitespace-only becomes null.
5. Count length in code points. Needles for `contains`, `startsWith`, `endsWith` get steps 1, 2 and 5 only.

The browser evaluator applies steps 1 to 4 to proposed text before evaluating form rules. If the input contains code points unassigned in the shipped fold table's Unicode version, atoms reading it return Unknown. Reason: `String.prototype.normalize` depends on each browser's Unicode version.

**Case.** Text fields are case-insensitive by default; `caseSensitive: true` turns it off (codes, tokens, external keys). key(x) = fold(x), or x when case-sensitive.

**fold(x)** is Unicode full case folding (CaseFolding.txt, statuses C and F):

- In Postgres: `casefold(x COLLATE pg_unicode_fast)`. The explicit collation pins the implementation, since under libc `casefold` is just `lower`. Postgres 18 ships Unicode 16.0.0 data [checked: [string functions](https://www.postgresql.org/docs/18/functions-string.html), [release notes](https://www.postgresql.org/docs/18/release-18.html)].
- In TypeScript: a fold table generated at build time from Unicode 16.0.0, shipped to server and browser. `toLowerCase` differs (it keeps `ß` and maps final `Σ` to `ς`).
- An exhaustive test over every scalar value proves the tables equal. Folding is context-free, so per-code-point equality implies string equality [spike: confirm with multi-character cases such as "ΣΑΣ"].

Why not a nondeterministic ICU collation [judgment]: ICU behavior changes with the ICU version Postgres is built against, Node and browsers ship their own ICU, nondeterministic collations lose B-tree deduplication, and `ILIKE`, `SIMILAR TO` and regular expressions do not support them [checked: [collation](https://www.postgresql.org/docs/18/collation.html), [pattern matching](https://www.postgresql.org/docs/18/functions-matching.html)]. A pinned fold table is reproducible and exhaustively testable.

Deterministic but surprising, identical in both engines: `ß` ≡ `ss`, `ﬁ` ≡ `fi`, `σ` ≡ `ς` ≡ `Σ`; accent-sensitive (`é` is not `e`); no Turkish rule (`İ` folds to `i` plus U+0307); folding is not re-normalized; default-ignorable characters are not ignored.

SQL forms: equality `casefold(col COLLATE pg_unicode_fast) = $1` with the literal folded in TypeScript; pattern operators use `LIKE $1` with a TypeScript-built pattern (fold, escape `\`, `%`, `_`, add `%`). Folded equality and uniqueness use an expression index on the casefold expression [spike: `casefold` is IMMUTABLE]. Unique text fields are unique by key [judgment]. A Postgres upgrade with new Unicode data can change folds for newly assigned code points, so the upgrade procedure regenerates the table and reindexes folded indexes, and `doctor` compares the fold table's version with `unicode_version()` [judgment].

### 5.6 Numbers

- Integer (`int4`) is a JS `number`; big integer (`int8`) is a `bigint`.
- Decimal is `{ coefficient: bigint; scale: number }` in STD's values package; comparison rescales and compares bigints. A decimal library is chosen when arithmetic arrives and is tested against Postgres `numeric`. [judgment]
- SQL literals are bound as text with casts (`$1::numeric`). STD's SQL layer reads `numeric`, `int8`, `date` and `timestamptz` as text and parses them itself, through the driver's `types` registry option [checked in the @effect/sql-pg 4.0.5 source] [spike: confirm the text-format reads in the 0A driver smoke test]. Reason: driver conversions can lose precision or shift dates. [judgment]
- Literals must fit the type's range. Decimal literals have at most 100 digits [judgment]. NaN and infinities do not exist in STD.

### 5.7 Dates, date-times and time zones

- **Date**: `YYYY-MM-DD`, years 0001 to 9999, proleptic Gregorian; kept as the canonical string, whose order equals date order.
- **Date-time**: UTC instant with millisecond precision, `timestamptz(3)`. Sessions run with `TimeZone=UTC`, `DateStyle=ISO` [spike: set through the driver's session parameters, confirmed in the 0A smoke test]. Kept as epoch milliseconds.
- A date never compares directly with a date-time.
- The evaluation context carries `now`, `timeZone` (IANA) and `weekStart` (default Monday). Resolution in TypeScript turns `ctx` and `rel` into literals and `inPeriod` into `ge(f, start) and lt(f, end)`; day and larger offsets are calendar arithmetic in `timeZone`, minute and hour offsets exact durations. The resolver uses Temporal, enabled by default in Node 26 [checked: Node 26 release notes]; the web app uses a pinned polyfill where missing [unverified per browser].
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

- `IS [NOT] DISTINCT FROM` is null-safe [checked: [comparison functions](https://www.postgresql.org/docs/18/functions-comparison.html)] and used only field-to-field; literal comparisons use `=` to stay indexable [spike].
- Paths compile to one `LEFT JOIN` per distinct reference prefix, so a null reference yields null, as in TypeScript. Paths may name fields of the declared target class and its ancestors only.
- The compiler accepts a guard per joined path, which authorization uses to apply target visibility and masks (3.6).
- Every value is a bound parameter; identifiers come only from definitions.

### 5.10 Profiles

|  | Filter | Access rule | Form rule | Record rule | Subscription |
| --- | --- | --- | --- | --- | --- |
| Used for | lists, API `filter`, picker limits | allow and deny conditions | conditional required, read-only, hidden | before and after conditions | which changes create deliveries |
| Operators | all but `changed` | all but `changed` | all | all | all but `changed` |
| `previous` | no | no | yes | yes (all-null on create) | no |
| Context | me, now, myGroups (Step 3) | me, now, myGroups (Step 3) | me, now | me, now | now only |
| Time zone | user's | instance | instance | instance | instance |
| Path hops | 1 | 0 in Step 1, 1 from Step 3 | preloaded paths only | up to 3, preloaded as system | 0 |
| Fields | caller's readable fields on every hop (3.4) | all, as system | caller's masked image: unreadable fields count as empty | all, as system | all, as system |
| Evaluated in | SQL (authoritative), server TS allowed | SQL, for reads and for both write checks (3.9); server TS only for explain mode and tests | browser (advisory), server (binding) | server TS | server TS |

- The same access-rule condition is checked against both existing and proposed states (3.9), in SQL in both cases. TypeScript evaluation of access-rule conditions is used only by explain mode and by tests; the differential test holds it to the SQL.
- Form rules evaluate the proposed image with `previous` for the stored one. They are evaluated for a caller over the masked image: fields the caller cannot read on the record count as empty, as in 3.5, in the browser, in form-state and at save. Before sending a rule to the browser, the server substitutes empty for fields never readable by the caller and simplifies, so a sent rule names no hidden field. So form-rule outcomes reveal nothing about hidden values [judgment]. Form rules are UX constraints; security belongs in access rules.
- On create `changed(f)` equals `notEmpty(f)`; on delete `changed` is false. `myGroups` may appear only as `in(f, myGroups)`.

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
- `retired-condition` (Step 1): retire `status` while rule 6 reads it; `purchased_on` on Bob's lost asset S stays hidden from him, and purge of `status` is refused.
- A form rule comparing a writable field with a field the caller cannot read gives the same outcome in form-state and at save whatever the hidden value.

## 6. Interfaces, field types and JSON

### 6.1 Three interfaces

| Interface | Consumers | Contract | Types come from |
| --- | --- | --- | --- |
| Generic admin UI | list and form pages, filter builder | runtime metadata (6.3) and runtime validation | metadata fetched at run time |
| Fixed platform endpoints | web app, CLI, SDK | one Effect `HttpApi` definition in a shared package; clients use `HttpApiClient.make` on it; OpenAPI 3.1 generated from it | compile time |
| Application SDK | app code for known tables | types generated from a versioned schema snapshot (6.8) | generated code in the app's repo |

- `HttpApiClient.make` exists in Effect v4 [checked: [v4 API docs](https://effect.website/docs/v4/api)]; import paths follow the vendored source. It is tagged unstable, so the shared API-definition package and the web app allow `effect/http-api` and `effect/http` (9).
- Fixed endpoints: sign-in, metadata, snapshot, form-state, schema-change operations. Generic record routes (`/api/v1/tables/{table}/records`) have a fixed envelope (6.6); `values` are typed only at run time.
- Decision: table types are static only in generated SDK code. Reason: a deployed browser cannot gain compile-time types for a table created at run time.

### 6.2 Schema revision on the wire

- Every response, errors included, carries `STD-Schema-Revision: <n>.<change_set_id>`; record and list bodies carry `schemaRevision` as the number. Reason: after a restore the same number can be reached through different changes.
- Requests may send `STD-Schema-Revision`, the revision their form, query or SDK was built at. The web app and SDK always send it; plain API clients may omit it and get no stale detection [judgment].
- Role membership changes are not revisions; access-rule changes are, but are not a relevant change kind (6.4).

### 6.3 Metadata and validation

`GET /api/v1/meta/tables/{table}` returns the effective metadata for the acting user, generated from effective definitions (8.2) at the current revision and filtered by access, cached per (revision, change_set_id, effective role set) [judgment].

- Contains: class ID, name, label, ancestors, whether creatable, display field; per field: ID, name, label, type, inherited-from, required, read-only, nullable, static default, type settings, choices (key, label, order, retired), `read` and `write` as `yes`, `no` or `perRecord`; form rules, with never-readable fields substituted as empty (5.10); `schemaRevision`.
- Never contains: never-readable fields, access-rule or record-rule conditions, computed default expressions, secret values.
- One builder, `recordSchema(metadata, mode)` (`create`, `update`, `read`), in a plain package using Effect Schema. The server runs it on full definitions, the browser on filtered metadata, so verdicts agree for every field both see.
- Server-only checks: uniqueness, reference existence and visibility, access and record rules, form rules the browser could not evaluate, stale revision and version.
- `POST /api/v1/tables/{table}/form-state` returns per-field required, read-only and hidden outcomes for proposed values. Outcomes are computed over the caller's masked image (5.10), so they reveal nothing about fields the caller cannot read.

### 6.4 Stale requests

Request revision R (number and change set ID), current revision C:

- A malformed header gets `400 InvalidSchemaRevision`.
- If R's number is above C's, or R's change set ID differs from the journal's change set at that number, the response is `409 SchemaChanged` with kind `unknown` for every field in scope. Reason: after a restore the client's revision does not describe this database; it reloads.
- Names in the request are resolved against the definitions at R (4.4). So a form built before `foo` was renamed to `bar` and a new `foo` was created still means the old field.
- R < C: the server reads journal entries in (R, C] touching the request's scope: the class and its ancestors; for writes, every field in the payload plus, on create, fields that became required without a default; for reads, every field in filter, sort, selection and labels. An entry is also relevant if its old or new name equals any field name in the request (1.5).
- Relevant kinds: `fieldAdded` (required without default, creates only), `fieldRenamed`, `fieldRetired`, `fieldPurged`, `typeChanged`, `settingsChanged`, `choicesChanged`, `requiredChanged`, `readOnlyChanged`, `tableRetired`. Labels, layouts, display field, new optional fields, access rules and other classes are not relevant, except a new field that takes a name used in the request.
- Any relevant change returns `409 SchemaChanged` with `requestRevision`, `currentRevision` and `changes` (`table`, `field`, `fieldId`, `kind`, `revision`). `changes` lists only fields the caller can name at C; a request name that resolves to no such field gets `UnknownField`, as in 3.4. It is checked before validation, access and version checks.
- The UI reloads metadata, keeps valid values, marks changed fields and asks the user to resubmit; it never resubmits automatically [judgment]. A newer revision on any response, or `NotAllowed`, triggers a background metadata refresh.
- If the journal no longer reaches R, every field in scope counts as changed with kind `unknown`.

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
| choice | `text`, no database CHECK | key | an active key; an unchanged retired key is kept | `string` | null |
| reference | `uuid`, FK `ON DELETE NO ACTION` (3.10) | lowercase UUID | UUID, any case, hyphenated | branded `string` | null |
| uuid | `uuid` | lowercase UUID | as reference | branded `string` | null |
| password | `text`, one-way hash | `{"set": bool}` | plaintext, hashed by the service | not readable | `{"set": false}` |
| secret | `bytea`, encrypted envelope, key outside the database | `{"set": bool}` | plaintext; `null` clears | not readable | `{"set": false}` |
| json | `jsonb` | any JSON value, keys in jsonb's order | finite numbers exactly representable as a double, integers within ±(2^53 - 1), no duplicate keys, at most 1 MB [judgment]; `null` is SQL NULL | `unknown` | null |
| condition | `jsonb` | AST (5.2) | AST checked against the field's profile and class | `Expr` | null |

- Big integer and decimal are strings because common JSON parsers lose precision; JSON numbers are refused, not converted [judgment].
- Json: duplicate keys and numbers not exactly representable as a double are refused, because `jsonb` keeps the last duplicate and keeps digits that `JSON.parse` rounds. The canonical output is jsonb's key order. Both engines compare json values by jsonb equality. [judgment]
- Choice keys: 1 to 63 characters of `[a-z0-9_]`, starting with a letter or digit; validated by the record service so lists change without DDL [judgment].
- Adding a boolean field relies on `ADD COLUMN ... NOT NULL DEFAULT false` being catalog-only with no verification scan [spike: `relfilenode` unchanged, under 100 ms on 1M rows, `seq_scan` unchanged].
- System date-times come from one clock reading per transaction, already in whole milliseconds.
- Password and secret conditions may use only `empty` and `notEmpty`, server-side.
- History stores canonical JSON with the schema revision (4.2).
- Deliberately later: duration, time of day, currency, multi-choice, multi-reference, attachment, comment log, rich text, email, URL and phone formats.

### 6.6 Record JSON

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
- `labels` only on request; absent when not permitted (3.6), never a placeholder.
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

### 6.8 Application SDK (Step 4)

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
- SDK golden test (Step 4): identical output for the same snapshot; `SchemaChanged` surfaces as a typed error.

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
- By display value or another declared lookup field: exact match under the type's equality among records the importing user may read that meet the field's allowed-records condition. The lookup compares against the masked expression of the lookup field (3.5), so a hidden value behaves like empty. None: `ReferenceNotFound`; several: `ReferenceAmbiguous` with the count of readable candidates. The import never picks one.
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
- Batches are contiguous row ranges, default 500 [judgment], tuned in Step 4 so each commits in under 2 s, since a batch holds its record locks until commit.
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
- COPY is added in Step 4 only if the measurement requires it, as a loading optimization (staging tables, flushed groups). It never changes hooks, validation, access checks, change entries, deliveries or outcomes. Rows with a matching hook never use it. The equivalence test also runs on the COPY path.

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
| `core.config_conflict` | upgrade conflicts and resolutions | opened by `std upgrade`, resolved by admins |
| definition tables | the effective record | config service only, in the same transaction |
| `core.definition_revision` | effective record per revision (4.4) | config service only, in the same transaction |

- The runtime reads only effective records, so layering stays inside the config service. [judgment]
- Admin edits to shipped records are stored as overrides; removing one restores the shipped value.
- Overridable properties [judgment]: field label, help text, default, and tightening of required, read-only and max length (never name or type); table label and display field; choice label, order, hidden (shipped choices cannot be deleted); a layout's element list as one property; role label; rule and access rule `active` only (protected access rules cannot be disabled); protected records label and help text only.

### 8.3 Applying sets

1. Parse and validate every file; any failure applies nothing.
2. Resolve names to IDs.
3. Build the dependency graph (1.7 kinds). An `extends` cycle is refused; reference cycles are handled by phases.
4. Apply in phases: namespaces and tables with non-reference fields (parents first); reference fields and FKs; indexes; roles and their permission grants; choices, layouts, rules, access rules, subscriptions.
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
| Removed upstream | tables and fields retired (never purged), choices hidden, rules deactivated, roles retired; local dependents reported; a role that an active local access rule names is refused at plan time (`rule_role`); admin may purge or `adopt` |
| Type changed | refused in v0.1; author adds a field and retires the old one |
| Tightened constraint violated by data | refused at plan time with counts |

- Conflicts resolve as `keep_local` (sets `base_when_set` to the new shipped value), `take_shipped` (drops the override) or `replace`. Open conflicts do not block the system.
- The report lists every access-rule, role and permission-grant change in a "security changes" section.
- Sets carry no data transformations in v0.1; core data changes go into platform migrations. Downgrades are refused; rerunning an upgrade changes nothing.

### 8.5 `std upgrade`

- Offline in v0.1: stop servers, run `std upgrade`, start servers. It refuses to run while any session with `application_name = 'std-server'` is connected, and when the database encoding is not UTF8 (5.5). Reason: rolling upgrades need expand-and-contract rules, which come with high availability.
- Order: take `SCHEMA_KEY`; compare versions; run platform migrations; resume interrupted change sets; load core; load app sets; write the report.
- `--plan` (and `--json`) changes nothing and prints migrations, per-set diffs, conflicts, refusals and security changes. The real run applies that plan and stops if the database changed since.
- After a failure, rerunning continues from the last committed migration or change set.

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
- `std upgrade` refuses to run while a `std-server` session is connected, and on a non-UTF8 database.
- Release upgrade (Step 4): from the previous pre-release with helpdesk, 10,000 records with history and customizations (local field on a shipped table, overrides, a local class extending a shipped one, a local access rule, a local role), the candidate upgrade leaves `doctor` exiting 0, content checksums unchanged except for documented migrations, customizations effective, expected conflicts only.
- Backup and restore (Step 4): `pg_dump -Fc` under load during a follow-up phase, restored into an empty Postgres 18, then `std upgrade`: the change set completes, `doctor` exits 0, checksums match the snapshot, auto-numbers continue, sign-in works, a new change set succeeds.
- Restore then upgrade (Step 4): a previous pre-release backup reaches the same state as the release upgrade test.
- CI runs every runbook command against these scenarios.

## 9. Effect toolchain

- **Versions.** `effect` and the 4.x `@effect/*` runtime packages share one version and release in lockstep [checked: [Effect 4.0](https://effect.website/blog/releases/effect/40)]. STD pins them to one exact version (4.0.5 today) through a pnpm catalog, because `@effect/sql-pg` declares its peer as the range `effect: ^4.0.5`. `@effect/tsgo` has its own version line (0.54.1), releases several times a week, and is pinned exactly and upgraded in its own PR. `typescript` is pinned to a version in `@effect/tsgo`'s supported table (7.0.2).
- **Never installed:** `@effect/sql` and `@effect/platform`. They are Effect 3-era 0.x packages that still carry npm's `latest` tag; in v4 they live inside `effect` as `effect/sql` and `effect/http`.
- **Stability.** APIs tagged `@stability unstable` or `experimental` may change in minor or patch releases; since 4.0.2 every module declares its stability [checked: [Effect 4.0: The First Week](https://effect.website/blog/effect-4-first-week)]. In 4.0.5, all of `effect/sql`, `effect/http`, `effect/http-api`, `effect/rpc`, `effect/workflow`, `effect/cluster`, `effect/observability` and every module of `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` and `@effect/vitest` are unstable; `Effect`, `Layer`, `Schema`, `Stream` and most root modules are stable [checked: [effect-4.0.5.tgz](https://registry.npmjs.org/effect/-/effect-4.0.5.tgz)]. This includes `src/http-api/HttpApiClient.ts` and `src/http/HttpClient.ts` [checked: same tarball].
- **Diagnostics.** `@effect/tsgo` is the TypeScript 7 binary for editor and CI; TS 7.0 has no programmatic API, so tsserver plugins do not run on it [checked: [TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [Effect-TS/tsgo](https://github.com/Effect-TS/tsgo)]. Setup: the tsconfig plugin entry is named `@effect/language-service`, and `"prepare": "effect-tsgo patch"` makes plain `tsc` report Effect diagnostics. The shared tsconfig base sets `diagnosticSeverity` to error for `unstableApiUsage`, `experimentalApiUsage`, `outdatedApi`, `obsoleteSchemaImport`, `duplicatePackage` and `floatingEffect`, and keeps `ignoreEffectWarningsInTscExitCode: false`, so CI fails in the normal `tsc -b` step.
- **Patch and pnpm.** pnpm hard-links package files from its global store, so a patch that rewrites files in place could change the store copy used by other projects [unverified]. 0A confirms that `effect-tsgo patch` replaces files rather than writing through hard links, or sets `package-import-method=copy` for the `typescript` package.
- **Allow lists**, kept in each package's own tsconfig [spike: exact entry strings, confirmed in the 0A smoke test]:
  - Plain packages (definitions, values, conditions, access-rule evaluation): empty.
  - Shared API-definition package and web app: `allowedUnstableApis = ["effect/http-api", "effect/http"]`. Reason: the shared `HttpApi` definition and `HttpApiClient.make` live in these unstable modules.
  - Server package: `allowedUnstableApis = ["effect/sql", "effect/http", "effect/http-api", "effect/observability", "@effect/sql-pg", "@effect/platform-node", "@effect/opentelemetry"]`.
  - Tests: an `overrides` entry adding `@effect/vitest`, repeating the server entries because overrides replace the base list.
  - `allowedExperimentalApis` is empty everywhere. Unstable Schema exports are allowed one export at a time, only if needed.
  - Each entry has a one-line reason in the Effect decision note. Every Effect upgrade PR checks the API reference for changes in allowed modules and removes entries for modules promoted to stable.
- **"Effect Schema only" in plain packages.** Stability diagnostics flag only unstable imports, so a plain package importing stable `Effect`, `Layer` or `Stream` would pass them. A CI import restriction allows plain packages to import only the Schema module and what it needs from `effect`.
- **Later:** turn on `apiStabilityLeak` for STD's published packages once they tag their exports [unverified: that it follows tags into Effect's packages].
- **Agent material.** AGENTS.md carries a short idiom guide pointing at the diagnostics above and at `AGENTS.md` and `ai-docs/` shipped in the `effect` package. Effect's source is vendored with `git subtree` at the `effect@<version>` tag matching the lockfile, not `main`.
- **Measurement log.** Each Effect upgrade PR records engineer-hours and breakages per allowed module; defects record whether Effect was the root cause and which workstream they belong to; agent PRs record Effect-related rework. The plan's thresholds are reviewed at every stage gate.

### Acceptance tests

- A canary import of `effect/sql` in a plain package fails `tsc -b`; the same import in the server package passes.
- A canary import of `Effect` into a plain package fails the CI import check.
- The web app and the shared API-definition package type-check with `HttpApiClient.make`; an import of `effect/sql` in the web app fails.
- A second copy of `effect` in the lockfile fails CI (`duplicatePackage` plus a lockfile check).
- An Effect 3-era API in any package fails CI (`outdatedApi`).
- The vendored Effect source tag equals the lockfile version (CI check).

## Open questions for Martin

1. **Global pause on config commits.** Every config commit, including a label edit, briefly pauses all requests through the exclusive `CONFIG_KEY`. Per attempt the pause is bounded by the `CONFIG_KEY` wait (200 ms) plus the DDL lock wait (2 s) plus the main transaction's time. Default: accept for v0.1 and measure the pause in Stage 0; per-table locking only if measured pauses are a problem.
2. **Offline upgrades.** Default: v0.1 upgrades run with servers stopped. The alternative, rolling upgrades now, needs expand-and-contract rules for every migration and definition change.
3. **Case-insensitive text by default.** Default: yes, Unicode full case folding, accent-sensitive, with a per-field `caseSensitive` opt-out.
4. **One access-rule condition for both states.** Default: one condition is checked against the existing and the proposed record, for record and field rules alike, so handing a record to someone else needs a broader rule. The alternative is a separate proposed-state condition, like RLS `WITH CHECK`.
5. **Dead-letter default.** Default: `block`, which keeps per-record order unconditional but holds one record's later deliveries for that subscription until an operator acts. The alternative is `skip`.
6. **Benchmark gate.** Default: the budgets in 2.6 (Q5 at most 5 ms, list queries at most 50 ms, Q2 at most 250 ms, writes at most 20 ms, p95 at 10M records on 8 vCPU, 32 GB, NVMe) and the 2x rule against one table per hierarchy decide whether class-table storage is kept.
