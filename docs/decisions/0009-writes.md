# 0009. Record writes: save pipeline, change entries, history

Status: accepted, 2026-10-21 (workstreams 0B logical records, 0C writes, 1E history). Code: `packages/server/src/records/{save-*,write-*,change-entry,history-*,record-access,stored-*}.ts`, `packages/server/src/http/record-writes.ts`, `packages/api/src/errors/*`, `packages/server/src/platform/migrations/0004-history.ts`, `examples/acme/src/{demo,main}.ts`.

Phase 1 built everything that needs no access rules, actor service or HTTP, with authorization, hooks and password hashing as typed seams. Phase 2 plugs in `@std/access` and the read compiler (`RuleWriteAccess`), the `Actor` service, scrypt hashing, the HTTP routes, the acme fixture through the pipeline and `pnpm spike:demo` (see "Phase 2").

## Modules

| Module | What it provides |
| --- | --- |
| `records/save-pipeline` | `createRecord`, `updateRecord`, `deleteRecord` (`Effect.fn`), each one request transaction (joined when nested), acting as the `Actor` in the environment; `SaveInput` (`endpointClassId`, `cause?`), `SaveResult` (`outcome`, `id`, `classId`, `version`, `changeId`, `record`) |
| `records/write-body` | `decodeWriteBody` (unknown input to a JSON object, `InvalidBody`), `resolveWriteBody` (names to fields, `UnknownField`, system members `ReadOnlyField`), `SYSTEM_FIELD_NAMES` |
| `records/write-validation` | `proposeCreate`, `proposeUpdate` (6.7 absent vs null, defaults, `@std/values` conversion under the effective type), `finalizeCreate`, `finalizeUpdate`, `recheckValue` (the final candidate after hooks), `validateProposal` |
| `records/field-errors` | the field errors of `ValidationFailed` as `Schema.TaggedStruct`s; `InvalidValue` reasons are `@std/values`'s plus `notUnique` |
| `records/save-sql` | `lockRoot`, `loadRecord`, `insertRecord`, `updateRecord` (rows), `deleteRecordRows`, `existingTargets`, `updateLock`, `NOW` |
| `records/save-constraints` | `constraintFailure`, `mapConstraints`: constraint violations to API errors by generated name |
| `records/change-entry` | `ChangeCauseSchema`, `changedFields`, `writeChangeEntry` |
| `records/history-query` | `readHistory` with an explicit readable-field set and filters |
| `records/write-access` | `WriteAccess` seam (`nameable`, `visibility`, `checkExisting`, `checkProposed`, `visibleTargets`, `project`); `WriteAccess.allowAll` (seeding, tests), `projectAll` |
| `records/write-access-rules` | `RuleWriteAccess`: the seam for the request's `Actor` over the read compiler |
| `records/record-access` | `readableOnRecord`, `truthColumn`: one record's visibility and readable fields in SQL |
| `records/history-endpoint` | `recordHistory`: the history route's service (visibility through E, readable fields, admin-only deleted and purged history, filters) |
| `http/record-writes` | `writeBodyOf`, `expectedVersionOf` (`If-Match`), `createInRequest`, `updateInRequest`, `deleteInRequest`, `historyInRequest` |
| `records/save-hooks` | `SaveHooks` seam (`beforeWrite`, `deliveries`, `afterWrite`); `SaveHooks.none` |
| `records/write-only-values` | `WriteOnlyValues` seam (`hashPassword`); `WriteOnlyValues.scrypt` (sign-in's hashing), `WriteOnlyValues.unavailable` |
| `records/save-stack` | `SaveStack` reference: records of enclosing saves (`RecordInSave`) |
| `records/stored-values` | `columnText`, `parseStoredText` (Postgres text to `@std/values`), `bindValue` (text parameters with casts) |
| errors | In `@std/api/errors` with their HTTP status: `ValidationFailed` 422 (field errors in `field-errors`), `VersionConflict` 409 (`currentVersion`), `VersionRequired` 428, `InvalidReference` 422 (`field`), `Referenced` 409, `NotAllowed` 403, plus the reads' `NotFound` and `UnknownField`. Server-only: `RecordInSave`, `InvalidBody` |

## Pipeline order (Contracts 4.1)

Update:

1. `request` (`begin_request()`), `Catalog.current`, body names resolved against `nameable(snapshot, endpoint)` (`UnknownField`; `id`, `class`, `version`, audit names give `ValidationFailed` with `ReadOnlyField`). No query has run.
2. `SELECT class_id, version FROM <root> WHERE id = $1 FOR NO KEY UPDATE` (alone; `FOR UPDATE` when the body names a root column under a unique index without expressions, 2.2 item 3). No row, or a class outside `subtree(endpoint)`: `NotFound`. A record on the save stack: `RecordInSave`.
3. Next statements: load all level rows (inner joins), `WriteAccess.visibility` (`None` is `NotFound`), then the version (`VersionConflict` with the current version). Visibility comes first, so an invisible record never yields `VersionConflict`.
4. Convert the body under the concrete class's effective schema; written fields = unreadable, invalid, or `!storedEquals`. `WriteAccess.checkExisting` (`NotAllowed`).
5. No-op (no written field): project and return `unchanged`; no hooks, writes or entry.
6. `SaveHooks.beforeWrite`. The final candidate (`finalizeUpdate`) rechecks every value the save sets, the hooks' included, under the effective type (through canonical JSON and `decodeIn`, so type, length and bounds apply as to body values). The written fields are recomputed from it, with the same rule (unreadable, invalid or changed): if hooks added fields, `checkExisting` runs again with the full set; if nothing is written any more (a hook restored the value), the save is a no-op.
7. `validateProposal` over the whole record as it would be stored (`ValidationFailed`, all field errors together; `Required` for every required field of the concrete class), then reference targets via `WriteAccess.visibleTargets` (`InvalidReference`).
8. `UPDATE <root> SET version = version + 1, updated_at, updated_by, ... WHERE id AND version = $expected`, then each level whose columns changed, top down.
9. Reload, `WriteAccess.checkProposed` (`NotAllowed` fails the save; the transaction rolls back).
10. `core.change` entry, `SaveHooks.deliveries` (outbox, 1E), `SaveHooks.afterWrite` with the save on the stack.
11. `WriteAccess.project`.

Create: steps 1, 6, 7, then `INSERT` root (`uuidv7()`, version 1, audit columns) and each level row in order, then 9 to 11. Every live field is written: the payload value, else the constant default, else the empty value (false for boolean); a field a hook drops gets the same (`finalizeCreate`). The supplied fields (for `checkProposed`) are the body's plus those hooks set or changed. Read-only and retired fields count as written for validation only when their value differs from what the create stores without them.

Delete: steps 1 to 3 with `FOR UPDATE`, `checkExisting(delete)`, `beforeWrite`, `DELETE FROM <root> WHERE id AND version` (level FKs cascade), entry at current version + 1 with every non-empty `before`.

System times are `date_trunc('milliseconds', transaction_timestamp())`: one clock reading per transaction in whole milliseconds. The root lock and the plain loads are marked `readOnly` (the SQL layer accepts locking clauses as reads); inserts, updates, deletes and the entry count as writes.

## Seams (filled in phase 2)

- `WriteAccess` (per request, built from the `Actor`; `RuleWriteAccess`): `visibility` returns the readable field IDs or `None`; `checkExisting` and `checkProposed` re-read through the reads' compiled predicates; `visibleTargets` applies the target's visibility; `project` produces the response with the caller's read rights for the endpoint (its fields and its ancestors', Contracts 2.3; `projectAll` does the same without rules, `class` stays the concrete class). Its methods use the transaction's `SqlClient` and `RequestRevision` (the `leakingRequirements` suggestion is intended).
- `WriteAccess.nameable` (phase 1: a `nameable` input): the caller's readable or writable fields at the endpoint (3.4).
- The `Actor` service (phase 1: an `actorId` input).
- `readHistory`'s `readable`: the fields the caller can currently read on the current record.
- `SaveHooks` for Step 3 hooks and 1E delivery rows; `WriteOnlyValues.hashPassword` for the auth layer's hash.

