# 0019. The helpdesk example and saved filters (Step 2, workstream 2D)

Status: accepted, 2026-10-22 (workstream `ws/2d-helpdesk`). Code: `examples/helpdesk/{v1,v2}`, `examples/helpdesk/src/seed.ts`, `packages/testing/src/helpdesk-fixture.ts`, `packages/definitions/src/{definition,operation,overridable,dependencies,validate,lifecycle,set-file,set-resolve,set-plan,set-upgrade,snapshot,upgrade-report,table-metadata}.ts`, `packages/access/src/{saved-filters,table-metadata}.ts`, `packages/server/src/platform/migrations/0009-saved-filters.ts`, `packages/server/src/auth/bootstrap-admin.ts`, `docker-compose.yml`. Contracts 1.1, 1.7, 5.10, 6.3, 6.3a, 8.2, 8.4.

Plan Step 2, guarantee 2D: "Layered UI config survives an app upgrade and renames", proved by "the helpdesk v1 to v2 upgrade test; renaming a helpdesk field used by a form layout, a list layout and a saved filter keeps all three working". The Step 2 gate runs its browser tests against the helpdesk.

## The helpdesk set

`examples/helpdesk` ships as an app set (`helpdesk`, layer `app`, requires `core`), version 1 in `v1/` and version 2, the current one, in `v2/`.

| Part | v1 | v2 |
| --- | --- | --- |
| `helpdesk.ticket` | `number` (auto-numbered, prefix `TKT`), `short_description` (display field, required), `description`, `status` (choice, required, default `new`), `priority` (choice, required, default `moderate`), `assigned_to` (reference to `core.user`), `customer_email`, `internal_cost` (decimal 10,2) | `assigned_to` renamed to `assignee`; new field `resolution_notes`; status `canceled` added; `in_progress` relabelled "Work in progress", `on_hold` "Waiting on caller" |
| `helpdesk.incident` extends ticket | `category` and `impact` (choices); overrides: prefix `INC`, status subset without `awaiting_approval` | `canceled` added to the subset |
| Layouts | form and list on both tables | the incident form gains a "Resolution" section, the incident list `impact` |
| Saved filters | incident: `my_open`, `unassigned`, `critical_open`; ticket: `costly` (reads `internal_cost`) | `unassigned` and `critical_open` also exclude `canceled` (`my_open` lists the open statuses, so a new closed status never reaches it); the upgrade applies the changed conditions, which no local override touches |
| Role `agent` | label "Agent" | label "Helpdesk agent" |
| Access rules for `agent` | read every ticket; create; update while assigned to the caller or to no one (both states, 3.9); every ticket and incident field; deny `internal_cost` for read, create and update | new: deny reading `customer_email` unless the ticket is assigned to the caller |

Administrators use the built-in `admin` role. The restriction is real in both kinds Contracts 3.4 knows: `internal_cost` is never readable for an agent, `customer_email` (v2) conditionally.

Demo users: `admin` (built-in `admin`), `agent` and `agent2` (`agent`), and six records (five incidents, one ticket) owned by the two agents or unassigned. They are created by `seedHelpdeskDemo` (`@std/testing/helpdesk-fixture`) through `ensureUser`, which is `std bootstrap-admin`'s code generalized to any roles: as the system user through the save pipeline, idempotent by login, never changing an existing user. Records are added only to an empty helpdesk, so the seed reruns safely. Passwords are the disposable demo credentials in the fixture unless `HELPDESK_ADMIN_PASSWORD`, `HELPDESK_AGENT_PASSWORD` and `HELPDESK_AGENT2_PASSWORD` are set. Field values are written by field ID, so the seed fits both versions.

## Saved filters [judgment]

Saved filters did not exist. The plan's 2D test names one, so this adds the smallest version consistent with the contracts.

