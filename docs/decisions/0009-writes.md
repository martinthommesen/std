# 0009. Record writes: save pipeline, change entries, history

Status: phase 1 accepted, 2026-10-21 (workstreams 0B logical records, 0C writes, 1E history). Code: `packages/server/src/records/{save-*,write-*,change-entry,history-query,stored-*}.ts`, `packages/server/src/platform/migrations/0004-history.ts`.

Phase 1 builds everything that needs no access rules, actor service or HTTP. Authorization, hooks and password hashing are typed seams; phase 2 (after `ws/0c-reads`) plugs in `@std/access`, the `Actor` service and the routes.

## Modules

| Module | What it provides |
| --- | --- |
| `records/save-pipeline` | `createRecord`, `updateRecord`, `deleteRecord` (`Effect.fn`), each one request transaction (joined when nested); `SaveInput` (`endpointClassId`, `actorId`, `cause?`, `nameable?`), `SaveResult` (`outcome`, `id`, `classId`, `version`, `changeId`, `record`) |
| `records/write-body` | `decodeWriteBody` (unknown input to a JSON object, `InvalidBody`), `resolveWriteBody` (names to fields, `UnknownField`, system members `ReadOnlyField`), `SYSTEM_FIELD_NAMES` |
| `records/write-validation` | `proposeCreate`, `proposeUpdate` (6.7 absent vs null, defaults, `@std/values` conversion under the effective type), `validateProposal` |
| `records/field-errors` | the field errors of `ValidationFailed` as `Schema.TaggedStruct`s; `InvalidValue` reasons are `@std/values`'s plus `notUnique` |
| `records/save-sql` | `lockRoot`, `loadRecord`, `insertRecord`, `updateRecord` (rows), `deleteRecordRows`, `existingTargets`, `updateLock`, `NOW` |
| `records/save-constraints` | `constraintFailure`, `mapConstraints`: constraint violations to API errors by generated name |
| `records/change-entry` | `ChangeCauseSchema`, `changedFields`, `writeChangeEntry` |
| `records/history-query` | `readHistory` with an explicit readable-field set and filters |
| `records/write-access` | `WriteAccess` seam; `WriteAccess.allowAll`, `projectAll` |
| `records/save-hooks` | `SaveHooks` seam (`beforeWrite`, `deliveries`, `afterWrite`); `SaveHooks.none` |
| `records/write-only-values` | `WriteOnlyValues` seam (`hashPassword`); `WriteOnlyValues.unavailable` |
| `records/save-stack` | `SaveStack` reference: operation ID and records of enclosing saves (`RecordInSave`) |
| `records/stored-values` | `columnText`, `parseStoredText` (Postgres text to `@std/values`), `bindValue` (text parameters with casts) |
| errors | `ValidationFailed`, `VersionConflict` (`currentVersion`), `NotFound`, `NotAllowed`, `UnknownField` (`field`), `InvalidReference` (`field`), `Referenced`, `RecordInSave`, `InvalidBody`; one file each |

## Pipeline order (Contracts 4.1)

Update:

1. `request` (`begin_request()`), `Catalog.current`, body names resolved against `nameable(snapshot, endpoint)` (`UnknownField`; `id`, `class`, `version`, audit names give `ValidationFailed` with `ReadOnlyField`). No query has run.
2. `SELECT class_id, version FROM <root> WHERE id = $1 FOR NO KEY UPDATE` (alone; `FOR UPDATE` when the body names a root column under a unique index without expressions, 2.2 item 3). No row, or a class outside `subtree(endpoint)`: `NotFound`. A record on the save stack: `RecordInSave`.
3. Next statements: load all level rows (inner joins), `WriteAccess.visibility` (`None` is `NotFound`), then the version (`VersionConflict` with the current version). Visibility comes first, so an invisible record never yields `VersionConflict`.
4. Convert the body under the concrete class's effective schema; written fields = unreadable, invalid, or `!storedEquals`. `WriteAccess.checkExisting` (`NotAllowed`).
5. No-op (no written field): project and return `unchanged`; no hooks, writes or entry.
6. `SaveHooks.beforeWrite`, then the no-op check again with hook changes.
7. `validateProposal` (`ValidationFailed`, all field errors together), then reference targets via `WriteAccess.visibleTargets` (`InvalidReference`).
8. `UPDATE <root> SET version = version + 1, updated_at, updated_by, ... WHERE id AND version = $expected`, then each level whose columns changed, top down.
9. Reload, `WriteAccess.checkProposed` (`NotAllowed` fails the save; the transaction rolls back).
10. `core.change` entry, `SaveHooks.deliveries` (outbox, 1E), `SaveHooks.afterWrite` with the save on the stack.
11. `WriteAccess.project`.

Create: steps 1, 6, 7, then `INSERT` root (`uuidv7()`, version 1, audit columns) and each level row in order, then 9 to 11. Every live field is written: the payload value, else the constant default, else the empty value (false for boolean). Read-only and retired fields count as written on create only when their value differs from that.

