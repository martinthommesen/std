# 0020. Web pages: the table list, related lists, history definitions and the allowed-records condition (Step 2, workstreams 2B and 2C)

Status: accepted, 2026-10-22 (workstream `ws/2b-web-pages`). Contracts 1.7, 3.6, 4.4, 4.5, 5.2, 6.1, 6.3, 6.4, 6.5, 7.4.

Plan Step 2, guarantee 2B: "The UI shows exactly what the API returns for the same caller and filter"; 2C: "A form never writes against definitions that changed in a relevant way"; and the item "Reference picker limited to visible targets and the field's allowed-records condition".

## Server and API

Code: `packages/values/src/field-type.ts`, `packages/definitions/src/{allowed-records,apply,dependencies,operation,set-file,set-resolve,set-upgrade,table-metadata,validate}.ts`, `packages/access/src/table-metadata.ts`, `packages/api/src/{metadata,records}.ts`, `packages/server/src/http/{metadata-handlers,stale-request,stale-scope}.ts`, `packages/server/src/records/{history-definitions,history-endpoint,read-query,read-records,save-pipeline,write-access,write-access-rules}.ts`, `packages/server/src/catalog/definition-revisions.ts`, `packages/server/src/schema/journal-kinds.ts`.

### What the web app codes against

| Shape | Where |
| --- | --- |
| `GET /api/v1/meta/tables` → `{ schemaRevision, tables: [{ name, label, creatable }] }`, sorted by name | `MetadataGroup.tables`; `TableListSchema`, `MetaTableSummarySchema` in `@std/definitions/table-metadata` |
| `MetaTable.relatedLists: [{ table, label, field, fieldLabel }]` | `MetaRelatedListSchema` in `@std/definitions/table-metadata` |
| history entry `fields: { <name>: { label, type, choices } }`, keyed like `changes` | `HistoryFieldSchema`, `HistoryEntrySchema` in `@std/api/records` |
| `GET /api/v1/tables/{table}/records?allowedFor=<sourceTable>/<field>` | `ListQuery.allowedFor` in `@std/api/records` |

### The table list (Contracts 6.1, 6.3)

- **One function for both endpoints** [judgment]. `summaryOf` in `@std/access/table-metadata` gives a table's name (only when `knowsTable`, and not purged), label and `creatable` (the class accepts writes, the generic write limits allow a create, the caller has a create decision that is not never). `tableMetadata` and `tableList` both call it, so a table is listed exactly when its metadata answers 200, with the same three values. Computing every table's full metadata for the list was rejected: it would compute field states and related lists the list does not show.
- **Retired tables** are listed, as their metadata is served (reads still work); purged tables are not.
- **Hidden tables never show**: the list is filtered by the same knowledge rule as `UnknownTable`, so it is byte-identical (apart from `schemaRevision`) when a hidden table is added, renamed or relabeled.
- **Revisions** are checked like the per-table metadata (`checkUnscopedRevision`): an older one is served, malformed is 400, one the database never had 409.
- Not cached, like metadata.

### Related lists (Contracts 6.3)

- For endpoint E, every active reference field whose target is E or one of E's ancestors can point at E's records. For each such field, declared on class D, the candidates are the classes of subtree(D) that the caller knows (`knowsTable`) and where the field is in the caller's visible schema (read `yes` or `perRecord`). A candidate is listed unless one of its ancestors at or below D is also a candidate: the most general table wins, because a parent endpoint lists its descendants' records [judgment]. In practice D itself qualifies whenever any descendant does, since D's readability is computed over the row-visible classes of its subtree; the rule stays general.
- `label` is the table's label and `fieldLabel` the field's effective label on that table (overrides applied), as that table's metadata shows them.
- System references (`created_by`, `updated_by`) are not listed [judgment]: every table has them, so a user's page would list every table.
- Order: table name, then field name.
- Filterability: every listed entry is in the caller's visible schema at its table, so `filter=<field> = "<id>"` resolves there. `authz-paths` sends that request for every related list of every table each caller can open, by bearer token and by cookie.
- Disclosure: a table enters only when the caller knows it and reads the field there, so nothing names a hidden table or field. The visibility rule is redundant with the knowledge rule for hidden tables (a table the caller has no allow on has no readable field), so both are kept; the can-fail run drops both.

### History definitions (Contracts 4.4, 4.5)