## `core.change` (migration 0004)

Laid out like the 0002 platform tables and described in `definitions/core/platform.yaml` (class `edde151d-...`, `PLATFORM_CLASS_IDS.change`), so only the admin allow-all rule reaches it through the generic API.

| Column | Meaning |
| --- | --- |
| `id` | change ID, UUIDv7 |
| `class_id`, `version` | platform class of `core.change`; always 1 (entries never change) |
| `created_*`, `updated_*` | equal `occurred_at` and `actor_id` (CHECK `change_audit`) |
| `operation_id` | one per transaction attempt: a UUIDv7 created in TypeScript and stored in a `WeakMap` keyed by the attempt's `CurrentTransaction` handle in one synchronous step on first use (fresh per outermost transaction and per config-commit retry, shared by joined and concurrent units), so no SQL a caller runs can change or forge it |
| `record_id`, `record_class_id`, `record_version` | the logical record; `UNIQUE (record_id, record_version)` |
| `kind` | `create`, `update`, `delete` |
| `actor_id`, `cause` (jsonb), `schema_revision`, `occurred_at` | 4.2 |
| `fields` (jsonb object) | field ID to `{before, after}` canonical JSON; password and secret `{"changed": true}` on create and update, absent on delete |

Deviation: Contracts 4.2's `class_id` is stored as `record_class_id` (contract text updated). No FK on `record_id` (entries outlive records) or on actor and audit columns (platform convention). Index on `operation_id`.

