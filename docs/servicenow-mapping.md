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
| ACL evaluation order: table ACLs from the most specific (`incident.field`, `incident.*`, `task.field`, …, `*.*`) down, the first matching level decides, then roles, condition and script must all pass | Every applicable rule is collected at once: the record's concrete class, its ancestors and `*`; field rules on a class cover its own and inherited fields (3.2). Any applicable deny refuses, otherwise any allow grants. | No "most specific wins": a broad deny cannot be overridden by a narrower allow, and a broad allow is not shadowed by a narrower rule. Both record and field decisions are needed to read a value (3.2). |
| Row-level and field-level ACLs both evaluated per record | Record decision compiled into `WHERE`, field decisions into masks | Same outcome per record, computed in Postgres in one statement (3.5). |
| `security_admin` elevation, "Elevate role" | none | No elevated mode: admin rights are rules, and a deny applies to admins too. |
| Impersonation (`Impersonate user`) | none | Deliberately absent in v0.1: every request acts as the session's own user. The system user acts only for bootstrap and definition loading and can never sign in or hold a session. Rules that run as another identity need the `rules.run_as` permission (Step 3, 4.1). |
| `snc_internal` (implicit role of internal users) | `authenticated` | Held by every active user, never assigned; inactive users hold nothing. |
| Role `contains` roles | none in Step 1 | Flat roles; groups and nested roles come in Step 3. |
| Granting a role elevated privileges (`elevated_privilege`) | Permissions granted to roles (`core.role_permission`), checked by permission ID | v0.1: `schema.purge`, `schema.snapshot`, `rules.run_as`; admin holds none implicitly (`schema_purger` holds `schema.purge`). |
| `sys_user` delete | Refused for every caller by a built-in deny | Users are deactivated (`active = false`), which ends their sessions; labels naming them keep resolving. |
| System tables (`sys_*`) editable by admins through forms and the Table API | Platform tables (definitions, journal, `core.change`) readable by admins, never written through the generic record routes | Definitions change only through change sets (1A routes generic writes to them); history is written only by the save pipeline. Only core rules match platform tables: an app or local `*` rule never reaches them, and one naming them is refused. |
| `GET /api/now/ui/user/current_user`-style session info | `GET /api/v1/auth/me` | The session's user ID and effective roles. |

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
| REST API Explorer, OpenAPI specs of scripted REST APIs | `GET /api/v1/openapi.json` (OpenAPI 3.1) and the typed client `@std/api/client` | Generated from the one `HttpApi` definition the server routes from, so they cannot drift. |

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
| Business rules (before, after, async) | Hook points `beforeWrite`, `afterWrite` (Step 3); async ones run from outbox deliveries (4.1, 4.6) | Before and after hooks are seams until Step 3; the outbox producer is live (see below). |
| Audit (`sys_audit`), History Sets (`sys_history_set`, `sys_history_line`) | `core.change`: one change entry per version, deletes included, written in the save transaction | Field values keyed by field ID with the schema revision; password and secret values never appear. |
| Audit enabled per table / dictionary attribute `no_audit` | Always on | History is a fixed pipeline step, not a configurable rule. |
| History list (`sys_history_line` via the related list) | `GET /api/v1/tables/{table}/records/{id}/history` | Only fields the caller can read now; child-only fields through any endpoint; deleted records and purged fields admin-only. |
| `sys_mod_count` bumped per update | `version`, bumped by exactly 1 per save, and the delete takes the next version | A no-op save (nothing readable changed) writes nothing. |

