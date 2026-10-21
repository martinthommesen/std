# ServiceNow to STD mapping

For people who know ServiceNow: where its concepts land in STD, and where STD deliberately differs. Each step of the plan extends this file (architecture.md, "Workflow").

## Schema: dictionary changes

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

## Update sets versus change sets and definition sets

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Update set: records customer updates as XML and replays them on another instance | definition set: versioned YAML files loaded with `std upgrade`, each load one change set | Sets compare by stable ID and are idempotent; an unchanged set changes nothing, the revision included (8.3). |
| Collision detection when committing an update set | conflicts recorded by `std upgrade` against local overrides (8.4, workstream 1B) | Shipped values and local values are stored separately, so an upgrade never silently overwrites a local edit. |
| Update set commit as one big batch, partially applied on error | change set: all operations in one main transaction; nothing applies on any error | Follow-up steps finish after the commit; their progress is in the journal (`core.schema_change`, `core.schema_change_step`). |
| Update source and audit (`sys_update_xml`, `sys_audit`) | the journal: requester, source, each operation with target ID, kind, old and new name, change kinds, cascades and counts | Definition revisions (`core.definition_revision`) keep every definition as it was at each revision. |

## Retire versus delete

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Deleting a dictionary entry drops the column and its data | `DELETE` of a field, table or namespace definition is refused (`UseRetireOrPurge`) | An ordinary delete never destroys a column (1.4). |
| Making a field inactive / hiding it from forms | `retire`: the column and its data stay; the field is hidden from default selection, readable when selected explicitly (under access rules), and refuses writes (`DefinitionRetired`) | A retired required field becomes optional; `reactivate` brings it back optional with its values. A retired table accepts reads only. |
| — | `purge`: drops the column or table of a definition retired in an earlier revision | Needs the `schema.purge` permission (held by the built-in `schema_purger` role, not by `admin`), a confirmation naming the definition's ID and version, and no blocking dependents. The number of values or rows destroyed is journaled. A tombstone keeps ID, last name, type and label for history; the name is free again, the ID never. |
| Deleting a role referenced by ACLs leaves dangling references | deleting or retiring a role that an active access rule names is refused (`DependencyConflict`) | Every reference between definitions is in the dependency index (`core.config_dependency`), and refusals list each blocking dependent by ID, kind and name (1.7). |