Migration 0003 (`core.session`) belongs to workstream 0C reads; phase 1 held its slot with a placeholder, dropped when `ws/0c-reads` was merged.

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

`record-writes.test.ts`, `record-history.test.ts`, `version-invariant.test.ts` against the core and acme sets loaded through the real loader, Alice and Bob inserted as table owner: delete through asset and laptop endpoints (no rows, one entry at n+1), serial update bumps the root version by 1 and sets `updated_by`, a stale version is `VersionConflict` with nothing changed, `purchased_on` null refused for a laptop and accepted for a monitor, `Referenced`, `InvalidReference` on create and update, unique violation on `core.user.login`, body envelope members, unknown and child-only names, subtree `NotFound` identical to a random ID, no-op, history field filtering and filters, delete entries, error hygiene (no Postgres text, values or IDs in `Cause.pretty`, `inspect` or JSON), and the fast-check version invariant (25 runs of up to 25 random creates, updates, stale updates and deletes through all three endpoints). `save-hook-points.test.ts` (review round 1): hook values over a max length, of the wrong kind or dropping a required field are refused; a field a hook adds reaches `checkExisting` and its refusal writes nothing; a hook restoring the stored value is a no-op; two saves in one transaction share one operation ID; the projection through `acme.asset` leaves out `serial` and `disk_key`.

## Open items

- Phase 2: the real `WriteAccess`, `Actor`, HTTP routes (`If-Match`, `VersionRequired`), `SchemaChanged` checks (6.4) and the Contracts 3 write tests.
- Choice validation against choice lists (Step 2), secret encryption, retired classes, and `RecordInSave` across `saveBatch` (Step 3).
- Hook failures have no typed error yet; Step 3 adds one to `SaveHooks`.

## Review round 1

