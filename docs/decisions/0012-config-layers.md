# 0012. Config layers, upgrades and `doctor`

Status: accepted, 2026-10-21 (workstream 1B). Code: `packages/definitions/src/{layers,overridable,set-upgrade,upgrade-report}.ts`, `packages/server/src/config`, `packages/server/src/doctor`, `packages/server/src/platform/migrations/0005-config-layers.ts`, `packages/server/src/cli`, `examples/upgrade-fixture`. Runbook: `docs/runbooks/upgrade-and-recovery.md`.

## Modules

| Module | What it provides |
| --- | --- |
| `@std/definitions/layers` | the in-memory layer model: `InstalledSet`, `BaseRecord`, `LocalOverride`, `LayerState`, `applyOverrides`, `shippedOf`, `sameJson` |
| `@std/definitions/overridable` | `OVERRIDABLE` (the Contracts 8.2 list per kind), `PROTECTED_OVERRIDABLE` (label, help text), `overridableProperties`, `overrideProblem` (not overridable, or a loosening of `required`/`readOnly`), `isShipped` |
| `@std/definitions/set-upgrade` | `planSetUpgrade`: one set's 8.4 plan over the installed effective definitions and layer tables; `LayerWrites`; the `LifecycleOperations` seam |
| `@std/definitions/upgrade-report` | the JSON report shapes (`SetReport`, `Refusal`, `ConflictReport`, `ConvergedReport`, `KeptReport`, `RemovalReport`, `SecurityChange`, `DataViolation`) and `displayName` |
| `@std/definitions/operation`, `apply` | the new `adopt` operation; role and permission names are updatable (rules refer to them by ID) |
| `server/platform/migrations/0005-config-layers` | `core.config_set`, `core.config_base`, `core.config_override`, `core.config_conflict` |
| `server/config/layer-store` | reading the layer tables, `writeSetLayers` (set row, base rows, converged drops, conflicts, `converged` entries), `setHash`, `jsonHash` |
| `server/config/override-store` | override upserts and deletes, conflict closing, `adopt`'s base removal, `readConflicts` |
| `server/config/installed-state` | `readInstalledState`: snapshot and layer tables in one request transaction (one revision) |
| `server/config/load-set` | `planSetLoad`, `applySetLoad` (one change set: definitions, definition revisions and layer rows in one main transaction), `loadSet`, `loadSetDirectory`, `refusalError` |
| `server/config/data-preflight` | plan-time counts of rows a tightening would refuse |
| `server/config/upgrade` | `planUpgrade` (`--plan`), `runUpgrade`, `UpgradePlan`, `UpgradeReport` |
| `server/config/config-service` | `ConfigService` and its functions `editDefinition`, `removeOverride`, `resolveConflict`, `adopt` |
| `server/config/lifecycle` | the 1A seam: `SCHEMA_LIFECYCLE` (retire, rename, reactivate), `openChangeSets`, `resumeInterrupted` |
| `server/config/{set-refused,config-edit-refused,upgrade-plan-stale}`, `server/schema/config-state-changed` | the new errors |
| `server/doctor/*` | `runDoctor` and the 16 checks |
| `server/cli/{main,format}` | `std upgrade [--plan] [--json] [--expect <hash>] [--report <file>] [--set <dir>]...`, `std doctor [--json]` |

## Tables (migration 0005)

Laid out like root classes (`id`, `class_id`, `version`, audit columns, `std_pk_`, `std_uq_`, `std_sc_`, class-change trigger) and described in `definitions/core/platform.yaml`, so admins reach them through the generic API later. Foreign keys are `NO ACTION`, deferrable, initially deferred (Contracts 3.10, as in migration 0002).

