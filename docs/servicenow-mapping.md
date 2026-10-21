# ServiceNow to STD mapping

ServiceNow is STD's feature checklist, not its spec (plan, "Direction"). This file maps ServiceNow concepts to their STD counterparts as features land, so the later migration toolkit and anyone switching knows where things went. Each section names the contracts that define the STD side.

## Access control (Contracts 3)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| ACL (`sys_security_acl`) | Access rule (`core.access_rule`) | Config record with a stable ID and an owner layer, loaded from definition sets and covered by the schema revision. |
| ACL type `record`, operation `read`/`write`/`create`/`delete` | `target: records` with actions `read`, `update`, `create`, `delete` | ServiceNow's `write` is STD's `update`. |
| Field ACL (`table.field`) | `target: fields` with a field list | Field rules cannot use `delete`. |
| `table.*` field ACL | `fields: "*"` on a class | Covers the class's fields and its ancestors', never fields added by child classes (3.2). |
| `*` table ACL | `table: "*"` | A `*` rule cannot read fields in its condition. |
| ACL roles | `roles` (role IDs) | Flat roles in Step 1; groups in Step 3. |
| ACL condition | `condition` (condition AST, access-rule profile) | `me` and `now`; no dot-walking in Step 1. |
| ACL script | none | Deliberately absent: conditions are data, compiled to SQL. |
| Allow-if semantics (all matching ACLs evaluated, any passing grants) | Any applicable deny refuses, otherwise any applicable allow grants (3.2) | STD has explicit denies; ServiceNow emulates them with "deny unless" ACLs. |
| ACLs on parent tables apply to child tables | Rules on a class apply to its descendants' records | Decisions never depend on the endpoint (table) used. |
| `admin` role overrides ACLs | `admin` is an ordinary role with a built-in allow-all rule | Denies apply to admins too; no code checks a role name. |
| Query business rules / "before query" restrictions | Row visibility compiled into `WHERE` | Lists, counts, cursors and single reads all use it; nothing is filtered after reading. |
| "Number of rows removed by security constraints" | Not shown | Counts and pages come from the same restricted query (3.5). |
| Field hidden by ACL in a list | Key absent, name listed in `withheld` | A hidden value behaves like empty in filters and sorts (the masking rule). |
| `sys_user`, `sys_user_role`, `sys_user_has_role` | `core.user`, `core.role`, `core.user_role` | `authenticated` is held implicitly by every active user; deactivated users hold no role. |

## Record API (Contracts 2, 6)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Table API `GET /api/now/table/{table}` | `GET /api/v1/tables/{namespace.table}/records` | Fixed envelope `{schemaRevision, records, nextCursor, count?}`. |
| `GET /api/now/table/{table}/{sys_id}` | `GET /api/v1/tables/{table}/records/{id}` | A record outside the caller's visibility or the table's subtree is `404 NotFound`, identical to an unknown ID. |
| `sys_id` | `id` (UUIDv7) |  |
| `sys_class_name` | `class` (qualified table name of the concrete class) | Read-only. |
| `sys_mod_count` | `version` | One version per logical record, across all levels. |
| `sys_created_on`, `sys_created_by`, `sys_updated_on`, `sys_updated_by` | `created_at`, `created_by`, `updated_at`, `updated_by` | `created_by` is a reference to `core.user`, so it has a label. |
| `sysparm_query` (encoded query, `^`, `^OR`) | `filter` in the condition text syntax (`cost > 0 and status = "lost"`) | Names resolve against the caller's visible schema. |
| `ORDERBY`, `ORDERBYDESC` in the encoded query | `sort=-cost,name` | Ties always break by `id`. |
| `sysparm_fields` | `fields=name,docked_to.name` | One hop through references. |
| `sysparm_display_value=true` | `labels=true` | Labels come back next to values, never instead of them, and only where the caller may see the target's display field. |
| `sysparm_limit`, `sysparm_offset` | `limit`, `cursor` (keyset) | No offsets: pages stay stable while records change. |
| `X-Total-Count` header | `count=true` | Computed only on request, with the page's own `FROM` and `WHERE`. |
| Dot-walking (`caller_id.name`) | Reference paths (`owner.name`) | One hop in filters and selection; the target's visibility and masks apply on the way. |
| Table extension (`task` → `incident`) | Class inheritance with class-table storage | Through a parent table only its own and inherited fields are shown; child-only fields need the child's endpoint (2.3). |
| GlideRecord (`addQuery`, `orderBy`, `setLimit`, `query`, `next`) | The list endpoint (generic), the SDK (Step 4, typed) | Server code calls the record service; there is no unrestricted GlideRecord equivalent that bypasses access rules. |
| `GlideRecordSecure` | Every record-service read | Access rules always apply; the acting user is a required service. |
| Basic auth or OAuth on REST | `POST /api/v1/auth/sign-in`, `Authorization: Bearer <token>` | API tokens come in Step 3. |