- Each entry gets `fields`, keyed exactly like `changes` (the field's current name), with `label`, `type` and `choices` at the entry's `schemaRevision`. Only fields in the entry's `changes`, so a restricted caller's entries hold no description of a field it cannot read [judgment: describing more would tell which fields exist].
- **How R is read.** One statement reads `core.definition_revision` up to the latest entry's revision for the changed fields, the classes of the record's concrete lineage, and the overrides and choices whose `fieldId` is a changed field. Per revision R the latest row at or before R of each definition forms a small `ConfigSnapshot`, and `effectiveField` on the record's concrete class gives the label and type exactly as metadata computed them at R (overrides at R applied). The same lookup as `stale-scope.ts`, without building the whole configuration at R.
- **Choices**: the field's live choices at R, hidden ones included, not narrowed by a child's subset [judgment: an old value may be any key the field had, and the panel needs its label]. A choice deleted before R is not listed; its key shows without a label.
- **Type**: `metaTypeOf` (the metadata form), so a reference or condition field names its table only when the caller knows that table now, by its current name, and a reference's allowed-records condition is left out [judgment: the type is immutable apart from that condition, and naming the table follows today's knowledge, like `changes` follows today's names].
- **Purged fields** (admin-only changes, 3.7) resolve at R like any field; their definition revisions are kept with the tombstone. A field with no revision at R (none is expected) is described as it is now.
- Cost: one extra statement per history read. Its `OR` over `effective ->> 'fieldId'` scans `core.definition_revision` (not measured; open item).

### The allowed-records condition (Contracts 6.5; plan Step 2)

The contracts named "the field's allowed-records condition" (7.4) without defining it. Defined here:

- **A type setting** [judgment]. `allowedRecords` on the reference type (`@std/values/field-type`), a condition AST with field IDs over the target class; absent or null is none. A type setting rather than a new field property, because `core.field.type` is already JSON (no migration, no catalog-load change, no added-property default for release compatibility: a `v0.0.1` type simply has no key), and because it describes what the field may hold, like `targetClassId`. `@std/values` cannot import condition schemas (the package order is values ← conditions ← definitions), so it holds `Json` there and `@std/definitions/allowed-records` decodes it.
- **Checked when stored** under the `filter` profile against the target class as system (`conditionProblems`, all fields, not the editor's view): field IDs exist and, when the condition is new or changed (`newConditions` now includes reference fields whose condition changed), are not retired; operators fit; literals convert; one hop; `me`, `now`. A malformed AST is `invalidCondition`.
- **May change after the field exists** [judgment, as asked]. `type` joined `UPDATABLE.field`; `immutableProblems` refuses any type change but this setting (`sameTypeApartFromAllowedRecords`), so the target, kind and other settings stay fixed. A set upgrade may change it too (`checkExisting` compares types without it). It is not overridable locally on a shipped field in v0.1 [judgment: an override of the whole `type` property would also pin the target and settings; open item].
- **Stale relevance**: a change of it is `settingsChanged`: the stale check compares type JSON with the kind unchanged (`stale-request.ts` already did), and the journal kinds now say `settingsChanged` instead of `typeChanged` when a type keeps its kind.
- **Dependencies** [judgment, as suggested]: `condition_reads` edges from the reference field to each field the condition reads, like stored access-rule and subscription conditions. So a field it reads cannot be purged while the reference field is not retired, and retiring such a field is allowed and reported; the stored condition keeps evaluating the retired field (5.2), so the limit does not silently open.
- **Set files** carry it as access-rule conditions are carried there, a JSON AST with field IDs (`type: { kind: reference, target: <table>, allowedRecords: <AST> }`) [judgment: set files carry no condition text syntax anywhere; adding a text form for one setting would make two formats]. Resolved, planned, installed and upgraded in `definitions/test/allowed-records.test.ts`.
- **Writes**: `checkReferences` passes the field's condition to `WriteAccess.visibleTargets`; `RuleWriteAccess` compiles it with `compileAllowedRecords` over the target relation, in the caller's view (`compileInView`: masked expressions, a never-readable field NULL, hops guarded by target visibility), and ANDs it to the target's visibility in the same statement. Refusal is `InvalidReference`, byte-identical to an unknown ID. Only written values are checked (3.9), so an unchanged readable value is kept, like an unchanged hidden choice key; a value the caller cannot read counts as written, as for the visibility check. `WriteAccess.allowAll` (bootstrap, the system's own loads) does not apply it [judgment: those writes bypass access rules too; imports in Step 3 run as the importing user].
- **Context**: `me` and `now` resolve as for filters (`timeZoneFor("filter")`, the instance zone until users have one).
- **Fails closed**: a condition that no longer checks against the snapshot, or does not decode, compiles to `FALSE` (nothing allowed), like a stored access-rule condition (decision 0008).
- **Picker reads** (`allowedFor=<sourceTable>/<field>`): the source table resolves like an endpoint (`UnknownTable`); the field resolves like a write body's name, readable or writable at the source endpoint for create or update (`UnknownField`, identical to a missing field) [judgment: a picker fills a field the caller writes, which it may not read]; `InvalidRequest` naming `allowedFor` for a malformed value, a field that is not a reference, or an endpoint that is neither the target class nor a descendant [judgment: a descendant narrows the picker to a child class; an ancestor would list records the write refuses, and the condition's fields may not exist there]. The condition is compiled over the endpoint's relation with the endpoint's class (its fields are the target's lineage's, which a descendant has too) and joins `a<n>` aliases, so it never collides with the filter's `f<n>`. It applies to the page and to `count`. A field without a condition adds nothing.
- **Stale scope**: `allowedFor`'s field is in the request's scope on its own table (`staleScope`'s `classByName`, only for tables the caller knows, so a hidden source table adds nothing and the list answers `UnknownTable`).
- **Metadata does not say a condition exists** [judgment]: the picker always sends `allowedFor`, so the flag buys nothing, and the existence of a limit on a field is configuration a caller does not need. `metaTypeOf` builds the reference type from `kind` and `target` only, so neither metadata, the per-table OpenAPI document nor history descriptors carry it.
- **Non-interference**: the picker list and the write check depend on hidden values only through masks, so for Bob a condition on `cost` behaves as if `cost` were empty, and changing a hidden value changes nothing he sees (`allowed-records` test).

### Tests

| Test | What it proves | Can-fail evidence |
| --- | --- | --- |
| `authz-paths` "the table list holds exactly the tables whose metadata each caller gets..." | for Alice, Bob and the admin, by bearer and cookie: the list equals the set of tables (every class of the database plus a missing one) whose metadata answers 200, with equal name, label and `creatable`; every other is `UnknownTable`; hidden platform tables absent for Alice and Bob; every related list accepts its filter; no session is 401; nothing committed | the list built from every class (hidden ones with `creatable: false`): "bearer alice: expected [...24 tables] to deeply equal [...4]" |
| `metadata-filtering` | related lists per caller and endpoint (asset, laptop, admin's hidden `site.vault`); Bob's asset and laptop metadata and table list byte-identical while a hidden table gains a reference to assets, a new hidden table with one appears, and the hidden table is relabeled and renamed; Alice, given read on it, then sees `site.strongroom.asset_ref` and the table in her list | the list without the filter: byte identity fails; related lists without the knowledge and readability checks: Bob's asset metadata changes |
| `table-metadata` (access) | related lists on every acme endpoint for Alice, Bob and admin (one entry, on the declaring table), `owner` on Bob's `core.user` |  |
| `stale-paths`, `no-bypass`, `api-cache` | the table list and a picker list: malformed, never-had and older revisions; with the allow-all rules removed only `core.user` is left and a picker list is `UnknownTable`, while a local copy of the rules opens the non-platform tables; `no-store` by bearer and cookie |  |
| `history-definitions` | after a field rename, a field relabel and a choice relabel between two saves, the first entry describes the field with its old label and old choice label, the second with the new ones, both keyed by the current name; `cost` has neither change nor description for Bob; a purged field is described for the admin; every entry's `fields` keys equal its `changes` keys | descriptions read from the current configuration instead of R: "expected { type: { kind: 'choice' }, ... } to deeply equal {...}" |
| `allowed-records` (definitions) | decoding; stored checks (unknown field, malformed, wrong literal type, `changed`); change of the condition allowed, target or kind refused, a new condition naming a retired field refused; `condition_reads` edges, retire allowed, purge refused; set file round trip (resolve, install, upgrade to a changed condition) |  |
| `allowed-records` (server) | picker list equals the plain list filtered by the condition, with counts, for Alice, Bob and the admin through `acme.asset`, `acme.laptop` and `acme.monitor`; a write outside the condition (update and create) is `InvalidReference`, byte-identical to a random ID, committing nothing (`committed-state.ts`); an unchanged value kept after the condition changed, a new one refused; a condition on `cost` empties Bob's picker and refuses his write of L (cost 1200) while Alice sees K, L and S, and changing L's cost changes nothing Bob sees, while `not (cost > 1000)` lets him see all his assets; `allowedFor` errors (malformed, not a reference, ancestor endpoint, hidden table identical to a missing one, hidden field identical to a missing one); a condition change after R is `settingsChanged` for a picker built at R, a plain list naming `name` stays 200; metadata never shows the condition | write check without the condition: the update outside it returns 200 and two more tests fail; picker without the condition: count 5 against 4, Alice's list `['Alice monitor', 'K', 'L', 'M', 'S']`; condition compiled over bare columns instead of masks: Bob's picker is not empty and his write of L succeeds (`{ picked: false, written: 200 }`); stale scope without `allowedFor`: the stale picker returns 200 instead of 409 |

### Open items

- A local override of a shipped reference's allowed-records condition (needs per-setting overrides of `type`).
- The condition is not applied by `WriteAccess.allowAll`; Step 3's imports must apply it in the importing user's view (Contracts 7.4).
- The history definitions lookup scans `core.definition_revision` for overrides and choices; add an expression index on `effective ->> 'fieldId'` if Step 4 measures it.

## Web app

(to be written by the web workstream)