- Values after before-write hooks are rechecked under the effective type, and required fields are checked over the complete final record (create: dropped fields get their absent value).
- Fields hooks add go through `checkExisting` before any write.
- The written fields, and so the second no-op check, are recomputed from the final candidate.
- `operation_id` is transaction-scoped, not tied to the hook stack (round 2: held in TypeScript per transaction attempt, no SQL setting); `SaveStack` keeps only record IDs, and `ChangeEntryInput` no longer has `operationId`.
- `projectAll` projects the endpoint's lineage.

## Review round 2

- The operation ID moved from the SQL setting `std.operation_id` to a `WeakMap` keyed by the transaction attempt's `CurrentTransaction`: a caller's `set_config` can neither split nor forge it, and the change-entry `INSERT` no longer calls `set_config`.
- Plaintext a hook supplies for a password or secret is checked like body input (`decodeIn` of the revealed text: non-empty, well-formed, no U+0000); refusals carry no value.

## Review round 3

- The operation ID is created in TypeScript (`uuidv7At`) and stored in the same synchronous step that finds none, so concurrent saves joined to one request cannot start two operations. Every entry, the first included, uses it; it is no longer the first change ID.

## Phase 2

### Authorization (`RuleWriteAccess`)

Per request, from the `Actor`, the `Catalog`, the `InstanceSettings` and one clock reading (`me`, `now`, the instance zone):

| Seam | SQL |
| --- | --- |
| `nameable(E, action)` | (no SQL) the fields of E's lineage that the caller can read through E's view, or for which some row-visible class of subtree(E) (create: E) has a non-never field decision for the action |
| `visibility` | `readableOnRecord`: over `recordRelation(C)` of the concrete class C with C's exact view, `visible` and one readability flag per field of C, in the statement after the record load (the root is locked) |
| `checkExisting` | `SELECT COALESCE(record(action) AND field(update, f1) AND ..., false)` over `recordRelation(C)` for the record, before any write |
| `checkProposed` | the same with `create`/`update` for the record and each written or supplied field, after the row writes; `NotAllowed` fails the save, so the request transaction rolls back |
| `visibleTargets` | `relation(T) WHERE id = ANY($ids) AND visibility(T)` |
| `project` | `getRecord` through E with the caller's read view; `NotFound` (no longer visible) becomes `{ id, version }` |

### HTTP