## Record writes and history (Contracts 2.2, 3.9, 4, 6.7)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Table API `POST /api/now/table/{table}` | `POST /api/v1/tables/{table}/records` (201) | Creates a record of exactly the endpoint's class; the body holds field values only. |
| Table API `PATCH`/`PUT /api/now/table/{table}/{sys_id}` | `PATCH /api/v1/tables/{table}/records/{id}` | Requires `If-Match: "<version>"`: missing is `428 VersionRequired`, stale is `409 VersionConflict` with the current version. ServiceNow writes last-wins and has no precondition header. |
| `DELETE /api/now/table/{table}/{sys_id}` | `DELETE /api/v1/tables/{table}/records/{id}` with `If-Match` | Deletes the whole record (every level) through any table of its hierarchy; refused with `Referenced` while another record refers to it (no cascade, no clear in v0.1). |
| Writes through a parent table (`task` for an `incident`) | Writes through any endpoint whose subtree holds the record | Validated against the concrete class (its field overrides included); child-only fields need the child's endpoint. |
| Unknown or read-only fields in a write body are silently ignored | `UnknownField` (400) for names the caller cannot read or write; `ReadOnlyField` for `id`, `class`, `version`, audit and read-only fields (422) | All field errors come back together in `ValidationFailed`. |
| Mandatory and dictionary overrides (`sys_dictionary_override`) | Effective schema with tighten-only overrides (2.5) | Enforced on every write through any endpoint. |
| Write ACLs evaluated on the current record | Existing-state and proposed-state checks (3.9) | Both the record before and after the write must pass, like RLS `USING` and `WITH CHECK`; a failed proposed check rolls back. |
| Reference qualifier / invalid reference accepted | `InvalidReference` (422) | A target the caller cannot see is refused exactly like a missing one. |
| Business rules (before, after, async) | Hook points `beforeWrite`, `afterWrite`, deliveries (4.1) | Seams only until Step 3. |
| Audit (`sys_audit`), History Sets (`sys_history_set`, `sys_history_line`) | `core.change`: one change entry per version, deletes included, written in the save transaction | Field values keyed by field ID with the schema revision; password and secret values never appear. |
| Audit enabled per table / dictionary attribute `no_audit` | Always on | History is a fixed pipeline step, not a configurable rule. |
| History list (`sys_history_line` via the related list) | `GET /api/v1/tables/{table}/records/{id}/history` | Only fields the caller can read now; child-only fields through any endpoint; deleted records and purged fields admin-only. |
| `sys_mod_count` bumped per update | `version`, bumped by exactly 1 per save, and the delete takes the next version | A no-op save (nothing readable changed) writes nothing. |