| Table | Own columns | Keys |
| --- | --- | --- |
| `core.config_set` | `name`, `layer` (`core`/`app`), `set_version`, `hash`, `requires` (jsonb names) | unique `name` |
| `core.config_base` | `set_id` (FK set), `set_version` (the version that last shipped a change), `kind`, `shipped` (jsonb: the resolved draft), `hash` (SHA-256 of `shipped`), `removed` | `id` is the shipped record's ID |
| `core.config_override` | `record_id` (FK base), `property`, `value` (jsonb), `base_when_set` (jsonb), `set_by`, `set_at` | unique `(record_id, property)` |
| `core.config_conflict` | `record_id`, `property`, `set_id` (FK set), `set_version`, `change_set_id` (FK journal), `old_shipped`, `new_shipped`, `local_value`, `state` (`open`/`resolved`), `resolution` (`keep_local`/`take_shipped`/`replace`/`converged`), `resolved_value`, `resolved_by`, `resolved_at` | one open conflict per `(record_id, property)` |

A `converged` entry is a `core.config_conflict` row created resolved with resolution `converged`; when an open conflict on the same property converges, that row is closed as `converged` instead.

## Owner layers and the effective record

- Every definition has an owner (`core`, `app` with its set ID, `local`). Apply refuses any change of owner except `adopt`, which only the config service issues, only for an unprotected record whose base row is `removed`; it deletes the base row and the record's overrides.
- The definition tables hold the effective record; the runtime reads only them. For a shipped record, effective = `config_base.shipped` with `config_override` values applied, property by property. `doctor` check 8 recomputes it.
- An install from before 1B has definitions but no base rows. Its first `std upgrade` records the base (the shipped values are taken to be the effective ones, as no overrides existed) and changes no definition.

## Set loads and upgrades (Contracts 8.3, 8.4)

`planSetUpgrade` compares the set's drafts with the installed definitions by ID:

1. Downgrade (incoming version lower than `config_set.set_version`): refused; nothing else planned.
2. Drafts in the 8.3 phases, topologically within a phase, ties by ID:
   - new record: a local definition with the same name in the same scope (namespace; table in its namespace; field anywhere in the hierarchy, retired fields included; role; permission; subscription) refuses the set with `nameClash` naming the local definition; otherwise a create operation and a base row.
   - existing record: the target effective properties are the incoming shipped values with each override carried across: shipped unchanged keeps the override; incoming equals `base_when_set` keeps it (`kept`); incoming equals the local value drops it (`converged`); otherwise the local value stays and a conflict opens with old shipped, new shipped and local values. The target is diffed with the effective record: updatable properties become an `update`, a field type change is refused (`typeChanged`), a name change of a role or permission is an `update`, other renames go through `LifecycleOperations.rename`, any other property is refused (`unsupportedChange`). A base row is written when the shipped values changed.
3. Removed upstream, in reverse order (phases 5 to 1, dependents first): access rules are deactivated, subscriptions disabled, everything else goes through `LifecycleOperations.retire`; a role that an active access rule still names after the set (local rules included) refuses the set (`roleInUse`); local dependents are reported from the dependency edges; the base row is kept with `removed = true`.
4. The operations are applied in memory (`applyOperations`), so every validation problem is a plan-time refusal (`invalid`); on the server, the change set's data preflight is run read-only at plan time (`dataViolation`, with counts and up to 20 sample IDs).

Each set is one change set (`applySetLoad`): the main transaction checks that the configuration is still at the planned state (`expectedState`, else `ConfigStateChanged`), writes definitions, definition revisions, dependency rows and the journal as before, and then the layer rows (`ChangeSetRequest.extraWrites`). A set whose only change is in the layer tables (a conflict that keeps the effective value, a new set version with no other change) still commits and takes a revision; a set with no change at all plans nothing and records nothing.

The security section lists every created, updated, renamed, deactivated or removed access rule, role and permission grant, by set.

## `std upgrade` (Contracts 8.5)

