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