## Schema: dictionary changes (Contracts 1)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Table (`sys_db_object`) | class, a row of `core.class`; one Postgres table per class (class-table inheritance) | A child class's table holds only its own fields; a record has one row per level (Contracts 2.1). |
| Dictionary entry (`sys_dictionary`) | field, a row of `core.field` | Field names are unique across a whole hierarchy, retired fields included (1.1). |
| Dictionary override (`sys_dictionary_override`) | override, a row of `core.field_override` | Tighten only: required and read-only only become true, max length and bounds only narrow (2.5). |
| `sys_id` | stable ID (UUID) of every definition and record | Definitions refer to each other by ID only; names appear only at the edges (1.1). |
| Column name change (rarely possible, often a new column) | `rename` by ID: `ALTER TABLE ... RENAME COLUMN`, catalog-only | Everything that refers to the field keeps working; the old name becomes unknown (no aliases). Generated index and constraint names never change. |
| Table rename (not supported for most tables) | `rename` of the class (`ALTER TABLE ... RENAME TO`) or of its namespace (`ALTER SCHEMA ... RENAME TO`) | Records keep their class by ID. |
| Changing a field's type | refused in v0.1 | Add a new field, copy values, retire the old one. |
| Dictionary change applied directly in the instance | a change set: one main transaction with a lock budget, then follow-up steps (`VALIDATE`, `CREATE INDEX CONCURRENTLY`) and `complete` | Every request runs at one schema revision; an interrupted change set resumes or is abandoned visibly (`std schema status | resume | abandon`). |
| Index added from the table's Database Indexes list | index definition; built `CONCURRENTLY` as a follow-up step on a table with rows | Uniqueness is promised only once the index is `enforced`. Dropping an index (`DELETE` of the definition) runs `DROP INDEX CONCURRENTLY`. |
| Out-of-box tables protected from changes (protection policies, read-only application files) | protected core definitions | Only label and help text may change, for everyone, admins included; the check lives in the schema service, not in access rules (1.8). |
| Extending a base table (`extensible` on `task`) | `extensible` core classes (`core.user`) and every app class | Local fields and local child classes are allowed there; platform tables are never extensible; the `core` namespace and app namespaces are reserved. |

## Update sets versus change sets and definition sets (Contracts 1.4, 1.5, 8)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Update set: records customer updates as XML and replays them on another instance | definition set: versioned YAML files loaded with `std upgrade`, each load one change set | Sets compare by stable ID and are idempotent; an unchanged set changes nothing, the revision included (8.3). |
| Collision detection when committing an update set | conflicts recorded by `std upgrade` against local overrides (8.4, workstream 1B) | Shipped values and local values are stored separately, so an upgrade never silently overwrites a local edit. |
| Update set commit as one big batch, partially applied on error | change set: all operations in one main transaction; nothing applies on any error | Follow-up steps finish after the commit; their progress is in the journal (`core.schema_change`, `core.schema_change_step`). |
| Update source and audit (`sys_update_xml`, `sys_audit`) | the journal: requester, source, each operation with target ID, kind, old and new name, change kinds, cascades and counts | Definition revisions (`core.definition_revision`) keep every definition as it was at each revision. |

## Retire versus delete (Contracts 1.6, 1.7)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Deleting a dictionary entry drops the column and its data | `DELETE` of a field, table or namespace definition is refused (`UseRetireOrPurge`) | An ordinary delete never destroys a column (1.4). |
| Making a field inactive / hiding it from forms | `retire`: the column and its data stay; the field is hidden from default selection, readable when selected explicitly (under access rules), and refuses writes (`DefinitionRetired`) | A retired required field becomes optional; `reactivate` brings it back optional with its values. A retired table accepts reads only. |
| — | `purge`: drops the column or table of a definition retired in an earlier revision | Needs the `schema.purge` permission (held by the built-in `schema_purger` role, not by `admin`), a confirmation naming the definition's ID and version, and no blocking dependents. The number of values or rows destroyed is journaled. A tombstone keeps ID, last name, type and label for history; the name is free again, the ID never. |
| Deleting a role referenced by ACLs leaves dangling references | deleting or retiring a role that an active access rule names is refused (`DependencyConflict`) | Every reference between definitions is in the dependency index (`core.config_dependency`), and refusals list each blocking dependent by ID, kind and name (1.7). |