| Route | Success | Errors |
| --- | --- | --- |
| `POST /api/v1/tables/{table}/records` | 201 `{ schemaRevision, record }` | `UnknownTable`, `UnknownField`, `ValidationFailed`, `InvalidReference`, `NotAllowed`, `InvalidRequest`, `SchemaChanged` |
| `PATCH .../records/{id}` (`If-Match: "<version>"`) | 200 `{ schemaRevision, record }` (a no-op returns the record unchanged) | the above, `NotFound`, `VersionRequired` 428, `VersionConflict` 409 |
| `DELETE .../records/{id}` (`If-Match`) | 200 `{ schemaRevision, id, version }` (the delete's entry version) | `NotFound`, `NotAllowed`, `Referenced`, `VersionRequired`, `VersionConflict` |
| `GET .../records/{id}/history?since&until&actor&kind&field` | 200 `{ schemaRevision, entries: [{ changeId, operationId, version, kind, actor, occurredAt, schemaRevision, cause, changes }] }`, `changes` keyed by current field name | `NotFound`, `UnknownField` (a field filter the caller cannot read), `InvalidRequest` |

- Bodies are read as text and parsed with `@std/values/json` `parseJson` (duplicate keys and inexact numbers refused); an unparsable body or a non-object is `400 InvalidRequest` (as the reads' `RequestDecoding` middleware does for undecodable requests), while a value that does not convert for its field is `422 ValidationFailed`.
- `If-Match` is checked before the transaction: missing is 428 and changes nothing; malformed is `InvalidRequest`. An ID that is not a UUID is `NotFound`.
- The stale-request check (6.4) resolves the body's field names at the request's revision as a `fields` scope (`stale-scope.ts`).
- Handlers stay thin: they parse, run `inRequestTransaction(…, asActor(…))` and call `createInRequest` and friends, which provide `RuleWriteAccess` to the pipeline. `SaveHooks.none` and `WriteOnlyValues.scrypt` are provided to the routes in `http/app.ts`.

### History access

The record must be visible through E now; the fields shown are those readable on the current record over its concrete class, so child-only fields appear through a parent endpoint (2.3, 3.7). A caller with always-readable `core.change` records and `fields` (only the admin rule gives that) also sees deleted records' history (found through `core.change` with `record_class_id` in subtree(E)) and purged fields' changes.

### Fixture and demo

- The acme fixture (`@std/testing/acme-fixture`) creates users (with scrypt passwords), role assignments and records through `createRecord` with `WriteAccess.allowAll` (`seedRecord`, `createFixtureUser`): users and roles as the system user, each asset as its owner. Every fixture record has its change entry. Bulk test data in `cursor-nulls` and `branch-form` still uses table-owner inserts.
- `pnpm spike:demo` runs `examples/acme/src/main.ts`: a fresh database from the migrated template, the fixture, the HTTP app in process; it prints what Alice and Bob see and are refused through `/acme.asset` and `/acme.laptop`, the two-user write scenario and L's history. `examples/acme/test/demo.test.ts` runs the same program in CI.

### Tests (phase 2)

`write-authorization.test.ts`: `ownership`, `child-rule-parent-endpoint`, `child-fields`, `written-fields`, `references`, `history` and `history-endpoint`, `referenced`, `invisible-404` (PATCH, never `VersionConflict` on an invisible record), If-Match 428 and 409, 400 versus 422. `two-user-write.test.ts`: `two-user-write` through both endpoints and both users' histories, the 2.2 delete and serial-version tests over HTTP, `field-rule-states` with rule 7 replaced for `name`, a stale-revision write, no password in history. `save-operations.test.ts`: concurrent joined saves share one operation.

### Deviations and open items

- `field-rule-states` replaces rule 7 for `name` with a local rule through a change set (an update of rule 7's target plus a new allow conditioned on `status = "in_use"`).
- `RecordInSave` and `InvalidBody` cannot occur at the HTTP edge today and are defects there; `Referenced` only on deletes.
- History entries key changes by the current field name; reading old values at their revision through `core.definition_revision` (4.4) is the Step 2 history panel's job.

## Phase 2 review

- **History under one snapshot (3.7).** A live record's history is one statement: `recordRelation(C)` with the record's visibility and each field's readability flag, `LEFT JOIN core."change"` on the record with the filters (the field filter also needs the field readable on the same row). Permissions and entries can no longer come from different snapshots. `write-leaks.test.ts` holds Alice's transaction (M made `lost` with a new `purchased_on`, `core.change` locked) until Bob's history statement waits on the lock (observed in `pg_stat_activity`), then commits: Bob's response holds neither the date nor `purchased_on`. Deleted records keep the admin-only path.
- **Validation names only shown fields (3.8).** The full candidate is still validated; the errors returned name only fields the caller supplied or could read on the proposed record (`WriteAccess.readableOnProposal`: the record's visibility and each field's read rule evaluated in SQL over a one-row relation of the candidate values, `proposedRelation`). When every failing field is hidden, `ValidationFailed` lists no field: that reveals only that some hidden validation failed. Tested with a lost laptop missing `purchased_on` and with `cost` made required for laptops (never readable to Bob).
- **Stale creates (6.4).** A create's stale scope adds every field of E's lineage that is required without a default at C (overrides included), relevant only for `fieldAdded` and `requiredChanged`; a create built before `status` became required gets `409 SchemaChanged` before validation.
- **Write nameability in stale checks (3.4, 6.4).** `checkRequestRevision` takes the write action: changes are listed for fields the caller can read or write at C (`isNameable`, shared with `WriteAccess.nameable`), so a field Bob may update but not read that became read-only gives `409 SchemaChanged`, not `422`.