Delete: steps 1 to 3 with `FOR UPDATE`, `checkExisting(delete)`, `beforeWrite`, `DELETE FROM <root> WHERE id AND version` (level FKs cascade), entry at current version + 1 with every non-empty `before`.

System times are `date_trunc('milliseconds', transaction_timestamp())`: one clock reading per transaction in whole milliseconds. The root lock and the plain loads are marked `readOnly` (the SQL layer accepts locking clauses as reads); inserts, updates, deletes and the entry count as writes.

## Seams for phase 2

- `WriteAccess` (per request, built from the `Actor`): `visibility` returns the readable field IDs or `None`; `checkExisting` and `checkProposed` re-read through the reads' compiled predicates; `visibleTargets` applies the target's visibility; `project` produces the response with the caller's read rights. Its methods use the transaction's `SqlClient` (the `leakingRequirements` suggestion is intended).
- `nameable` on `SaveInput`: the caller's readable or writable fields at the endpoint (3.4).
- `actorId` on `SaveInput` becomes the `Actor` service.
- `readHistory`'s `readable`: the fields the caller can currently read on the current record.
- `SaveHooks` for Step 3 hooks and 1E delivery rows; `WriteOnlyValues.hashPassword` for the auth layer's hash.

## `core.change` (migration 0004)

Laid out like the 0002 platform tables and described in `definitions/core/platform.yaml` (class `edde151d-...`, `PLATFORM_CLASS_IDS.change`), so only the admin allow-all rule reaches it through the generic API.

| Column | Meaning |
| --- | --- |
| `id` | change ID, UUIDv7 |
| `class_id`, `version` | platform class of `core.change`; always 1 (entries never change) |
| `created_*`, `updated_*` | equal `occurred_at` and `actor_id` (CHECK `change_audit`) |
| `operation_id` | the outermost save's change ID; nested saves inherit it via `SaveStack` |
| `record_id`, `record_class_id`, `record_version` | the logical record; `UNIQUE (record_id, record_version)` |
| `kind` | `create`, `update`, `delete` |
| `actor_id`, `cause` (jsonb), `schema_revision`, `occurred_at` | 4.2 |
| `fields` (jsonb object) | field ID to `{before, after}` canonical JSON; password and secret `{"changed": true}` on create and update, absent on delete |

Deviation: Contracts 4.2's `class_id` is stored as `record_class_id` (contract text updated). No FK on `record_id` (entries outlive records) or on actor and audit columns (platform convention). Index on `operation_id`.

Migration 0003 is a placeholder (`SELECT 1`) holding the slot of `ws/0c-reads`; the reads branch replaces it on merge. No installation applies it before then.

## Constraint mapping

Errors are mapped through `parseGeneratedName` of the sanitized error's constraint name, never message text:

| SQLSTATE | Constraint | Write | Delete |
| --- | --- | --- | --- |
| 23503 | `std_fk_<field>` | `InvalidReference` (field) | `Referenced` |
| 23503 | `std_cb_`, `std_ub_` | `DatabaseError` | `Referenced` |
| 23505 | `std_ix_<index>` | `ValidationFailed`, `InvalidValue` `notUnique` per index field | `DatabaseError` |
| 23502 | `std_nn_<field>` | `ValidationFailed`, `Required` | `DatabaseError` |
| 23514 | `std_ck_<field>` | `ValidationFailed`, `InvalidValue` `tooLong` | `DatabaseError` |

Everything else stays `DatabaseError` (SQLSTATE, constraint name, diagnostic ID). Reference targets are also checked before the write (`visibleTargets`), so the FK mapping is the backstop for a concurrent delete.

## Tests

`record-writes.test.ts`, `record-history.test.ts`, `version-invariant.test.ts` against the core and acme sets loaded through the real loader, Alice and Bob inserted as table owner: delete through asset and laptop endpoints (no rows, one entry at n+1), serial update bumps the root version by 1 and sets `updated_by`, a stale version is `VersionConflict` with nothing changed, `purchased_on` null refused for a laptop and accepted for a monitor, `Referenced`, `InvalidReference` on create and update, unique violation on `core.user.login`, body envelope members, unknown and child-only names, subtree `NotFound` identical to a random ID, no-op, history field filtering and filters, delete entries, error hygiene (no Postgres text, values or IDs in `Cause.pretty`, `inspect` or JSON), and the fast-check version invariant (25 runs of up to 25 random creates, updates, stale updates and deletes through all three endpoints).

## Open items

- Phase 2: the real `WriteAccess`, `Actor`, HTTP routes (`If-Match`, `VersionRequired`), `SchemaChanged` checks (6.4) and the Contracts 3 write tests.
- Choice validation against choice lists (Step 2), secret encryption, retired classes, and `RecordInSave` across `saveBatch` (Step 3).
- Hook failures have no typed error yet; Step 3 adds one to `SaveHooks`.
