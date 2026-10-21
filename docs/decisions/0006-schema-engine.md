# 0006. Schema engine core: definitions, catalog, change sets, class-table DDL

Status: accepted, 2026-10-21 (workstreams 0B storage side and 1A core). Code: `packages/definitions`, `packages/server/src/{catalog,schema,config}`, `packages/server/src/platform/migrations/0002-definitions.ts`, `packages/server/definitions/core`, `examples/acme`.

## Modules

| Module | What it provides |
| --- | --- |
| `@std/definitions/ids` | definition IDs, `compareIds`, generated names `std_<kind>_<32 hex>` and their parser |
| `@std/definitions/names` | identifier rules (lowercase snake case, 63 bytes), reserved field names (`id`, `class`, `class_id`, `version`, audit columns), `pg_`/`std_` prefixes, qualified names |
| `@std/definitions/definition` | the ten definition kinds as Schemas: definition (stored) and draft (what a create supplies); owner layer, lifecycle state, enforcement, storage |
| `@std/definitions/condition` | the JSON-compatible condition AST schema, `conditionPaths`, `conditionFieldIds` |
| `@std/definitions/condition-view` | `classViewOf(snapshot)` for `@std/conditions`, `conditionProblems` (store-time check under the access-rule and subscription profiles) |
| `@std/definitions/snapshot` | `ConfigSnapshot`: lookups by ID and qualified name, ancestors, lineage, `subtree`, fields per hierarchy, overrides, indexes |
| `@std/definitions/effective-schema` | the effective schema of a class with stacked tighten-only overrides |
| `@std/definitions/validate` | `validateSnapshot`: names, uniqueness scopes, references, `extends` cycles, types and constant defaults, overrides, indexes, grants, access rules, subscriptions |
| `@std/definitions/problems` | `DefinitionProblem` and the `DefinitionInvalid` error |
| `@std/definitions/effective-json` | the effective JSON of a definition (for `core.definition_revision`) |
| `@std/definitions/dependencies` | dependency edges of a definition (1.7 kinds that exist now; an access rule has `access_rule_on` edges to its class and to every field it targets by ID) |
| `@std/definitions/operation` | the change-set operation model and the updatable properties per kind |
| `@std/definitions/apply` | `applyOperations`: in-memory application with version checks and validation |
| `@std/definitions/set-file`, `set-resolve`, `set-plan` | the set file format, name resolution, and phase-ordered planning against the installed definitions |
| `@std/definitions/well-known` | IDs code relies on (platform classes, `core.user`, the system user, built-in roles and permissions) |
| `server/catalog/definition-tables` | one `(property, column, codec)` list per kind, used to read and to write definition rows |
| `server/catalog/load` | `loadSnapshot` in the caller's transaction |
| `server/catalog/catalog` | the `Catalog` service: an `effect/Cache` keyed by `(revision, change_set_id)` (capacity 4, successes kept, failures not, lookup services from the caller's transaction), one load at a time, `refresh`, `latest` (the snapshot of the database state the last refresh observed, which follows a restore to an earlier revision), `followSignals`; `Catalog.layer` and `Catalog.listening` |
| `server/schema/ddl-forms` | the DDL forms of Contracts 1.4, `checkDdl`, lock modes and per-statement lock inventories |
| `server/schema/ddl` | class-table DDL builders, each statement with its lock inventory |
| `server/schema/plan` | `planChangeSet`: DDL, follow-up steps, enforcement states, preflight checks, platform tables to verify, lock inventory; `requiresSchemaKey` |
| `server/schema/change-set` | `applyChangeSet`: the 1.4 recipe with the per-attempt lock budget |
| `server/schema/coordinator` | `SCHEMA_KEY` on a dedicated connection, `SchemaBusy`, follow-up steps and `complete` |
| `server/schema/steps` | step kinds with probe, action and abandon action |
| `server/schema/writes` | definition rows, enforcement, definition revisions, dependency index, journal |
| `server/schema/platform-tables` | verification of platform tables against their descriptions; the system user row |
| `server/schema/{schema-busy,existing-data-violates,ddl-refused,platform-table-mismatch}` | the engine's errors |
| `server/config/set-files`, `load-set`, `upgrade` | reading YAML sets, loading a set as one change set, `std upgrade [--set <dir>]...` |

## Table layouts (migration 0002)

Definition and journal tables are laid out like root classes: `id`, `class_id`, `version`, `created_at`, `created_by`, `updated_at`, `updated_by`, `PRIMARY KEY (id)`, `UNIQUE (id, class_id)`, the subtree CHECK holding the table's platform class ID, and the class-change trigger. Definition tables add `owner_layer`, `owner_set_id` (set for `app` only), `state`, `protected`; classes, fields, overrides and indexes add `enforcement` and `enforcement_note`.

| Table | Own columns |
| --- | --- |
| `core.namespace` | `name`, `label`, `help_text`, `storage`, `extensible`; unique live `name` |
| `core.class` | `namespace_id`, `name`, `label`, `help_text`, `parent_id`, `display_field_id`, `storage`, `extensible`; unique live `(namespace_id, name)` |
| `core.field` | `table_id`, `name`, `label`, `help_text`, `type` (jsonb, the `@std/values` field type), `required`, `read_only`, `default_value` (jsonb, canonical JSON); unique live `(table_id, name)` |
| `core.field_override` | `table_id`, `field_id`, `label`, `help_text`, `required` and `read_only` (jsonb `true`/`false`/null: tri-state, null means not overridden), `max_length`, `min_value`, `max_value`, `default_value` |
| `core.index` | `table_id`, `field_ids` (jsonb), `is_unique` |
| `core.role`, `core.permission` | `name`, `label`, `help_text`; unique live `name` |
| `core.role_permission` | `role_id`, `permission_id` |
| `core.access_rule` | `description`, `effect`, `role_ids` (jsonb), `table_id` (null for `*`), `target` (`records`/`fields`), `fields` (jsonb `"*"` or IDs), `actions` (jsonb), `condition` (jsonb), `active` |
| `core.subscription` | `name`, `table_id`, `operations`, `condition`, `identity_id`, `max_attempts`, `dead_letter`, `enabled` |
| `core.schema_change` | `requester_id`, `source`, `operations`, `state`, `first_revision`, `last_revision`, `error`, `coordinator_pid`, `committed_at`, `completed_at` |
| `core.schema_change_step` | `change_id`, `ordinal`, `kind`, `target_id`, `sql`, `details`, `state`, `attempts`, `last_error`, `backend_pid`, `started_at`, `finished_at` |
| `core.config_dependency` | `(from_id, to_id, kind)`, primary key `(from_id, kind, to_id)`, index on `to_id` |
| `core.definition_revision` | `(definition_id, revision, kind, effective)`, primary key `(definition_id, revision)` |

Every FK between platform tables is `NO ACTION` and `DEFERRABLE INITIALLY DEFERRED`, so a change set writes rows in any order (a class names its display field, the field names its class).

**Audit columns of platform tables** carry user IDs without an FK: the tables exist before `core.user`, and the loader never changes platform tables. Set loads write the system user's fixed ID (`SYSTEM_USER_ID`); the change set that creates `core.user` inserts that user (inactive, login `system`) right after its `CREATE TABLE`, before the FKs. `doctor` (1B) checks that every audit ID on a platform table exists in `core.user`. Record tables get `created_by`/`updated_by` FKs to `core.user` (`std_cb_`, `std_ub_`).

The core set describes the twelve platform tables with `storage: platform`; the main transaction verifies each described table (every column described, `format_type` and nullability equal) and fails with `PlatformTableMismatch` otherwise. Tables without `id` stay internal.

## Class tables (Contracts 2.1)

Root: `id`, `class_id`, `version`, audit columns `timestamptz(3)`, then field columns; level tables: `id`, `class_id`, field columns. Constraints: `std_pk_<class>`, `std_uq_<class>` `(id, class_id)`, `std_sc_<class>` subtree CHECK, `std_lv_<class>` level FK `ON DELETE CASCADE` (the only cascade), `std_tg_<class>` trigger, `std_nn_<field>` named NOT NULL (required fields and booleans), `std_ck_<field>` max length, `std_fk_<field>` reference FK, `std_ix_<index>`. Case-insensitive text indexes use `casefold(col COLLATE pg_unicode_fast)`. The committed SQL snapshot of the core and acme sets: `packages/server/test/__snapshots__/ddl-forms.sql`.

## Operation model

Operations (`@std/definitions/operation`): `createNamespace`, `createClass`, `addField`, `addIndex`, `createRole`, `createPermission`, `createGrant`, `createAccessRule`, `createSubscription` (each with a draft carrying the new ID), `setOverride` (`version` null to add, the stored version to replace), and `update` (`id`, `version`, changed properties). `UPDATABLE` lists what an update may change per kind; names, types, parents, reference targets and index fields cannot change here (renames, retire and purge are 1A; type changes are refused in v0.1). Making a field required is a tightening (preflight count, `std_nn ... NOT VALID`, `validate_constraint`); making it optional is refused. A stored version that differs is `versionConflict`. An operation whose result has the same effective JSON is dropped, so an unchanged set plans and applies nothing.

The journal records per operation `{op, kind, targetId, oldName, newName, version}`, plus requester and source (`{kind: "api"}` or `{kind: "set", setId, name, version}`). `core.schema_change` is the change set's audit record until history (1E) covers config records.

## Change sets

`applyChangeSet`: load and apply in memory (`DefinitionInvalid` before any lock); nothing changed returns `unchanged`. Change sets without DDL or data preflight run the main transaction on the pool under `CONFIG_KEY` only. Otherwise the coordinator opens a dedicated connection (`std-coordinator`), takes `SCHEMA_KEY` with `pg_try_advisory_lock` (`SchemaBusy`: holder PIDs, the applying change set, `retryAfterSeconds` 5), checks which existing tables hold rows (`SELECT EXISTS (SELECT 1 FROM t)` with `enable_seqscan = off`: an index-only scan of the primary key, never a sequential scan), counts violating rows (`ExistingDataViolates` with up to 20 sample IDs), and checks every planned statement against the DDL forms (`DdlRefused`), all before `CONFIG_KEY`. The main transaction re-reads the snapshot at the locked revision, re-applies and re-plans, verifies platform tables, takes the lock inventory, runs the DDL, inserts the system user when needed, writes definitions, enforcement notes, definition revisions at revision R+1, dependency rows and the journal, and calls `bumpRevision`. Then the follow-up steps run and `complete` takes revision R+2.

**Per-attempt lock budget.** (Mirrors Contracts 1.4 step 2.) Postgres applies `lock_timeout` to each lock acquisition, also within one statement, so a fixed 2 s let one attempt hold `CONFIG_KEY` for several lock waits in turn (0F probe). Every DDL statement therefore carries its lock inventory (below). Before any DDL the main transaction takes the merged inventory (strongest mode per table, in first-needed order: ancestors root first, then altered tables, then FK targets) with explicit `LOCK TABLE ... IN <mode> MODE` statements wrapped in `lockWaiting`, each after `SET LOCAL lock_timeout = '<remaining of 2000 ms>ms'`. The DDL then runs with `lock_timeout` at the remainder (at least 1 ms), so a lock missing from an inventory fails fast as a retried lock timeout. There is no `statement_timeout` backstop: DDL is catalog work and can legitimately take long. What the budget does not cover: the DDL also locks indexes of the locked tables and system catalogs internally, Postgres cannot `LOCK TABLE` an index, and budgeting catalog locks is not practical. Only sessions that lock an index or a catalog directly (`ALTER INDEX`, `REINDEX`, amcheck, an explicit `LOCK` on a catalog, `VACUUM FULL` or `CLUSTER` of a catalog) contend these; each such wait is capped by `lock_timeout` at the remaining budget, which is set again immediately before each DDL statement, so the worst case per attempt is the budget × (1 + N), N being the number of those internal acquisitions that are contended. Measured: with the table held 1.7 s and `pg_attribute` held in SHARE mode, an `ADD COLUMN` attempt held `CONFIG_KEY` 2,026 ms and rolled back at its deadline, and the retry committed after 917 ms (`schema-locks.test.ts`). Also measured: locks released at 1.5 s and 3.3 s gave holds of 2007 ms (attempt 1, timed out) and 1266 ms (attempt 2, committed).

| Form | Inventory (relations other than those the statement creates) |
| --- | --- |
| `replaceSubtreeCheck`, `addColumn`, `addCheck`, `addNotNull`, `setDefault`, `dropDefault`, `createTrigger` | `ACCESS EXCLUSIVE` on the table |
| `createTable` of a child class | `SHARE ROW EXCLUSIVE` on the parent (level FK) |
| `addForeignKey` (reference and audit FKs) | `SHARE ROW EXCLUSIVE` on both tables |
| `createIndex` (plain, new or empty table) | `SHARE` on the table |
| `dropColumn` of a reference field, `dropConstraint` of an FK | `ACCESS EXCLUSIVE` on both tables (FK trigger removal) |
| `createSchema`, follow-up forms | none (follow-ups run outside the budget with `lock_timeout = 0`) |

`lock-inventory.test.ts` runs every generated form in its own committed transaction on a separate session, after taking the statement's inventory, and classifies each relation lock the statement adds like the 0F probe: system catalogs and relations the statement creates need no budget; a listed table must be held in a mode that covers the added one (it conflicts with everything the added mode conflicts with); an index or TOAST table of a listed table is an **unbudgeted** lock, allowed only in a mode the table's listed mode covers, because Postgres cannot `LOCK TABLE` an index; a new sequence (relkind `S`, from an identity column, which the forms refuse) and anything else fail the test. The unbudgeted locks seen are `ACCESS SHARE` on the referenced unique index (FK creation, `CREATE TABLE` with a level FK); they conflict only with `ACCESS EXCLUSIVE` on that index, which only STD's own `DROP INDEX CONCURRENTLY` takes, under `SCHEMA_KEY`. A deliberately understated inventory is detected.

**Preflight data checks** (under `SCHEMA_KEY`, before `CONFIG_KEY`): a required field without a column default (booleans default to `false`) on a table with rows; a field made required; a new or tightened override, over the subtree (for a field added in the same change set, against the new column's default, rechecked by `validate_override` after the commit); a unique index on a table with rows, counting rows whose key (the index's own expressions, casefolded for case-insensitive text) occurs more than once, a key with a NULL never counting; a column added in the same change set enters the key as its initial value (constant default, `false`, or NULL), so an all-NULL new column passes and one constant default on several rows is a duplicate.

**DDL guard lexing.** The guard refuses, before classifying, every lexical form the builders never emit: escape strings (`E'...'`), dollar quotes and any other `$`, Unicode escapes (`U&'...'`, `U&"..."` with `UESCAPE`) and comments. What remains is standard strings and quoted identifiers, which `maskQuoted` reads exactly; it masks their contents before the guard looks for keywords, so a default `'SET NOT NULL'` is data and a quote inside an exotic form can never hide a later `DEFAULT now()`. I chose this over reusing the SQL layer's `statement-lexer.ts`: that lexer reports only statement counts and leading tokens, so reuse would mean changing its exported API on the SQL-layer branch, and the guard only ever needs to accept the builders' own subset.

## Step model

`core.schema_change_step` rows are written in the main transaction, `complete` last. Kinds and their probe / action / abandon:

| Kind | Probe | Action | Abandon |
| --- | --- | --- | --- |
| `validate_constraint` | `pg_constraint.convalidated`: done, not started, missing = partial | `ALTER TABLE ... VALIDATE CONSTRAINT` | `dropConstraint` (both tables `ACCESS EXCLUSIVE` for an FK) |
| `validate_override` | an `outcome` in the step's details | count violating rows in the subtree; outcome `enforced` or `failed` | none (enforcement `failed` at `complete`) |
| `create_index_concurrently` | `pg_index.indisvalid`: valid = done, invalid = partial, missing = not started | drop an invalid leftover, then `CREATE [UNIQUE] INDEX CONCURRENTLY` | `DROP INDEX CONCURRENTLY IF EXISTS` |
| `drop_index_concurrently` | missing = done | `DROP INDEX CONCURRENTLY IF EXISTS` | none |
| `complete` | change set `completed` | config commit: enforcement from step outcomes, change set `completed`, `last_revision`, revision bump | (1A: abandon actions, then `complete`) |

Steps run on the coordinator's connection in autocommit with `lock_timeout = 0` and `statement_timeout = 0`, marked `running` (attempts, backend PID) and `done` (details merged). Only typed database failures are retried (`Effect.retryOrElse` with `Schedule.recurs(2)`); a step failing 3 times is `failed` and the change set `needs_attention`. Defects and interruption propagate. Resume, abandon and the watchdog (1A) build on the probes and abandon actions.

## Set file format

A set is a directory of `.yaml` files (YAML 1.2 core schema, unique keys, unknown keys refused). Exactly one file has `set: { id, name, layer: core|app, version, requires?, protected? }`; any file may hold `namespaces`, `tables` (with `fields`, `overrides`, `indexes`), `roles`, `permissions`, `grants`, `accessRules`, `subscriptions`. Every entry has its fixed `id`; references use names: qualified tables (`acme.asset`), field names on the table's lineage, role and permission names; field types are a kind name (`text`, `date`, ...), a `@std/values` type object, or `{ kind: reference, target: <table> }`; conditions are ASTs with field IDs. Labels default from names. Names resolve within the set and its required sets; a duplicate ID or one owned by another layer or set refuses the set. Planning compares with the installed definitions by ID and orders operations in the 8.3 phases (namespaces, tables and plain fields; reference fields; indexes and overrides; roles, permissions, grants; access rules and subscriptions), topologically within a phase, ties by ID. Files are sorted by path before resolution, so file order never matters.

## Verified facts ([spike] items)

- `ADD COLUMN ... boolean NOT NULL DEFAULT false` and `integer NOT NULL DEFAULT 1` on 1,000,000 rows: `relfilenode` unchanged, `seq_scan` unchanged, main transaction 3 ms (`change-sets.test.ts`).
- Adding a grandchild class to 2,000 populated records: both ancestors' subtree checks dropped and re-added `NOT VALID` in one `ALTER TABLE` each, root first, `convalidated` false, `seq_scan` unchanged; the 2.2 invariant tests hold for the new class (`inheritance.test.ts`).
- 2.2 invariants as table owner: a monitor row with a laptop's ID fails with 23503/23514, `class_id` outside the subtree 23514, a level row whose class differs from the root 23503, a level row without its parent rows 23503, `UPDATE` of `class_id` on any level `ST001`; deleting the root removes level rows.
- A concurrent index build waiting for an old snapshot keeps `SCHEMA_KEY`; a second DDL change set gets `SchemaBusy` naming the change set; a label change commits meanwhile (`schema-locks.test.ts`).
- 200 config-only change sets from 8 clients: revisions consecutive in `committed_at` order, one definition revision each.
- The listener reconnects after `pg_terminate_backend`, and the catalog reloads after a reset to an earlier state that reaches the same revision with other change set IDs.

## Consequences and deviations

- Contracts 3.3's rule table has twelve rules (1, 2a to 2c, 3 to 10); the acme set ships those twelve.
- `class_id` is a reserved field name as well (it is a physical column).
- Override `required`/`read_only` are jsonb tri-states in `core.field_override`, because STD booleans are never null and the platform table must be describable.
- Fields of a class are ordered by the set's topological order (ties by ID), not by file position; layouts (Step 2) define display order.
- Enforcement state and notes are operational: they do not bump a definition's version or produce definition revisions; `complete` still bumps the revision.
- `core.config_set`/`core.config_base` are not used yet; definitions removed from a set are left alone; changes that need upgrade rules (renames, type changes, retired definitions) refuse the set (1B).
- Protected definitions are flagged but not yet enforced against admin edits (1A), and the core namespace's reservation is not enforced.
- `std upgrade` loads each set as its own change set and does not yet hold `SCHEMA_KEY` across the whole upgrade (1B).
- Text fields without `maxLength` get the 255 code-point CHECK of `@std/values`; platform text columns have no CHECK, and verification compares types and nullability only.
- The catalog uses `effect/Cache` for its snapshots: a cache built once per catalog, keyed by the state's text form, and a permit around `Cache.get` inside the caller's transaction. Cache's built-in shared lookup is not relied on for serialization; the permit is, so a pending lookup never outlives its transaction.
- `makeCatalog` returns the catalog's functions; the static layers `Catalog.layer` and `Catalog.listening` wrap them with `Catalog.of` inside their generators.
- The engine needs nothing from the SQL layer beyond the round-2 allowlist: `CREATE`, `ALTER`, `LOCK`, `INSERT`, `UPDATE`, `DELETE`, `SELECT` and `SET LOCAL lock_timeout` inside transactions; `SET`/`RESET enable_seqscan`, `SET lock_timeout|statement_timeout` and concurrent index statements only in autocommit on the coordinator's connection.

## For the next workstreams

- **Access and record service (0C/1C):** read definitions only through `Catalog.current` inside a request transaction; `effectiveFields(snapshot, classId)` gives the 2.5 effective schema; table and column names via `tableName` and field names; constraint names map to definitions via `parseGeneratedName`; inserts must write the root row first and the level rows in order; `SYSTEM_USER_ID` exists for bootstrap. Access rules are definitions with role IDs and checked conditions; `classViewOf(snapshot)` feeds `@std/conditions`.
- **1A lifecycle:** add operations (rename, retire, purge, reactivate) to `UPDATABLE` and the planner; `dropColumn`/`dropConstraint` builders with inventories exist; resume/abandon use `readSteps`, `STEP_SPECS` probes and abandon actions and `runFollowUps`; dependency rows exist for every kind listed; protected checks belong in `applyOperations` (which knows the source via the change set's `source`).
- **1B config layers:** `planSet` is the place to diff base and overrides; the journal's `source` names the set; `runUpgrade` is the `std upgrade` entry point.