1. `checkUpgradePreconditions`: UTF8, and no `std-server` session (`--plan` only reports the sessions as a warning).
2. A dedicated connection takes `SCHEMA_KEY` with `pg_try_advisory_lock` and holds it for the whole run. The schema engine uses that connection as coordinator for every change set of the run (`ChangeSetOptions.coordinator`) instead of taking the lock again.
3. The plan: ledger against code (unknown or changed migrations refuse), pending migrations, open change sets, then every set in order (core first, then app sets after the sets they `require`, ties in the given order, a `requires` cycle refused with `setCycle`), sets after the first planned against the earlier sets' in-memory results. The plan's `hash` is the SHA-256 of its canonical JSON without the warnings: basis (revision and change set ID), STD version, migrations, open change sets, every set report, refusals and security changes.
4. `--plan` stops here. The real run refuses on any refusal, and with `--expect <hash>` when the hash differs (`UpgradePlanStale`).
5. Platform migrations (on the same connection), resume of `applying` change sets, then each set: planned again against the database, compared with its plan (canonical JSON; a difference stops the run with `UpgradePlanStale` naming the set), applied as one change set.

Each migration and each set commits on its own, so after any failure the rerun continues: committed sets plan nothing. Tested with a lock held on a table the second set alters: the first set commits, the second fails with `SchemaLockTimeout`, the rerun applies only the second.

## Config service API (for the record service)

`ConfigService` (`@std/server/config/config-service`), built by `ConfigService.layer` over the schema engine's services (`Catalog`, `Transactions`, `DatabaseConfig`, `PgClient`, `SqlClient`):

| Function | Input | Effect |
| --- | --- | --- |
| `edit` | `{ id, version, changes, actorId }` | local definition: one `update` change set; shipped definition: refuses properties outside `overridableProperties` and loosenings (`ConfigEditRefused`, `notOverridable`), checks `version`, stores each changed property as an override with `base_when_set` = the shipped value (a value equal to the shipped one removes the override), updates the effective record |
| `removeOverride` | `{ id, property, actorId }` | restores the shipped value |
| `resolveConflict` | `{ conflictId, resolution, value?, actorId }` | `keep_local`: `base_when_set` becomes the new shipped value; `take_shipped`: drops the override; `replace`: a new local value |
| `adopt` | `{ id, actorId }` | owner becomes `local`; base row and overrides deleted |
| `conflicts` | record ID or null | conflicts and `converged` entries |

Every write is one change set whose main transaction writes the effective record, its definition revision and the override rows together, and checks the planned configuration state; a concurrent config commit makes it recompute (three times). Errors: `ChangeSetError` (`DefinitionInvalid` for unknown IDs and version conflicts) or `ConfigEditRefused` (`notOverridable`, `notRecorded`, `conflictNotFound`, `notAdoptable`). The record service routes admin writes of config records to `edit` with the record's ID, the version the client read and the changed properties.

## `doctor` API

`runDoctor(options?)` (`@std/server/doctor/doctor`) needs `Catalog`, `Transactions` and `SqlClient`, only reads, and returns `{ findings, exitCode }`; each `Finding` has `check` (1 to 16), `code`, `severity` (`error`, `warning`, `info`), `message` and `subject`. `exitCodeOf` gives 0 clean, 1 on any error, 2 for warnings only. Tests call it directly (`(yield* runDoctor()).exitCode === 0`).