## Async business rules, events and outbound integrations (Contracts 4.6, 4.7)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Async business rule (`sys_script`, `when = async`), scheduled as a `sys_trigger` job after the transaction | Subscription (`core.subscription`) plus a delivery row per change, written in the save transaction; the worker runs the effect (Step 3) | A delivery exists exactly when the save committed: no job is lost to a crash between commit and scheduling, and none runs for a rolled-back save. |
| Event registry (`sysevent_register`) and `gs.eventQueue()` from a business rule | Subscriptions match changes directly: class (with descendants), operations (`create`, `update`, `delete`) and a condition | No script fires events; the save pipeline evaluates every enabled subscription in step 9, so configuration cannot forget to queue one. |
| Event queue (`sysevent`), processed by the event processor in creation order | `core.delivery`, claimed per subscription with `FOR UPDATE SKIP LOCKED` | Ordered per subscription and record by version, not globally (4.7). A row that commits late is still claimed: claims select by status, never by a sequence cursor. |
| Event `state` (`ready`, `processing`, `processed`, `error`) | `status` (`pending`, `in_flight`, `done`, `dead`) | `in_flight` carries a lease and a token; a worker that lost its lease cannot mark the row done or failed (fencing). |
| Business rule or event script condition (`current.state == 7`) | Subscription condition (condition AST, subscription profile) | Evaluated on the version's own image (the before image for a delete), with every field as system, `now` as the only context value and no dot-walking. |
| `current` / `previous` in an async rule | The change entry the delivery names (`change_id`), read at delivery time | A delivery stores IDs only; the payload is built from the change entry for the subscription's identity (Step 3), so a secret never sits in the queue. |
| Outbound REST message, IntegrationHub step, or Flow trigger "on record created/updated" | A subscription consumed by an after-commit rule or an integration (Step 3 and later) | External calls get `change_id` as their idempotency key; they are at least once, in-database effects exactly once (4.7). |
| Event retries, `sys_trigger` retry and error state | Backoff 10 s doubling to 1 h with jitter; `dead` after `max_attempts` (default 10) | Dead-letter policy per subscription: `block` (later versions of that record wait) or `skip`. Operators retry or discard dead rows (Step 3). |
| Run the async rule as the user who made the change (`gs.getUserID()` in the session) | The subscription's identity (`identity_id`), a fixed user | Payloads are filtered for that identity under current access rules (4.5). |

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
| Collision detection when committing an update set | conflicts recorded by `std upgrade` against local overrides (8.4) | Shipped values and local values are stored separately, so an upgrade never silently overwrites a local edit. |
| Update set commit as one big batch, partially applied on error | change set: all operations in one main transaction; nothing applies on any error | Follow-up steps finish after the commit; their progress is in the journal (`core.schema_change`, `core.schema_change_step`). |
| Update source and audit (`sys_update_xml`, `sys_audit`) | the journal: requester, source, each operation with target ID, kind, old and new name, change kinds, cascades and counts | Definition revisions (`core.definition_revision`) keep every definition as it was at each revision. |

## Schema changes over the API and cache invalidation (Contracts 1.2 to 1.5, 6.2, 6.4)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Creating tables and columns in Studio or the System Definition forms, captured in the current update set | `POST /api/v1/schema/change-sets` with a list of operations (`createNamespace`, `createClass`, `addField`, `setOverride`, `createRole`, `createAccessRule`, `rename`, `retire`, ...), applied as one change set (201) | All operations commit together or not at all; each names the version it was read at. `examples/quickstart.sh` creates its tables and its access rules this way. |
| Editing a `sys_dictionary` or `sys_security_acl` record through its form or the Table API | Generic `POST`, `PATCH` and `DELETE` on a definition table (`core.field`, `core.access_rule`, ...) | Each becomes a one-operation change set; `PATCH` of `name` is a rename, of `state` a retire or reactivate. |
| Update set progress and "Preview problems" | `GET /api/v1/schema/change-sets/{id}`: the journal entry and its follow-up steps | Readable by whoever may read `core.schema_change`. |
| Cache flush after dictionary changes (`cache.do`), nodes picking changes up at different times | Schema revision: every config commit takes the next revision; every request runs at exactly one revision; other processes reload on `std_config` | Every response carries `STD-Schema-Revision`. A client that sends the revision it was built at gets `409 SchemaChanged` naming the changed fields instead of writing against definitions that changed under it (6.4). |
| "Record has been modified by another user" on form submit | `If-Match` with the record's version; `409 VersionConflict` with the current version | Generic writes to definition records use `If-Match` too; on the change-set endpoint each operation names its `version`, and a stale one refuses the whole change set (`DefinitionInvalid`, `versionConflict`). |

## Retire versus delete (Contracts 1.6, 1.7)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Deleting a dictionary entry drops the column and its data | `DELETE` of a field, table or namespace definition is refused (`UseRetireOrPurge`) | An ordinary delete never destroys a column (1.4). |
| Making a field inactive / hiding it from forms | `retire`: the column and its data stay; the field is hidden from default selection, readable when selected explicitly (under access rules), and refuses writes (`DefinitionRetired`) | A retired required field becomes optional; `reactivate` brings it back optional with its values. A retired table accepts reads only. |
| — | `purge`: drops the column or table of a definition retired in an earlier revision | Needs the `schema.purge` permission (held by the built-in `schema_purger` role, not by `admin`), a confirmation naming the definition's ID and version, and no blocking dependents. The number of values or rows destroyed is journaled. A tombstone keeps ID, last name, type and label for history; the name is free again, the ID never. |
| Deleting a role referenced by ACLs leaves dangling references | deleting or retiring a role that an active access rule names is refused (`DependencyConflict`) | Every reference between definitions is in the dependency index (`core.config_dependency`), and refusals list each blocking dependent by ID, kind and name (1.7). |

