# 0017. Metadata, `recordSchema`, choices, layouts and auto-numbers (Step 2, workstream 2A)

Status: accepted, 2026-10-22 (workstream `ws/2a-metadata`, the server and API side of Step 2). Code: `packages/definitions/src/{definition,snapshot,effective-schema,validate,dependencies,lifecycle,operation,overridable,set-file,set-resolve,set-plan,set-upgrade,field-errors,record-rules,record-schema,table-metadata}.ts`, `packages/access/src/table-metadata.ts`, `packages/api/src/metadata.ts`, `packages/server/src/http/{metadata-handlers,metadata-limits,table-openapi,stale-request}.ts`, `packages/server/src/records/{write-validation,save-pipeline,auto-numbers,read-query}.ts`, `packages/server/src/schema/{backfill,step-spec}.ts`, `packages/server/src/platform/migrations/0008-ui-config.ts`. Contracts 1.5, 1.7, 2.5, 5.2, 6.3, 6.3a, 6.4, 6.5, 8.2, 8.4.

Plan Step 2, guarantee 2A: "Metadata never contains what the user cannot read; browser and server give the same per-field verdict."

## Modules

| Module | What it provides |
| --- | --- |
| `@std/definitions/definition` | kinds `choice` (`fieldId`, `key`, `label`, `order`, `hidden`) and `layout` (`classId`, `type` `form`/`list`, `elements`); field `numberPrefix`; override `choices` and `numberPrefix` |
| `@std/definitions/snapshot` | `choicesOf(fieldId)` (live, by order then key), `layoutsOf(classId)` |
| `@std/definitions/effective-schema` | `EffectiveField.choices` (stacked subset, null when unrestricted) and `numberPrefix`; `effectiveChoices`, `effectiveLayout` (nearest along the lineage) |
| `@std/definitions/field-errors` | the `ValidationFailed` field errors, moved from `@std/api` so the browser-side builder can return them |
| `@std/definitions/record-rules` | `FieldRules` and the per-field rules both sides run: `fieldRulesOf`, `choiceListOf`, `convertCreate`, `convertUpdate`, `recheckValue`, `absentCreateValue`, `writtenOnCreate`, `fieldErrorsOf` |
| `@std/definitions/table-metadata` | `TableMetadataSchema`, `MetaTable`, `MetaField`, `MetaFieldType`, layout elements: the browser-safe metadata, Schema-decodable |
| `@std/definitions/record-schema` | `recordSchema(table, mode, stored?)` (an Effect Schema over a write body, one issue per failing field) and `validateRecord` (unknown names and `FieldError`s) |
| `@std/access/table-metadata` | `tableMetadata(snapshot, caller, classId, limits)`: the filtered metadata of one endpoint |
| `@std/api/metadata` | `MetadataGroup`: `GET /meta/tables/:table`, `GET /meta/tables/:table/openapi.json` (authenticated) |
| `server/http/metadata-limits` | `genericWriteLimits`: what the generic routes accept on platform and definition tables |
| `server/http/table-openapi` | the per-table OpenAPI 3.1 document |
| `server/records/auto-numbers` | number assignment in the save transaction |
| `server/schema/backfill` | the `backfill` follow-up step |
| migration 0008 | `core.choice`, `core.layout`, `core.field.number_prefix`, `core.field_override.{choices,number_prefix}`, `core.number_counter` |

## Where `recordSchema` lives

`@std/definitions`, a plain package. Contracts 6.3 asks for one builder in a plain package that both the server and the browser run; the architecture's dependency rules allow exactly that: `web` may import `definitions`, `server` imports it already, and `api` depends on `definitions` (so it serves `TableMetadataSchema` from there) but `definitions` cannot depend on `api`. That is also why the field-error schemas moved from `@std/api` to `@std/definitions`. The builder of filtered metadata needs access decisions, so it lives in `@std/access`, which the browser never needs.

"One builder" is held by construction and by test. The per-field rules (`record-rules.ts`) are the only implementation: the save pipeline builds `FieldRules` from the effective schema of the record's concrete class (`fieldRulesOf`, full definitions) and runs them in `write-validation.ts`; the metadata carries exactly what those rules read of a field (type with settings, required, read-only, auto-number, state, default, choices), and `recordSchema` rebuilds the same `FieldRules` from it (`rulesOfMetaField`). The `record-schema-property` test proves the end-to-end claim.

## Decisions

### Metadata (Contracts 6.3)