| # | Codes (severity) |
| --- | --- |
| 1 | `migrationPending`, `migrationUnknown`, `migrationChanged` (error) |
| 2 | `tableMissing`, `columnMissing`, `columnType`, `columnNullability`, `columnDefault`, `keyMissing`, `auditUserMissing` (error) |
| 3 | `constraintMissing`, `constraintInvalid` (error); `enforcementExplains` (info) |
| 4 | `purgedPresent` (error) |
| 5 | `orphanTable`, `orphanColumn`, `orphanIndex`, `orphanConstraint` (warning) |
| 6 | `changeSetInterrupted`, `changeSetNeedsAttention` (error); `changeSetRunning` (info, while `SCHEMA_KEY` is held) |
| 7 | `revisionMismatch` (error) |
| 8 | `baseEdited`, `baseWithoutRecord`, `effectiveMismatch`, `overrideNotAllowed`, `recordWithoutBase` (error); `overrideViolated` (warning); `openConflict`, `layersNotRecorded` (info) |
| 9 | `dependencyDangling`, `dependencyExtra`, `dependencyMissing` (error) |
| 10 | `protectedNotShipped`, `protectedMismatch` (error); `coreSetPending` (warning) |
| 11 | `columnHeadroom` (warning, at 1,400 columns, dropped ones included) |
| 12 | `classIdNullable`, `fkAction`, `missingLevelRow` (error) |
| 13 | `notApplicable` (info until `core.external_identity` exists, Step 3; the hook is `checkExternalIdentities`) |
| 14 | `unicodeVersion` (error: the fold table's version, `@std/values/fold-table`, against `unicode_version()`, compared without trailing `.0`) |
| 15 | `encoding` (error), `clientConnectionCheckInterval` (warning) |
| 16 | `definitionRevisionMissing`, `definitionRevisionStale` (error) |

Open conflicts are informational, because open conflicts do not block the system (Contracts 8.4) and the Step 4 release test expects `doctor` to exit 0 with expected conflicts. Orphans are warnings: they are reported and never dropped. Orphan detection knows the internal platform tables by parsing `CREATE TABLE` statements of the platform migrations, so later migrations need no list.

## Verified facts

- Postgres 18 names the NOT NULL constraints of unnamed `NOT NULL` columns itself (`<table>_<column>_not_null`, `contype = 'n'`); check 5 ignores such constraints on system columns and reports only unknown `std_` names and other constraint kinds.
- An `ALTER DATABASE ... SET client_connection_check_interval` reaches only new sessions: `doctor` reads the setting of its own session, so it reports what new server sessions get (tested on a fresh pool).
- The Ultracite fixer rewrites the string literal `"UTF8"` to `"utf-8"` (`unicorn/text-encoding-identifier-case`); encoding checks therefore compare in SQL (`encoding = pg_char_to_encoding('UTF8')`), as the migration runner already did.
- A test seeding one drift per check confirmed every code in the table above except 6's `changeSetNeedsAttention`, 10's `coreSetPending` and 13, 14 (which cannot be provoked on a shared server; 14 has a unit test).

## Deviations and open items

- **Migration numbering.** 0003 (sessions, `ws/0c-reads`) and 0004 (history, `ws/0c-writes`) are not on this branch; `validateMigrations` takes a `reserved` list (`[3, 4]` in `platform/migrations.ts`) until both merge. Remove the list in the merge that adds them.
- **8.2 max length** is listed as overridable, but a field's max length lives in its type, and v0.1 never changes a type (`apply.ts` refuses it); so it is not overridable yet. Field overrides cover label, help text, default, required and read-only.
- **Removing a `required` override** (or `take_shipped` of one) is a loosening, which the schema engine refuses ("a required field cannot be made optional"). It is refused until the engine can drop the NOT NULL it added (1A, with retire's `DROP NOT NULL`).
- **1A seam.** `SCHEMA_LIFECYCLE` is empty: upgrades that rename tables or fields, reactivate retired definitions, or remove anything but access rules and subscriptions are refused at plan time with `renameUnsupported`, `reactivationUnsupported` or `removalUnsupported`. When 1A's API lands, `config/lifecycle.ts` maps `retire`, `rename` and `reactivate` to its operations (the planner already orders removals, reports local dependents, marks base rows removed and refuses roles in use), `resumeInterrupted` calls 1A's resume instead of `runFollowUps`, and the removed-upstream test adds a retired field with data and its `adopt`.
- **Protected checks.** 1A's schema-service check (label and help text only on protected definitions) and the config service use the same rule (`PROTECTED_OVERRIDABLE`); set loads of the core set change protected definitions as their set.
- `std upgrade --plan` runs with servers connected and warns, so the plan can be reviewed before stopping them; the real run still refuses.
- Admin edits that change only override rows (for example `keep_local`) still take a revision, like every config commit.