## Configuration layers and upgrades (Contracts 1.8, 1.9, 1.10, 8)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Update set (`sys_update_set`, `sys_update_xml`) moved between instances | Definition set: a versioned directory of YAML files in git, loaded by `std upgrade` as one change set per set | An install that keeps its own config in git packages it as its own app set (8.1). There is no export of ad-hoc admin changes; changes made in the UI stay local overrides. |
| Store app, scoped app (`sys_app`, `sys_scope`) | App set (owner layer `app`, naming its set) with its own namespace | `requires` replaces app dependencies; the app's namespace is reserved. Sets load core first, then apps in `requires` order. |
| Base system (out of the box) records, plugins | The `core` set, owner layer `core`, mostly protected | Protected core definitions accept only label and help-text overrides (1.8). |
| Customer update (`sys_update_xml` of a customized OOTB record) | Override (`core.config_override`): one row per changed property, with the shipped value at the time (`base_when_set`) | ServiceNow tracks a customized record as a whole; STD tracks single properties, so a shipped change to another property of the same record still applies. |
| Record ownership by `sys_scope`, "Customer" vs "System" changes | Owner layer `core`, `app` or `local` (8.1) | The layer never changes, except `adopt` of a record its set removed. |
| `sys_id` that stays the same across instances | Stable UUID written in the set file (1.1) | Diffs compare by ID only; a missing, duplicate or foreign ID refuses the set. |
| Upgrade "skipped records" (Upgrade History, "Skipped changes to review") | Conflict (`core.config_conflict`) with old shipped, new shipped and local values | A skipped record in ServiceNow means the whole new version was not applied. In STD only the conflicting property keeps the local value; every other shipped change applies. An override whose local value equals the new shipped value is dropped as `converged` instead of being reported. |
| Resolve skipped record: "Retain" / "Revert to base system" / "Merge" | `keep_local` / `take_shipped` / `replace` | `keep_local` also records that the new shipped value was seen (`base_when_set`), so the same conflict does not reopen on the next version unless the shipped value changes again. |
| Upgrade preview, Upgrade Monitor | `std upgrade --plan [--json]` | The plan lists migrations, per-set diffs, conflicts, converged overrides, removals, refusals and a "security changes" section (access rules, roles, permission grants). The real run with `--expect <hash>` applies exactly the reviewed plan. |
| Upgrade that deletes or deactivates OOTB records | Removed upstream: tables and fields retired (never purged), access rules deactivated, roles retired; `adopt` keeps one as local | A role that an active local access rule names refuses the upgrade at plan time; ServiceNow would leave the ACL pointing at a missing role. |
| Upgrade conflicts with a customer-created record of the same name | Name clash refused at plan time, naming the local definition | The admin renames the local definition (by ID, nothing that refers to it breaks) and reruns. |
| Instance upgrade applies platform changes online, node by node | Offline `std upgrade`: servers stopped, refused while a `std-server` session is connected (8.5) | Rolling upgrades need expand-and-contract rules and come later. |
| Instance clone, backup and restore (ServiceNow-operated) | `pg_dump` of the one STD database, restore, `std upgrade`, `std doctor` (8.6) | `docs/runbooks/upgrade-and-recovery.md`. |
| Instance Scan, health checks | `std doctor [--json]` (1.10): 16 read-only checks, exit 0, 1 or 2 | Checks the catalog against the definitions, config layers, journal, dependency index, protected core definitions and server settings; repairs are separate commands. |
| Dictionary entries that do not match the database ("dictionary out of sync") | `doctor` checks 2 to 5 | Missing, extra or mistyped columns, invalid indexes and constraints, orphans (reported, never dropped). |

## Installing an instance (Step 1 quickstart; decision 0016)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| A new instance, provisioned by ServiceNow (personal developer instance, `zboot`) | `docker compose up`: Postgres, then the one-shot `std upgrade` (platform migrations and the `core` set), then `std serve` | Migrations never run at server start (1.9); the server starts only after the upgrade exits 0. The compose image is for development; the release image comes in Step 4. |
| The `admin` user that a new instance ships with | `std bootstrap-admin`: creates one active user with the built-in `admin` role from `STD_ADMIN_LOGIN` and `STD_ADMIN_PASSWORD`, unless that login exists | Runs as the system user through the save pipeline (change entries included), once per login; it never resets a password. There is no default password in the server, only the quickstart's disposable demo one. |
| Creating users and assigning roles in `sys_user` and `sys_user_has_role` | `POST /api/v1/tables/core.user/records` (with `password`, hashed by the service) and `POST /api/v1/tables/core.user_role/records` | Ordinary records: access rules, history and the outbox apply. |