- **Shape.** `{ schemaRevision, table: { id, name, label, helpText, ancestors, creatable, displayField, fields, layouts: { form, list }, formRules } }`; per field `id, name, label, helpText, type, inheritedFrom, required, readOnly, nullable, default, state, choices, autoNumber, read, write: { create, update } }`. `formRules` is always `[]` until form rules exist (Step 3); there is no `form-state` endpoint yet.
- **Filtering.** Never-readable fields are absent with their choices and layout entries; `read` is `yes` (always) or `perRecord` (conditional). A table the caller has no allow on is `UnknownTable`, byte-identical to a missing table apart from its name. References and condition fields name their table by qualified name, and only when the caller knows it, otherwise `null`, never by ID [judgment: a class ID would disclose a hidden table]. No access-rule condition or rule input appears.
- **`write`** [judgment]: `{ create, update }` instead of one value, since they differ. `create` combines E's record and field create decisions; `update` combines record and field update decisions over the row-visible classes of subtree(E): all never is `no`, all always `yes`, otherwise `perRecord`. `no` also for read-only and retired fields and tables that accept no writes. Platform tables show only what the generic routes accept (`genericWriteLimits`): nothing on non-definition platform tables (`core.change`, the journal, config-layer tables), and at most `perRecord` per column on definition tables, whose writes the schema engine validates as change sets, not `recordSchema` (found in review: before, an admin's metadata showed `core.change` as creatable).
- **Stale revisions** [judgment]: a stated older revision is served, because a stale client fetches metadata to refresh; malformed is `400 InvalidSchemaRevision`, one the database never had `409 SchemaChanged`.
- **Not cached.** Computed per request from the cached snapshot; the contract's cache key stays available when measurements ask for it.
- **Per-table OpenAPI document never rejects what the server accepts** (review round 1): record values describe every readable field plus the audit fields and one-hop paths (`patternProperties`); create and update bodies are separate schemas, and update enums include hidden choice keys, described as accepted only when unchanged; text limits are described, not enforced; a write response may be `{ id, version }`. `table-openapi.test.ts` validates real list, get, create and update responses and accepted bodies against the document with ajv 8.18.0, a server dev dependency only (already in the lockfile; Effect's `JsonSchema` decoder does not handle `patternProperties` next to `properties`).
- **Per-table OpenAPI** (plan Step 2): `GET /api/v1/meta/tables/{table}/openapi.json`, built from the caller's metadata (so it names nothing the caller cannot read), with the table's record routes, `info.version` `<n>.<change_set_id>` and `x-std-schema-revision`.

### `recordSchema` (Contracts 6.3)

- The Schema decodes a write body; each failing field is a `Pointer` issue at its name. `validateRecord` maps issues back to `FieldError`s through a module-level `WeakMap` from issue to error, so no field error is parsed out of a message.
- It mirrors the pipeline's order: unknown names first (the server answers `UnknownField` and nothing else), system members as `ReadOnlyField` only, then conversion, written-field rules, `DefinitionRetired`/`ReadOnlyField`/`Required`. In update mode `stored` must hold every field the body names (a value withheld from the caller counts as written, as on the server); no written field is a no-op with no errors.
- **Updates use the concrete class's metadata** (review round 1). The server validates an update against the stored record's concrete class, whose overrides may be tighter than the endpoint's (a parent `maxLength` 8 with a child override of 2). So `recordSchema(table, "update", stored, { through? })` takes `stored = { class, values }` and requires `table` to be the metadata of `stored.class`; other metadata is a defect, so the mistake is loud. `through` names the ancestor endpoint the body is sent to: names resolve there, rules come from the concrete class. The browser reads `class` from the record and fetches that table's metadata. The property test now also sends updates of child records through the parent endpoint (four mismatches with the old builder).
- Server-only [judgment, Contracts 6.3]: uniqueness, reference targets, access rules, the check of a condition value against the caller's view of its class (`invalidCondition`: the metadata of one table does not carry another table's visible schema), form rules, stale revisions, versions.

### Choices (Contracts 2.5, 5.2, 6.4, 6.5, 8.2)

