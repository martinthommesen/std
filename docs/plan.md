# STD platform core: plan

Status: revised 2026-10-20 after Martin's review. Nothing started yet. Awaiting Martin's sign-off.

**Goal of this milestone:** the platform core of an open source ServiceNow alternative. That means generic tables, records, forms, access rules and history that apps sit on top of, not a specific app. Long term, companies should be able to switch to STD when ServiceNow no longer fits or costs too much.

**Direction (Martin, 2026-10-20):** aim for feature parity with ServiceNow, but as a ground-up modern "2.0" without its quirks and tech debt. STD copies the functionality, not the look, names, URLs, API or query syntax. ServiceNow is the feature checklist, not the spec. Switching is handled later by a migration toolkit that maps ServiceNow data onto STD.

**Stack (chosen by Martin):** TypeScript + Effect 4 on Node 26, TypeScript 7 strict, pnpm monorepo, Postgres 18 through `@effect/sql-pg` behind STD's own SQL layer, a [Foldkit](https://foldkit.dev) + Vite web app (Martin, 2026-10-21, replacing React). See "Stack" and "Effect".

## How this plan is organized

- Five stages: Stage 0 (architecture spike), then Steps 1 to 4. Each stage has a gate: evidence that must exist, as passing CI tests or committed measurements, before the next stage starts. The gates use Martin's review table as their base.
- Each stage is split into workstreams. A workstream names one observable guarantee and the test that proves it. Workstreams replace the old "four PRs"; a workstream can take several PRs.
- Each PR names its workstream and adds or extends at least one of that workstream's proving tests, which pass in that PR. Code with no observable effect yet lands in the same PR as the first test that exercises it.
- Implementation detail lives in "STD core contracts". Its sections 1 to 8 match the eight points of Martin's review; section 9 covers the Effect toolchain. This plan points to sections by name.
- Each stage ends with something anyone can run on their own machine.
- Each completed step is tagged as a pre-release (`v0.0.1` after Step 1, and so on), so the Step 4 upgrade test starts from a real earlier release. [judgment]

## Stage 0. Architecture spike

**Purpose.** Prove the hardest assumptions together before the generic UI makes them expensive to change. The headline deliverable is Martin's: an inherited record can be read and updated safely through both parent and child endpoints by two differently authorized users. Shared versioning, TypeScript/SQL condition equivalence and the inheritance benchmark are proven in the same spike.

**Gate.** Inheritance, shared versioning, two-user authorization and TypeScript/SQL condition equivalence work together. Concretely, all of these pass in CI against Postgres 18:

- The two-user example (Alice, an asset manager; Bob, an employee) over `acme.asset`, `acme.laptop` and `acme.monitor`, through both parent and child endpoints: row visibility, field selection, filtering, sorting, reference labels and history, plus the non-interference property test. (Contracts 3.3 to 3.7.)
- Two-user write scenario on Bob's laptop: Bob updates `name` through `/acme.laptop` (200, version n+1). Alice, holding version n read through `/acme.asset`, updates `cost` and gets `VersionConflict` with nothing changed. Alice rereads through `/acme.asset` and updates `cost` (version n+2). Bob's update of `status` gets 403 through both `/acme.laptop` and `/acme.asset` (rule 9). Alice setting `purchased_on` to null through `/acme.asset` gets `ValidationFailed` (laptop override). Each user's history through both endpoints shows exactly versions 1..n+2, with no `cost` key for Bob.
- The inheritance invariant tests: one concrete class per record, no sibling membership, class changes refused, whole-record delete, one version per logical record. (Contracts: "Logical records and inheritance".)
- The differential property test for the spike's condition subset, and the exhaustive fold-table test. (Contracts: "Conditions, Acceptance tests".)
- The benchmark has run class-table storage at 1M and 10M records, and one table per hierarchy at 10M as the comparison baseline [judgment: it is the strongest alternative for the read queries]. The result is committed with the decision rule applied. The other two models are benchmarked only if class-table misses a budget or the baseline beats it by more than 2x. If the rule says "reopen", Stage 0 stops and Martin decides.
- Every item the contracts mark **[spike]** is confirmed, or the contract is changed in the same PR.

**Includes.**