- **A config record.** `core.saved_filter` (migration 0009, described in the core set as a platform table): `table_id`, `name` (an identifier, unique among the table's live filters), `label`, `condition` (a condition AST, 5.2), stable ID, owner layer, state. A new definition kind `savedFilter` in `@std/definitions`, so it is layered like every config record: shipped in sets (`savedFilters` on a table entry, conditions as ASTs with field IDs like every set-file condition), written by admins through the generic routes or the change-set endpoint as one-operation change sets (`createSavedFilter`, `update`, `rename`, `delete`), covered by the schema revision, journalled and given definition revisions.
- **Conditions name fields by ID**, so renames never break a filter: the metadata prints the condition with the current names.
- **Validation.** The condition is checked when stored under the `filter` profile (5.10) against the table, with full access: all operators but `changed`, `me` and `now`, relative dates, one reference hop; a field of a child table or of an unrelated one is `invalidCondition` (422 `DefinitionInvalid`). Who may use it is decided where it is served.
- **Overridable** (8.2): `label`, and `condition` as one property, so a local edit replaces the whole condition, as a layout's element list. `name` is updatable like a role's (nothing refers to a filter by name) and follows the rename ownership rule; a new set version that clashes with a local filter's name on the same table is refused at plan time, like other name clashes.
- **Dependencies** (1.7): `saved_filter_on` (filter to its table) and `condition_reads` (filter to every field on every hop). Retiring a field a filter reads is allowed and reports the filter, like a layout or a stored condition; the filter is then no longer served (a retired field is refused in new filters). Purging that field is refused while the filter lives (`DependencyConflict`), as for any condition: unlike a layout entry, a condition that names a tombstone cannot run, so the admin deletes or edits the filter first. A table purge takes its filters along, like its layouts. A filter removed upstream is deleted (a tombstone), like a layout.
- **Served in metadata, never revealing a hidden field.** `GET /api/v1/meta/tables/{table}` gains the optional property `savedFilters`: the filters of the endpoint table and its ancestors (root first, then by name) that the list API would accept from this caller. Each is checked with the caller's filter view (`callerFilterView`: on every hop only fields of the caller's visible schema, on tables the caller knows, retired fields refused), the same view the list API's `filter` parameter uses, so a filter that names a field the caller cannot read is left out whole, exactly as one that names a missing field. Each entry carries `id`, `name`, `label`, `table`, the `condition` AST and `filter`, the condition in the text syntax with current names, which the list API takes as `filter` and which selects the same records (tested).
- **Backwards compatible.** `savedFilters` is optional in `MetaTableSchema` (the server always sends it), and nothing is added to any request schema. `v0.0.1` clients keep working (the release-compatibility step).
- **Not in v0.1:** personal (per-user) filters, ServiceNow's user filters and favourites, which are data rather than config; sharing filters with some roles only; a saved sort.

## The upgrade test (`helpdesk-upgrade.test.ts`)

v1 installed with `std upgrade`'s code; the admin overrides three shipped choices and the incident form layout; then v2. Checked: the plan's conflicts are exactly `in_progress`'s label and the layout's `elements`; `on_hold` converges (override dropped, `converged` entry); `awaiting_approval`'s `hidden` override stays (v2 ships it unchanged, so nothing is reported); the overridden layout stays effective whole, without v2's new section and field, while the list layout (not overridden) is v2's; the security section lists exactly the new access rule and the relabelled role; the run applies the plan; rerunning changes nothing, the revision included; `std doctor` (the command) exits 0 with the open conflicts as information. Upgrade reports now name choices, layouts and saved filters (`choice in_progress of helpdesk.ticket.status`, `form layout of helpdesk.incident`) instead of their IDs.

## The rename test (`helpdesk-rename.test.ts`)

Both kinds of rename, observed as a caller sees them through the metadata endpoint and the list API: the form and list layouts (`name@fieldId` per element), the saved filter (ID, condition AST, text) and the records its text selects.

- A shipped field: a helpdesk version whose only change is `assigned_to` to `assignee`. As the agent, every observation after equals the one before with the name replaced, and the old filter text is `UnknownField`.
- A local field: the admin adds `site`, puts it into both incident layouts (overrides of shipped layouts) and a local saved filter, sets it on two incidents, then renames it to `location` through the generic routes. The same equality holds for the admin and the agent.

## Runnable result

`docker compose up` loads the helpdesk by default (`std upgrade --set examples/helpdesk/v2`, then `std bootstrap-admin`, then `pnpm helpdesk:seed`); `STD_HELPDESK=0` leaves it out. Loading it by default makes the plan's runnable result literal ("`docker compose up`, sign in as `admin` or `agent`"). It does not clash with the quickstart: `examples/quickstart.sh` creates the `acme` namespace, the roles `asset_manager` and `employee` and the users `alice` and `bob`, and the first administrator stays `administrator`; the helpdesk uses its own namespace, role and logins.

## Browser test hooks

`helpdeskTestLayer()` (`@std/testing/helpdesk-fixture`) is a fresh test database with the core set, the current helpdesk version and the demo data; `HelpdeskFixture` gives the users (with their demo passwords) and record IDs, `HELPDESK` the stable IDs. A browser test points `std serve` at `TestDatabase.url`, as the shell test does with the acme fixture. `helpdesk-agent.test.ts` proves the agent's restrictions over the API on the same data.

## Tests and can-fail evidence

| Test | What it proves | Can-fail evidence |
| --- | --- | --- |
| `helpdesk-upgrade` | the 2D upgrade test above | on a conflict, merging the local layout with v2's new fields (instead of keeping it whole): the form layout has 11 entries instead of 6; letting the shipped value win on a conflict: `in_progress` reads "Work in progress", not "Working" |
| `helpdesk-rename` | the 2D rename test above | printing the served filter text with the names the filter was written with (`assigned_to`, `site`) instead of the current ones: both cases fail |
| `helpdesk-agent` | the agent's restrictions over the API; served saved filters select what their text selects; a canceled incident is in none of the "open" filters (review round 1: v2 first left `canceled` out of two exclusions) | serving filters through the full class view instead of the caller's: the agent's metadata contains `internal_cost` (the `costly` filter) |
| `saved-filters` | serving per caller, refusals through both write paths with nothing committed, retire reported, purge refused then allowed, table purge cascade |  |
| `helpdesk-seed` (example) | the seed reruns without adding or changing anything |  |
| `schema-http`, `platform-migrations`, `doctor-platform` | the new kind in the hidden-versus-missing matrices, migration 0009, the regenerated platform catalog |  |