- Config records with stable IDs, keys and labels; `hidden` is what "retired" means for a choice (ServiceNow's inactive). Choices have no retire or purge operation of their own; `delete` leaves a tombstone, and a field purge takes its choices along [judgment].
- Keys never change [judgment], so stored values keep their meaning.
- A child class restricts a choice field with an override subset; subsets stack by intersection; tightening runs the 1.4 preflight (`ExistingDataViolates` with a count), the `validate_override` step and `doctor`'s `overrideViolated`.
- Writes: a key outside the concrete class's subset is `unknownChoice`; a hidden key inside it is `retiredChoice`, kept when unchanged. A default must be a live, non-hidden key inside the subset.
- Filters and stored conditions check literals against the field's whole live list, hidden keys allowed (5.2), not the endpoint class's subset [judgment: a literal outside a child's subset is meaningful through the parent endpoint].
- Stale requests: adding, hiding, showing or deleting a choice, or changing a subset, is `choicesChanged` for the field. A subset change counts only within the request's reach (review round 1): a create reaches the endpoint class and its ancestors, so a child's new subset no longer refuses a parent create; reads, updates and deletes through an endpoint reach its descendants' records too; a label or order change is not relevant. Any choice change of the field counts, even outside the class's subset [judgment].
- Deleting a choice an override subset names is `422 DefinitionInvalid` [judgment].
- Upgrades: a choice removed upstream becomes hidden (8.4).

### Layouts (Contracts 6.3a, 1.7, 8.2)

- One live layout per table and type (`form`, `list`); list layouts hold field elements only; each field once; elements name fields of the table's lineage by ID [judgment].
- A table without its own layout uses its nearest ancestor's; a child's own layout replaces it as a whole. A local edit of a shipped layout is one override of the whole `elements` property, which upgrades treat like any other property (conflict, `keep_local`, convergence).
- Contracts 1.7 named `layout_uses` but no layout rules beyond "purge field: not blocked by layout entries". Added [judgment]: retiring a field a layout names is allowed and reports the layout; a purge never touches a layout, which keeps the tombstone's ID (validation accepts purged fields of the lineage, so the snapshot stays valid) and metadata skips it; a table purge takes its layouts along, like overrides. Metadata serves only active, readable fields and drops sections left without fields.
- A layout removed upstream is deleted (tombstone) [judgment]; 8.4 said nothing about layouts.

### Auto-numbers (Contracts 6.5, 1.5)

- An auto-numbered field is a text field with `numberPrefix`; a child class replaces the prefix with an override. Only text fields; prefix `^[A-Za-z][A-Za-z0-9_-]{0,15}$`; max length at least prefix length + 19; no default; never required; effectively read-only for every caller; never `Required`. On create a null value counts as not written, any other value gives `ReadOnlyField`. Auto-numbering cannot be switched on or off after the field exists (`unsupportedChange`); the prefix can change and does not renumber [judgment].
- Assignment, in the save transaction after validation and reference checks: `INSERT INTO core.number_counter ... ON CONFLICT (field_id, prefix) DO UPDATE SET last_value = last_value + 1 RETURNING`, fields in ID order. The counter is keyed by field and prefix, so every class using a prefix for the field shares one sequence and a hierarchy never repeats a number, even after prefix changes. Format `<prefix><n>` zero-padded to 7 digits, wider past 9,999,999 [judgment, as ServiceNow's number maintenance]. The counter row is held until commit, so concurrent creates of one field and prefix serialize their commits on it (accepted; the 2.6 write budget is re-measured in Step 4); a rolled-back save releases its number, so gaps are rare and allowed.
- Prefixes end with a non-digit (review round 1), so numbers of two prefixes never collide past 7 digits (`A` + `10000001` against `A1` + `0000001`); tested at the padding boundary (`A9999999`, then `A10000000`).
- The backfill locks its batch `FOR NO KEY UPDATE` (review round 1): its updates touch no key column, and `FOR UPDATE` conflicted with the `KEY SHARE` lock a create's foreign-key check takes on a backfilled row while that create held the counter, a deadlock (reproduced as 40P01 and a 500; a deterministic test now interleaves the two).
- API: the number is an ordinary text value (`"number": "INC0001001"`), filterable and sortable as text; metadata has `autoNumber: { prefix }`.
- Backfill: adding an auto-numbered field to an existing table plans a `backfill` step (the kind 1.5 reserved), run by the coordinator after the main transaction: batches in `id` order, each its own transaction, the keyset cursor stored in the step's details after each batch, then a final sweep; probe and resume follow the other step kinds. Backfilled rows keep their version and get no change entry [judgment: the number is assigned as if it had always been there]. `schema/step-spec.ts` was split out of `steps.ts` to break an import cycle.

### Deadlocks and serialization failures (review round 1)

`inRequestTransaction` reruns the whole request transaction on SQLSTATE 40P01 or 40001, 3 times with a jittered backoff from 20 ms, before it answers a 500 (`transient-retry.test.ts`). Rerunning is safe because a request transaction does nothing outside the database before it commits: the body is read before the transaction; post-commit actions (the outbox wake-up) are registered with `afterCommit` and run only after the outermost commit; recording the served revision for the header overwrites one value; password hashing and token generation are computation, and a rerun generates a new token whose first copy was rolled back; responses are built after the transaction, never streamed from it. Config commits keep their own retry (1.4).

### Admin editing (plan Step 2)

Roles, access rules, choices and layouts are written through the generic record routes as one-operation change sets (revision and journal grow by one); user-role assignments are data (a `core.change` entry, no revision). No product change was needed; `admin-config-editing.test.ts` pins it.

## Tests

| Test | What it proves | Can-fail evidence |
| --- | --- | --- |
| `metadata-filtering` | Alice, Bob and Ada get exactly their readable fields, states and choices; no rule input, condition or hidden table; a hidden table is byte-identical to a missing one; Bob's body is byte-identical (apart from `schemaRevision`) when a hidden field's label, rule 10's literal or a hidden table changes; platform tables show only writes the server accepts, checked against a real create per platform table | platform-table limits removed: the loop finds `core.change` creatable for the admin while the server refuses it |
| `record-schema-property` | for generated tables over every implemented 6.5 type (with bounds, max lengths, hidden choices, a child subset, a retired field, read-only, defaults, an auto-numbered field), generated create and update bodies give the same verdict per field from the server (HTTP `ValidationFailed`) and `validateRecord` on the served metadata, as an admin and as a restricted user; only server-only reasons may differ | `rulesOfMetaField` dropping `readOnly`, or the metadata builder dropping the choice subset: the property fails with a shrunk counterexample |
| `table-metadata` (access), `record-schema`, `ui-config` (definitions) | builder, recordSchema and definition rules in isolation |  |
| `auto-numbers` | prefixes, a child's own sequence, read-only, history; 40 concurrent creates give 40 distinct numbers across a parent and child sharing a prefix; backfill numbers existing rows per concrete class, leaves versions and `core.change` alone, resumes from its cursor, `doctor` exits 0 | counter always inserting 1, or no row lock in the backfill batch: duplicates found |
| `choices`, `stale-choices` | subsets through child and parent endpoints, hidden keys, preflight and `doctor`; `choicesChanged`; filter literals |  |
| `layouts` | layering through a set and its upgrade, whole-layout override and convergence, inheritance, rename survival, retire and purge, refusals on both paths |  |
| `admin-config-editing` | the generic admin pages' writes |  |
| `table-openapi` | real responses and accepted bodies validate against the per-table document (ajv) | 14 validation errors against the round-0 document |
| `transient-retry` | a deadlock in a request transaction is rerun, not a 500 | without the retry the request is a 500 |
| `auto-numbers` (round 1) | a backfill batch and a create referencing its rows never deadlock; digit-ending prefixes refused; the 7-digit boundary | `FOR UPDATE` in the batch: 40P01; with digit-ending prefixes accepted, `A10000000` equals `A1` + `0000001` |
| `stale-choices` (round 1) | a child's subset change leaves a stale parent create alone and refuses child creates and updates through the parent | reach including descendants for creates: the parent create is 409 |
| `authz-paths`, `stale-paths`, `no-bypass` | the two new endpoints for Alice, Bob and admin; malformed, unknown and older revisions; with the allow-all rules removed |  |

Every refusal in the new suites is checked to commit nothing with `committed-state.ts`. The metadata endpoints read only, so `error-fuzz` and `schema-fuzz` (which fuzz stored values in error bodies) gain nothing from them.

## API change for change-set clients

Drafts carry every property, nullable ones as `null` (as `default` and `helpText` always did), so change-set payloads change: an `addField` draft needs `numberPrefix` (`null` for an ordinary field) and a `setOverride` draft `choices` and `numberPrefix`. A v0.0.1 payload without them is `400 InvalidRequest`. Plain packages cannot use Effect-valued decoding defaults, and a silent default would differ from every other draft property, so clients send the keys; `examples/quickstart.sh` does (found by the quickstart CI step).

## Open items

- Form rules and the `form-state` endpoint (Step 3).
- The metadata cache keyed by role set, if measurements ask for it.
- Number assignment serializes concurrent creates of one prefix on the counter row; measure in the Step 4 benchmark rerun.