- Repo, toolchain and CI (Contracts: "Effect toolchain").
- Class-table storage with `class_id`, level foreign keys, subtree checks, the class-change trigger and the root version.
- `core.user`, flat roles and password sign-in for the demo users.
- A minimal access-rule model loaded from definition files, and the rule-to-SQL compiler (visibility, masking, projection, existing and proposed checks).
- Reference fields with the label rule and one-hop paths (Contracts 3.6): FK with `NO ACTION`, refusing delete of a referenced target, the target-visibility guard.
- A minimal change entry per save, and the history endpoint with field-protected reads (Contracts 3.7), so the version invariant and history are tested through both endpoints.
- A condition subset: `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `in`, `empty`, `contains`, `and`, `or`, `not` over text (both case settings), integer, decimal, date, date-time and a one-hop reference, with the context value `me`.
- Stable IDs in the storage model from the start.
- Not included: the schema-change API, config layers, the outbox, UI, import.

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 0A Repo and toolchain | Every PR is type-checked with Effect stability diagnostics as errors and tested against a real Postgres 18 | Canaries: importing `effect/sql`, or stable `Effect`, from a plain package fails CI. Driver smoke test: rollback, nested saves without `SAVEPOINT`, LISTEN/NOTIFY with reconnect, `uuidv7()`, a dedicated connection, text-format reads of `numeric`, `int8`, `date`, `timestamptz`, the `TimeZone` and `DateStyle` session parameters, the exact allow-list entry strings, and that the `effect-tsgo patch` step does not write through pnpm hard links |
| 0B Logical records | A record has one concrete class, one version and one delete, whichever endpoint is used | SQL invariant tests as table owner; the two-user write scenario |
| 0C Two-user authorization | For fixed access-rule outcomes (which records are visible, which fields are withheld on each), Bob's rows, their order and the count depend only on values he can read; every write is checked against existing and proposed state | The non-interference property test, the two-user write scenario, and the Stage 0 tests listed below |
| 0D Condition equivalence | TypeScript and SQL return the same result for the same expression and data | Differential property test; exhaustive fold-table test |
| 0E Inheritance benchmark | The storage choice is measured, not assumed | `pnpm bench` reproduces the committed results table |
| 0F Platform probes | The Postgres behaviors the contracts rely on hold | See below |

Stage 0 tests from Contracts 3 "Acceptance tests": `rows-count`, `hidden-names`, `invisible-404`, `noninterference`, `masked-filter`, `hidden-rule-input`, `ownership`, `child-rule-parent-endpoint`, `child-fields`, `written-fields`, `field-rule-states`, `references`, `cursor-nulls`, `history`, `history-endpoint`, `two-user-write`, `referenced`, `fk-actions`. The `users` test (user deactivation and user delete), `platform-tables`, `no-bypass` and `error-fuzz` are Step 1.

0F probes:

- `begin_request()` cost while change sets commit, and request latency during a config commit while a 30 s request and a 2 s write batch are in flight.
- When the client of a concurrent index build is killed, the backend keeps its session lock until the build ends, then leaves either a valid index or a detectable invalid one. (Resume itself belongs to 1A.)
- Adding a class to a populated hierarchy under `lock_timeout`.
- `casefold` is IMMUTABLE and indexable.
- Boolean `ADD COLUMN ... NOT NULL DEFAULT false` on 1M rows leaves `relfilenode` unchanged, finishes under 100 ms [judgment] and does not increase `pg_stat_user_tables.seq_scan`.
- Write throughput at 16 clients with and without an in-transaction `NOTIFY`.

**Runnable result.** `docker compose up`, then `pnpm spike:demo`, which signs in as Alice and as Bob, prints what each sees and is refused through `/acme.asset` and `/acme.laptop`, and performs the two-user write scenario. `pnpm bench` reruns the benchmark.

**What happens to spike code.** Spike code is kept only if it meets Step 1 standards (contracts implemented as written, reviewed like any other PR). Otherwise it is rewritten in Step 1. Its tests are kept either way and become Step 1 tests.

## Step 1. Core

**Purpose.** Build the platform core that every later feature calls: versioned schema changes, the record service with minimal authorization, transactional history and the outbox's producer side, exact value representation, and shipped configuration that survives local edits.

**Gate.** Versioned metadata changes, protected definitions, record service, minimal authorization and transactional history. Concretely, these pass in CI:

- One revision per request under mixed load while 50 change sets commit; cross-process invalidation, including after the listener connection is killed.
- Interrupted schema change: SIGKILL of the coordinator at every step boundary and during a concurrent index build always ends completed, with `doctor` exiting 0.
- Retire, purge, role-dependency and protected-definition refusals through every API path.
- The two-user suite from Stage 0, extended to every read and write path, plus fuzzed error responses that never contain Postgres text.
- The version invariant property test: change entries for exactly versions 1..n per logical record, deletes included, through both endpoints.
- Outbox claim tests at SQL level: per-record version order across two transactions, and the sequence-cursor regression ("A's delivery row exists and is claimable after A commits").
- The fixture definition set upgrade v1 to v2 with local overrides and shipped roles: expected conflicts, converged overrides, the security-changes report, an idempotent rerun.
- `doctor` detects every seeded drift with the right exit code.
- The value codec tests for every type in Contracts "Field types", and the full differential test.

**Includes.**

- Schema lifecycle (Contracts 1): stable IDs, schema revisions, change sets, both advisory locks, `lock_timeout` with retry, the journal with resume and abandon, retire and purge, dependency checks, protected definitions.
- Minimal migration mechanism and `doctor` (Contracts 1.9, 1.10): forward-only platform migrations, run only by `std upgrade`.
- Config layering (Contracts 8.1 to 8.5): owner layers (`core`, `app`, `local`), shipped base plus local overrides, ordered set loading, conflict detection, `std upgrade --plan`. It belongs here because Step 1 already loads definition files.
- Record service and minimal authorization (Contracts 2, 3): the save pipeline, flat roles as config records with stable IDs, permissions granted to roles, access rules, password sign-in for every active user, built-in `admin`, `authenticated` and `schema_purger` roles.
- Reference fields extended (Contracts 3.6, 3.10): refusal through every API path, `created_by` labels.
- Transactional history (Contracts 4.1 to 4.5): one change entry per version, secret exclusion, definition revisions for reading old values.
- Outbox producer side (Contracts 4.6, 4.7): subscriptions as config records, delivery rows written in the save transaction, and the claim query tested at SQL level. Reason: the guarantee lives in the save path and the claim query, and it is cheap to test while there are few save paths. The worker comes with its first consumer in Step 3. [judgment]
- Field types and JSON (Contracts 6.5 to 6.7): the representation of every listed type is fixed now, including types implemented later. Implemented now: text, long text, integer, big integer, decimal, boolean, date, date-time, uuid, reference, password, json, condition.
- Conditions (Contracts 5): full AST and semantics, the filter profile, and a minimal access-rule profile (`me`, `now`).
- Schema revision header and `SchemaChanged` check (Contracts 6.2, 6.4); the shared `HttpApi` definition for sign-in and schema endpoints.
- Repo docs: decision notes and `docs/servicenow-mapping.md`, which every step extends.

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 1A Schema lifecycle | A request never sees two revisions; data is never destroyed without an explicit purge; every schema change completes or is visibly abandoned | One-revision-per-request load test; interrupted-build test with resume; purge refusal test |
| 1B Migrations, `doctor`, config layers | Shipped definitions load the same way every time, and an upgrade never silently overwrites a local value | Fixture v1 to v2 upgrade test; `doctor` drift test; migration guard and crash tests |
| 1C Record service and authorization | Every read and write path enforces access rules on the logical record | Two-user suite; non-interference property test; error-hygiene fuzz test |
| 1D Values and conditions | Every value round-trips exactly, and TypeScript and SQL agree on every condition | Codec tests; differential property test with coverage gate |
| 1E History and outbox producer | Exactly one change entry per version; no committed change is skipped by the claim query; claims follow per-record version order | Version invariant property test; SQL-level claim tests |

**Runnable result.** `docker compose up` (which runs `std upgrade` once), then `examples/quickstart.sh`: creates `acme.asset` and `acme.laptop` through change sets, adds laptops, renames and retires a field, signs in as two users and shows what each sees, prints a record's history, and ends with `std doctor` exiting 0. Tag `v0.0.1`.

## Step 2. UI

**Purpose.** Generic list and form pages driven entirely by runtime metadata, so the helpdesk example is built from definitions alone and behaves the same in the browser and the API.

**Gate.** The helpdesk example works through runtime metadata, including restricted fields and stale-form handling. Concretely, these browser tests pass in CI:

- `helpdesk` ships as an app definition set (`helpdesk.ticket`, `helpdesk.incident` extending it, an assignee reference, a status choice list, an `agent` role). An admin and an agent with restricted fields sign in, filter, browse and edit incidents.
- For the same filter, the UI list and the API return the same record IDs in the same order.
- A restricted field shows as restricted, never as empty, and never reaches the browser.
- A form opened before a relevant schema change gets `SchemaChanged`, keeps valid input, marks changed fields and never resubmits by itself. After a label-only change, the same save succeeds.
- The helpdesk v1 to v2 upgrade test passes with local overrides on a choice and a layout.

**Includes.**

- Foldkit and Vite web app, built from Foldkit UI's headless accessible components (`@foldkit/ui`), with generic list and form pages, related lists, and the history panel (old values rendered at each entry's schema revision).
- Point-and-click filter builder over the condition AST, including relative dates and `inPeriod`.
- Choice fields with labels, and choice-subset overrides on child classes.
- Form and list layouts as layered config records (a layout is overridden as a whole).
- Reference picker limited to visible targets and the field's allowed-records condition.
- Browser-safe metadata endpoint and the shared `recordSchema` builder (Contracts 6.3).
- Typed `HttpApiClient` for fixed endpoints; per-table OpenAPI document stating its revision.
- Auto-numbers with a per-table prefix, including a backfill step for existing rows.
- Roles, user-role assignments and access rules become editable by admins through the generic pages. Writes to config tables run as change sets (Contracts 1.4).

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 2A Metadata and validation | Metadata never contains what the user cannot read; browser and server give the same per-field verdict | Metadata filtering test; `recordSchema` property test |
| 2B Lists, forms, filter builder | The UI shows exactly what the API returns for the same caller and filter | Browser test comparing UI and API record IDs |
| 2C Stale forms | A form never writes against definitions that changed in a relevant way | Browser stale-write test, including rename then re-create of a field name |
| 2D Choices, layouts, numbers, helpdesk set | Layered UI config survives an app upgrade and renames | Helpdesk v1 to v2 upgrade test; renaming a helpdesk field used by a form layout, a list layout and a saved filter keeps all three working |

**Runnable result.** `docker compose up`, open the browser, sign in as `admin` or `agent` from `examples/helpdesk`. Tag `v0.0.2`.

## Step 3. Behavior and imports

**Purpose.** Behavior that admins configure without code, and a way to bring data in, both with explicit commit boundaries and concurrency-safe outcomes.

**Gate.** Deterministic rules, explicit commit boundaries, resumable imports and concurrency-safe reconciliation. Concretely:

- Rule order is deterministic (order number, then stable ID), and the same inputs give the same committed state.
- A failing after-write rule rolls back the whole transaction, nested saves included, even when hook code catches the nested failure.
- After-commit effects run only from the outbox. Their record writes commit in one transaction with the fenced `done` update, so killing the worker between the writes and `done` causes zero duplicate writes. External calls get `change_id` as their idempotency key.
- Outbox worker: the delivery soak test, and the lease-fencing test (a worker paused past its lease cannot mark the delivery done or failed, and n+1 is claimed only after n is done).
- Rules and hooks follow the concrete class: resolving an incident through `/helpdesk.ticket` without resolution notes is refused.
- Import resume: killing the runner after batch 3 of 10 ends with one record per source row, one result per row and no duplicate identity mappings.
- Concurrency: the match-key race ends with exactly one record; a concurrent user edit to a mapped field is reported as a conflict under `skip`.
- Re-importing an unchanged 10,000-row file creates no versions, change entries, deliveries or rule runs.
- Grouped and one-row-at-a-time imports are equivalent, and no `SAVEPOINT` appears in the statement log. Equivalent means equal field values, versions, change-entry field maps and row results, compared after mapping generated IDs by source row and ignoring timestamps and operation IDs.
- The helpdesk example uses rules to fill in fields and to require resolution notes when an incident is resolved.

**Includes.**

- Record rules on the three hook phases: before-write, after-write, after-commit (Contracts 4.1). After-commit rules are the first real outbox consumer.
- The outbox worker (Contracts 4.6): claim, leases with fencing, backoff, dead letters, an admin view.
- Form rules (conditional required, read-only, hidden) with browser evaluation that can return Unknown, and the form-state endpoint (Contracts 5.8, 6.3).
- Groups, nested roles, roles from group membership; API tokens; explain mode; an access-rule editor built on the filter builder; `myGroups` in conditions; one reference hop in access-rule conditions.
- CSV and JSON import with source systems and the external identity mapping, matching, field-level conflict detection, reference resolution, jobs with batches, checkpoints, resume, reports and dry run (Contracts 7).
- `RecordService.saveBatch` (Contracts 7.7).

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 3A Hooks and record rules | Rules run in a fixed order inside defined commit boundaries, chosen by the concrete class | Rule-order test; after-write rollback test; incident-through-ticket test; renaming a field that a record rule reads and writes keeps the rule working |
| 3B Outbox worker | Per-record delivery order holds under crashes and lease expiry; in-database effects happen once | Soak test; lease-fencing test; crash-before-`done` test |
| 3C Form rules | The browser never guesses; the server's verdict is binding | Browser soundness property test; form-state test |
| 3D Identity and access admin | Explain mode names the rule that decided, and agrees with enforcement | Property test comparing explain output with enforced decisions [judgment] |
| 3E Import reconciliation | Imports are resumable, re-runnable and safe under concurrent edits | Resume, match-key race, concurrent-edit and unchanged re-import tests |
| 3F Bulk save | Grouping is never observable | Equivalence test; no-`SAVEPOINT` test |

**Runnable result.** `examples/helpdesk/import.sh` imports a sample CSV twice (second run all `unchanged`), then the browser shows rules filling fields and requiring resolution notes. Tag `v0.0.3`.

## Step 4. Release (v0.1)

**Purpose.** Ship v0.1.0 with measured performance and proven upgrade, backup and recovery paths.

**Gate.** Measured import and query performance, upgrade test, backup restoration and recovery documentation. Concretely:

- A 100,000-row import on the reference machine: total time recorded, every batch commits in under 2 s, no `SAVEPOINT`.
- The benchmark reruns at 10M records with Q1 to Q7 and W1 to W3 issued through the record service (STD-generated SQL, unrestricted and restricted callers) and meets the Contracts 2.6 budgets.
- Release upgrade: from `v0.0.3` with helpdesk, 10,000 records with history and customizations, the candidate's `std upgrade` leaves `doctor` exiting 0, content checksums unchanged except where a documented migration changes them, every customization effective, and exactly the expected conflicts open.
- Backup and restore: a `pg_dump` taken under load during a change set's follow-up phase restores into an empty Postgres 18; the change set completes, auto-numbers continue, sign-in works, and outbox consumers that dedupe by change ID apply each repeated delivery once.
- Restore then upgrade: a `v0.0.3` backup restored and upgraded reaches the same state as the release upgrade test.
- The recovery runbook (interrupted schema change, failed or waiting index build, dead letters, paused imports) is executed by CI, so documented commands cannot drift from the code.

**Includes.**

- COPY only if the import measurement requires it (Contracts 7.8).
- Docker image on ghcr.io with the web app built in, OpenTelemetry tracing and a metrics endpoint.
- Docs site with the contracts, the ServiceNow mapping, backup and recovery runbooks.
- Schema snapshot endpoint and SDK codegen CLI (Contracts 6.8).
- Final public project name and npm scope.
- Tag `v0.1.0` and label good-first-issues.

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 4A Performance | Published numbers are reproducible | Committed import and benchmark results, rerunnable by script |
| 4B Upgrade | An existing install with data and customizations upgrades safely | Release upgrade test |
| 4C Backup and recovery | A restore, and an interrupted change, end in a consistent, usable install | Backup-restore drill; restore-then-upgrade test; runbook in CI |
| 4D Packaging, docs, SDK | What we ship matches what we tested | Image smoke test; SDK golden-file test |

**Runnable result.** `docker run` of the v0.1.0 image, or `docker compose up` from the release, then the helpdesk example and import script.

## Stack

- Runtime and tooling: Node 26, TypeScript 7 strict, pnpm workspace. On 2026-10-20 Node 26 is Current; it is scheduled to enter LTS on 2026-10-28 ([Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)). TypeScript is pinned to 7.0.2, the first stable 7.x on npm ([TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
- Server: Effect 4 (`HttpRouter` for generic table routes, `HttpApi` for fixed platform endpoints), Effect services and typed errors, spans exported over OpenTelemetry.
- Database: Postgres 18 through `@effect/sql-pg`, behind STD's own SQL layer. CI tests Postgres 18 only. Postgres 19 is at RC 1, so support for it is added after its release, in its own PR. [judgment]
- Validation: Effect Schema, built at run time from definitions, shared by server and browser.
- Web app: [Foldkit](https://foldkit.dev) (Elm Architecture on Effect: Schema Model, pure `update`, Commands and Subscriptions as Effects) with [Foldkit UI](https://foldkit.dev/ui/overview) components and Vite, chosen by Martin on 2026-10-21 in place of React. Effect runs the whole web app, not only Schema and the typed client. Foldkit pins `effect` and `@effect/platform-browser` to exactly 4.0.0 as peers; STD keeps one 4.0.5 copy (see `AGENTS.md`, "Frontend: Foldkit").
- Tests: vitest with `@effect/vitest` against a real Postgres 18.
- Code layering: definitions, the condition engine and access-rule evaluation are plain packages (Effect Schema only); only the server package uses the rest of Effect. A CI import check enforces "Schema only", and the stability diagnostics enforce the unstable-API allow lists (Contracts 9).
- Node runs one thread per process, so CPU-heavy work (big imports, large exports) runs in worker processes.

## Effect

**Decision: keep Effect 4.** Reason: typed errors, services and structured concurrency fit a platform whose correctness depends on transactions and background work.

What we accept:

- Effect 4.0.0 was published on 2026-10-01 (UTC); the current release is 4.0.5. The 4.x line has bug fixes until September 2029 or one year after 5.0, whichever is later ([Effect 4.0](https://effect.website/blog/releases/effect/40)).
- STD's whole server layer, and the typed client, sit on APIs tagged unstable: `effect/sql`, `effect/http`, `effect/http-api`, `effect/observability`, `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` and `@effect/vitest`. Only Effect core and Schema core are stable. Unstable APIs may change in minor or patch releases ([Effect 4.0: The First Week](https://effect.website/blog/effect-4-first-week)).
- `@effect/sql-pg` has no COPY. Adding COPY later means a second driver outside Effect's `SqlClient`.
- Coding models mostly learned Effect 3.

**Leaving Effect is a substantial migration, not a server-layer rewrite.** Keeping parsing, conditions and access-rule evaluation pure reduces coupling, but service composition, transactions, cancellation, error handling and background processing would all be rewritten. We plan as if we stay.

**Upstream safeguards, adopted** (details in Contracts 9):

- `@effect/tsgo` is the one TypeScript 7 binary for editor and CI, with `unstableApiUsage`, `experimentalApiUsage`, `outdatedApi`, `obsoleteSchemaImport`, `duplicatePackage` and `floatingEffect` set to error.
- Each package's tsconfig carries its own `allowedUnstableApis` list. Plain packages have empty lists. The shared API-definition package allows only `effect/http-api` and `effect/http`, which the typed client needs; the web app also allows `@effect/platform-browser`, which Foldkit's runtime needs. Experimental APIs are allowed nowhere.
- Stability diagnostics flag only unstable imports, so a separate CI import check limits plain packages to Effect Schema.
- Each allow-list entry has a one-line reason in the Effect decision note.
- Effect's runtime packages are pinned to one exact version through a pnpm catalog and upgraded together. `@effect/tsgo` is pinned separately and upgraded in its own PR.
- A short idiom guide in AGENTS.md points at the upstream diagnostics and at the AGENTS.md and ai-docs shipped in the `effect` package. Effect's source is vendored at the tag that matches the lockfile.

**Measured review, at every stage gate.** Tracked from Stage 0 in a small log kept in the repo. A completed feature is a workstream whose guarantee test passes on main. The thresholds below are proposals for Martin [judgment]:

| Measure | How it is counted | Review threshold |
| --- | --- | --- |
| Upgrade effort | Engineer-hours per Effect upgrade PR, plus breakages inside allowed unstable modules | More than 8 hours for a patch or minor upgrade |
| Effect-attributable defects | Defects whose root cause is Effect behavior or an Effect API change, per completed workstream | More than 1 per completed workstream on average, over two consecutive gates |
| Agent rework rate | Share of agent PRs sent back for Effect 3 idioms or Effect misuse | More than 30% over a stage |

Crossing a threshold triggers a decision by Martin at that gate, not an automatic switch. Options are containment (fewer allowed unstable modules, thin wrappers) or a planned migration.

## Decisions this plan locks in (defaults, change any)

| Decision | Default | Why it matters now |
| --- | --- | --- |
| Server language | TypeScript + Effect 4 on Node 26, chosen by Martin (see "Effect") | Every line of Stage 0 depends on it |
| License | Apache-2.0, signed-off commits, no CLA. AGPL-3.0 instead if blocking closed hosted copies matters more than easy company adoption | Hard to change once others contribute |
| How data is stored | Postgres 18, typed columns, namespaces as Postgres schemas, UUIDv7 IDs. Class-table inheritance: each class has its own table for the fields it adds, sharing the record's `id`; the root row holds the concrete class, the single version and the audit fields. For: the 1,600-column cap applies per table; every class is a real foreign-key target; unique constraints work at any level; data reads with plain SQL. Against: joins grow with depth; a filter on one level with a sort on another cannot use one index; writes touch one row per level; adding a class briefly locks every ancestor. Considered: one table per hierarchy (no joins, but the whole hierarchy shares the column cap and needs a field-to-column map), one table per hierarchy partitioned by class (keys must include the class), and one table per concrete class with all inherited fields (child reads hit one table, but parent endpoints need UNION ALL, and there is no real foreign key or unique constraint across the hierarchy). The Stage 0 benchmark keeps or reopens this. Result (`docs/decisions/0004-storage-benchmark.md`): the rule is formally not met, because every storage model misses the Q6 and Q7 budgets; the baseline is never more than 2x faster. Q2 misses in every model under concurrent load. Q3 and Q4 miss only in class-table under load (every alternative passes them) and met their budgets in a quieter run: the storage-specific risk. Provisional decision: keep class-table storage, pending Martin's confirmation. The read compiler's branch form (rule OR split into index-friendly UNION ALL branches) meets Q6 and is a requirement for ws/0c-reads and the Step 4 rerun. Q7 still misses (53.2 ms p95 at best) | Very hard to change once real data exists |
| Configuration ownership | Every config record, roles included, has a stable ID and an owner layer (`core`, `app`, `local`); shipped values and local overrides are stored separately, and upgrades open conflicts instead of overwriting | Step 1 already loads shipped definitions that admins will edit |
| Import identity | An external identity mapping keyed by source system, source table and source record ID, with no source ID field on records | One field cannot hold IDs from several systems |
| Deletes | Every reference refuses deletion of its target in v0.1; only the storage links between a record's own inheritance rows cascade | Database cascades would change records without hooks, authorization or history |
| Project name | STD stays the code name. Pick the final public name, and check that a matching npm scope is free, before v0.1.0. Internal packages use a placeholder scope until then | Names are awkward to change after the first release |

## Deliberately later

- Changing a field's type on a table that holds data.
- Clear-on-delete and cascading deletes, as audited record-service operations that authorize each affected record.
- Changing a record's class, as a dedicated record-service operation.
- Outbox consumers beyond rules: webhooks (and their payload contract), search indexing, an optional pull feed, and backfill for new subscriptions.
- History retention, and erasure of a purged field's values from history (with data-protection work).
- History of deleted records for non-admins.
- Selecting child-only fields through a parent endpoint.
- Rolling upgrades, high availability, clustering, multi-tenancy, other databases.
- Accent-insensitive search; field types such as duration, currency, multi-choice, attachment, rich text, comment and internal-note logs.
- Migration toolkit: a ServiceNow importer, and an optional ServiceNow-compatible API adapter.
- Scripting: JavaScript or TypeScript checked against generated types, run in a locked-down process behind one protocol, reading and writing through the record service as a known user.
- Flows, approvals, SLAs, notifications, email and scheduled jobs, on a Postgres-backed engine over versioned definitions. Effect's workflow module is an option, not a commitment.
- Real apps: full incident, problem, change, catalog, knowledge and CMDB.
- App packaging beyond definition sets: data in sets, transformations, a distribution channel.
- SSO (OIDC and SAML), LDAP, MFA, impersonation.
- Reporting, dashboards, search UI, portal, mobile, translations, GraphQL.

## Known risks

- Every config commit briefly pauses all requests (one global lock). Per attempt, the pause is bounded by the `CONFIG_KEY` wait (200 ms) plus a 2 s lock budget for the whole attempt plus the main transaction's own work. `lock_timeout` applies to each lock separately, so the budget is enforced by taking every table lock a DDL statement needs explicitly with `LOCK TABLE` under the remaining budget, from a per-form lock inventory that a CI guard keeps complete (Contracts 1.4). The budget covers all contention from application traffic and STD itself. Locks the DDL takes internally on indexes and system catalogs cannot be taken in advance; only direct index or catalog maintenance (`ALTER INDEX`, `REINDEX`, amcheck, `VACUUM FULL` or `CLUSTER` of a catalog) contends them, each such wait is capped at the remaining budget computed when its statement started, and an attempt's lock-wait time is at most the budget × (1 + N), N counting contended internal acquisition attempts (reacquisitions included), with ordinary transaction work on top. Do not run index or catalog maintenance during schema changes. Accepted for v0.1 and measured in Stage 0 (decision 0007). Per-table locking is the fallback.
- Many `ALTER TABLE` forms take `ACCESS EXCLUSIVE`, and a waiting lock request queues later conflicting requests behind it, plain reads included [checked: `waitMask` test in src/backend/storage/lmgr/lock.c, REL_18_STABLE]. Short lock timeouts with retry bound the wait. Adding a reference field locks writes to the target table briefly, which matters for `core.user`.
- Postgres limits: 63-byte identifiers, and 1,600 columns per table with dropped columns still counted. `doctor` warns at 1,400.
- Adding a class briefly locks every ancestor table. The fallback design (a stored class path) is in the contracts.
- The benchmark may reopen the storage decision after Stage 0.
- Restricted list requests depend on the read compiler, not storage. Stage 0 measured Q6 at 10M at 300 ms p95 in the plain form and 1.1 ms in the branch form. On a referencing endpoint, the branch form is correct only when the request filters on the target. Q7 (a reference filter behind the target's visibility guard, about 0.4% of tickets) stays at 53.2 ms p95 even with serial execution and a covering index. In one run, rule-shaped `OR` predicates also made Postgres's generic plans about 5x slower than custom plans. Mitigations: the branch form, per-statement plan settings, and a decision on Q7 (`docs/decisions/0004-storage-benchmark.md`).
- Class-table Q3 and Q4 (a filter on one level, a sort on another) run at about 50 ms p50 at 10M. They met the 50 ms p95 budget in a quiet run and missed it (58 ms) under concurrent load on the shared host, where every other storage model passed them. Unlike Q2, Q6 and Q7, these misses are specific to class-table. The Step 4 rerun needs a quiet or dedicated machine to settle them.
- STD's server layer sits on unstable Effect APIs, the driver is young, and agents default to Effect 3. See "Effect".
- TypeScript 7.0 has no programmatic API, so tools that embed the compiler stay on TypeScript 6 until 7.1.
- Outbox delivery is blocked per record by a dead letter under the default policy, and writes one row per matching subscription per change.
- A Postgres major upgrade with newer Unicode data can change case-folding results. The upgrade procedure checks the fold table version and reindexes.
- With its own names and API, STD needs a mapping step for anyone switching from ServiceNow. `docs/servicenow-mapping.md` records it from Step 1.
