# STD platform core: plan

Status: revised 2026-10-20 after Martin's review; re-staged 2026-10-22 for Martin's TM Forum, ODA and ITIL requirement (decision 0021), and signed off by Martin on 2026-10-22 with every open decision accepted as recommended. Stage 0, Step 1 (`v0.0.1`) and Step 2 (`v0.0.2`) are done; Step 3 is next.

**Goal of this milestone:** the platform core of an open source ServiceNow alternative. That means generic tables, records, forms, access rules and history that apps sit on top of, not a specific app. Long term, companies should be able to switch to STD when ServiceNow no longer fits or costs too much.

**Direction (Martin, 2026-10-20):** aim for feature parity with ServiceNow, but as a ground-up modern "2.0" without its quirks and tech debt. STD copies the functionality, not the look, names, URLs, API or query syntax. ServiceNow is the feature checklist, not the spec. Switching is handled later by a migration toolkit that maps ServiceNow data onto STD.

**Standards (Martin, 2026-10-22, hard requirement):** strict TM Forum, ODA and ITIL compatibility on everything, from Step 3 on (decision 0021):

- STD's own generic API follows the TMF630 REST API Design Guidelines (Contracts 10).
- Standard TMF Open APIs are shipped as mappings onto STD tables, and each passes its conformance gate in CI: TMF621 Trouble Ticket, TMF632 Party, TMF669 Party Role, TMF672 User Roles and Permissions, TMF688 Event with the hub/listener pattern, TMF638 Service Inventory, TMF639 Resource Inventory, TMF641 Service Ordering and TMF622 Product Ordering (Contracts 11, 12).
- The ITIL practices behind them are incident, problem, change enablement, service request and service configuration management. Their behaviors are tested like any other guarantee (Contracts 14).
- STD is packaged as ODA Components, and CI deploys them on the open source ODA Canvas (Contracts 13).

Where the standards and ServiceNow differ, the standards win. ServiceNow stays the feature checklist. `v0.0.2` ships the generic UI as planned, and the requirement applies from Step 3.

**Stack (chosen by Martin):** TypeScript + Effect 4 on Node 26, TypeScript 7 strict, pnpm monorepo, Postgres 18 through `@effect/sql-pg` behind STD's own SQL layer, a [Foldkit](https://foldkit.dev) + Vite web app (Martin, 2026-10-21, replacing React). See "Stack" and "Effect".

## How this plan is organized

- Six stages: Stage 0 (architecture spike), then Steps 1 to 5. Steps 3 to 5 were re-staged on 2026-10-22 (decision 0021): the old Step 3 items are split between Step 3 and Step 4, and the old Step 4 (release) is now Step 5. A contract that says "Step 4" for a release item means Step 5. Each stage has a gate: evidence that must exist, as passing CI tests or committed measurements, before the next stage starts. The gates use Martin's review table as their base.
- Each stage is split into workstreams. A workstream names one observable guarantee and the test that proves it. Workstreams replace the old "four PRs"; a workstream can take several PRs.
- Each PR names its workstream and adds or extends at least one of that workstream's proving tests, which pass in that PR. Code with no observable effect yet lands in the same PR as the first test that exercises it.
- Implementation detail lives in "STD core contracts". Its sections 1 to 8 match the eight points of Martin's review; section 9 covers the Effect toolchain; sections 10 to 14 cover the standards (TMF630, the TMF Open API mappings, events, ODA Components and ITIL practices). This plan points to sections by name.
- Each stage ends with something anyone can run on their own machine.
- Each completed step is tagged as a pre-release (`v0.0.1` after Step 1, and so on), so the Step 5 upgrade test starts from a real earlier release. [judgment]

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

## Step 3. Behavior, the TMF630 API and the ITIL helpdesk

**Purpose.** Behavior that admins configure without code, with explicit commit boundaries; STD's own API reworked to TMF630; events delivered to TMF listeners from the outbox; and the helpdesk rebuilt as ITIL incident and problem management behind TMF621. The new requirement applies from this step (decision 0021).

**Gate.** Deterministic rules, explicit commit boundaries, a TMF630-conformant generic API with every Step 0 to 2 guarantee intact, events at least once and in per-record order, and the first TMF Open API passing its conformance kit. Concretely, in CI against Postgres 18:

- Rule order is deterministic (order number, then stable ID), and the same inputs give the same committed state.
- A failing after-write rule rolls back the whole transaction, nested saves included, even when hook code catches the nested failure.
- After-commit effects run only from the outbox. Their record writes commit in one transaction with the fenced `done` update, so killing the worker between the writes and `done` causes zero duplicate writes. External calls get `change_id` as their idempotency key.
- Outbox worker: the delivery soak test, and the lease-fencing test (a worker paused past its lease cannot mark the delivery done or failed, and n+1 is claimed only after n is done).
- Rules and hooks follow the concrete class: an incident saved through `/api/v1/helpdeskTicket` gets the incident's derived priority and `resolved_at` (Contracts 14.1: ITIL requirements that TMF does not share are form rules, not API refusals).
- TMF630: every rule of Contracts 10 has a passing test in `tmf630-conformance`. The Contracts 3 acceptance tests, `error-fuzz`, `invisible-identity` and the stale-request tests run against the API and pass. For generated TMF queries, the equivalent condition-syntax filter returns the same IDs in the same order (`tmf-filter-equivalence`).
- One API (Martin, 2026-10-23; decision 0021, decision 56): the Step 0 to 2 API is deleted and the TMF630 API is `/api/v1`; the release-compatibility step upgrades a `v0.0.2` database and runs this branch's quickstart against it.
- Events: a listener registered through a hub receives one event per committed matching change, per record in version order, at least once, with an `eventId` stable across retries; never an event for a rolled-back save, for a record the registering user cannot see, of a type whose trigger fields that user cannot read on both images, or naming a field that user cannot read, also when rights change before delivery; events reach exactly the registered callback URL (`hub-delivery`, `hub-soak`, `hub-payload-filter`, `hub-event-authz`, `hub-callback-path`).
- TMF621: TM Forum's TMF621 CTK at the pinned version passes under the runner's criteria (Contracts 11.1: every expected mandatory case passed, nothing failed, skipped or pending, a fresh report from the pinned image; `ctk-runner` proves the runner on bad reports), and every TMF621 response validates against the pinned OpenAPI document (`tmf-oas-contract`). TMF688 passes its OpenAPI contract tests (it has no CTK, Contracts 12.3).
- Aggregates and patches: a write of a ticket's note or party through any API changes the ticket's version, history and events in the same transaction; owner references never change; owners are settled to a fixed point and persisted once per transaction without recursive saves; record rules of every phase and action kind behave as Contracts 4.10 declares (`aggregate-race`, `aggregate-ownership`, `aggregate-finalize`, `record-rule-actions`, `aggregate-quantifiers`, `tmf-arrays`); a JSON Patch is evaluated against the locked version (`json-patch-race`).
- Requirements matrix (Contracts 15): `check-conformance-matrix --gate step3` passes for TMF630, TMF621, TMF688 and the Step 3 rows of Contracts 14, so every normative requirement of those specifications names a passing test or an exclusion Martin decided.
- Party foundation: every user has exactly one individual after the upgrade from `v0.0.2` (the `data` migration, rerun and kill-resume included), and every new user gets one; a server refuses to start while a `data` migration is incomplete, and `doctor` reports it (`party-foundation`, `data-migration-interrupted`).
- ITIL: a change of impact or urgency sets incident priority from the impact × urgency matrix for every cell through the generic API, TMF621 and the browser, an explicit priority in the same write wins, and the browser form shows priority read-only by default (Martin, 2026-10-22: TM Forum takes priority over ITIL; decision 0021, decisions 34 and 53); the incident and problem state models accept every transition of TMF621's life cycle and refuse every other transition outside Contracts 14; the forms require resolution code and notes, and a known error's workaround; resolving a problem returns its waiting incidents to work (`itil-incident`, `itil-problem`).
- The helpdesk set v2 to v3 upgrade (the ITIL rebuild) keeps every Step 2 incident, its history and the local overrides of the Step 2 upgrade test.
- Release safety (Martin, 2026-10-22; decision 0021, decisions 50 and 51): the server, worker and CLI reach a remote Postgres only over TLS with full verification (`db-tls`); the `v0.0.3` release image is signed with cosign by the release workflow, which verifies the signature before it publishes (`release-signature`); every platform migration declares its phase and every `expand` migration keeps the previous release working, checked on every PR (`migration-phases`, Contracts 8.8).
- ODA Canvas probe: a stub component is deployed on the pinned ODA Canvas on kind in GitHub Actions, and the measurements are committed (time, disk, failure rate over 10 runs). This step's gate needs the measurements, not a green deployment.

**Includes.**

- Record rules on the three hook phases: before-write, after-write, after-commit (Contracts 4.1). After-commit rules are the first real outbox consumer.
- The outbox worker (Contracts 4.6): claim, leases with fencing, backoff, dead letters, an admin view.
- Form rules (conditional required, read-only, hidden) with browser evaluation that can return Unknown, and the form-state endpoint (Contracts 5.8, 6.3).
- The API under `/api/v1` per TMF630 (Contracts 10): flat resources with `id`, `href`, `@type`, `@baseType` and `@schemaLocation`, EntityRef references, `fields`, TMF filtering mapped onto the condition AST, `offset`/`limit` and `after` cursors, `X-Total-Count` and `X-Result-Count`, merge-patch and JSON Patch, the TMF Error shape, hubs. It replaces the Step 0 to 2 API, which is deleted (decision 0021, decision 56); the web app, the quickstart, the examples and the per-table OpenAPI use it.
- Hub/listener on every API and TMF688 topics and events, with TMF688's own notifications (`EventCreateEvent`, `TopicCreateEvent`, `TopicChangeEvent`, `TopicDeleteEvent`), as an outbox consumer that calls registered callbacks (Contracts 12).
- The TMF Open API framework (Contracts 11.1): mapping a TMF resource onto a class subtree, attribute and state maps, embedded arrays as child records, polymorphic `@type`, the CTK runner and OpenAPI contract tests in CI.
- The party foundation in `core` (`core.party`, `core.individual`, `core.organization`, `core.user.individual`) with a `data` migration that gives every existing user an individual (Contracts 1.9, 11.3).
- Aggregate parts (Contracts 6.5, 11.1) and the requirements matrix with its CI check (Contracts 15).
- TMF621 Trouble Ticket over ITIL incident and problem management; the helpdesk set v3 rebuilt on it (Contracts 11.2, 14).
- The ODA Canvas probe (Contracts 13.6).
- TLS to Postgres and signed releases (Contracts 8.9), and the rolling-upgrade rules every migration follows from now on (Contracts 8.8, RU1 to RU12).

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 3A Hooks and record rules | Rules run in a fixed order inside defined commit boundaries, chosen by the concrete class | Rule-order test; after-write rollback test; incident-through-ticket test; renaming a field that a record rule reads and writes keeps the rule working |
| 3B Outbox worker | Per-record delivery order holds under crashes and lease expiry; in-database effects happen once | Soak test; lease-fencing test; crash-before-`done` test |
| 3C Form rules | The browser never guesses; the form-state verdict binds the browser form, and no form rule refuses an API write (Contracts 5.10, 14.1) | Browser soundness property test; form-state test; `form-vs-api` |
| 3G TMF630 generic API | Every generic route follows Contracts 10, and no Step 0 to 2 guarantee weakens on it | the TMF630 v5.0.0 rows of the requirements matrix; `tmf630-conformance`; `json-patch-race`; the Contracts 3 tests and `error-fuzz` on the API; `tmf-filter-equivalence` property test; browser tests on the API; release compatibility as a database upgrade |
| 3H Events and hubs | A listener gets exactly the committed changes it may read, per record in order, at least once, deduplicable by `eventId`, and no event whose existence reveals a field it cannot read | `hub-event-authz`, `hub-callback-path`, `hub-delivery`, `hub-soak` (worker killed mid-delivery), `hub-payload-filter`, `hub-unregister`; TMF688 OpenAPI contract tests |
| 3T TMF API framework and requirements matrix | A TMF API never shows or accepts more than the record service allows the caller; an aggregate changes whenever a part does; a mapped API passes its conformance gate; every normative requirement is tested or excluded by Martin | `tmf-noninterference` (the Contracts 3 hidden-field tests through TMF621); `aggregate-race`; `aggregate-ownership`; `aggregate-finalize`; `tmf-arrays`; `tmf-oas-contract`; `ctk-runner`; the CTK job; `conformance-matrix-check` |
| 3P Party foundation | Every user, old and new, has exactly one individual, so TMF621 names parties consistently; an interrupted backfill never goes unnoticed | `party-foundation` (backfill from `v0.0.2`, rerun, kill and resume, concurrent user creation); `data-migration-interrupted` |
| 3I ITIL incident and problem on TMF621 | ITIL behaviors hold the same through the generic API, TMF621 and the browser | TMF621 CTK; `itil-incident`; `itil-problem`; `helpdesk-v3-upgrade`; browser test of the incident form |
| 3K ODA Canvas probe | The Step 5 Canvas gate rests on measurements, not hope | Committed probe results: Canvas install time, disk use and failures over 10 runs on `ubuntu-latest` |
| 3R Release safety (new) | Data in transit to a remote Postgres is encrypted and verified; every release image (and from Step 5 the chart) is signed and verified before it is published; every migration written now can run under Step 5's rolling upgrades | `db-tls`; `release-signature`; `migration-phases` |

**Runnable result.** `docker compose up`, then the browser shows the ITIL helpdesk (rules computing priority and requiring resolution notes); `examples/helpdesk/tmf621.sh` opens, updates and resolves a trouble ticket through TMF621 while `examples/listener` prints the events it receives; `pnpm ctk tmf621` runs TM Forum's kit against the running server. Tag `v0.0.3`.

## Step 4. Identity, CMDB, orders and imports

**Purpose.** Parties, roles and permissions behind TMF632, TMF669 and TMF672; the CMDB behind TMF638 and TMF639; ITIL change enablement and service requests behind TMF641 and TMF622; and the import path that loads CMDB and party data, with concurrency-safe reconciliation.

**Gate.** Every TMF API of this step passes its conformance gate, the ITIL change and request models hold, explain mode agrees with enforcement, and imports are resumable and concurrency-safe. Concretely:

- TM Forum's CTKs at the pinned versions pass under the runner's criteria for TMF632, TMF669, TMF672, TMF638, TMF639, TMF641 and TMF622, every response validates against the pinned OpenAPI document, and `check-conformance-matrix --gate step4` passes for those specifications.
- Config events: a TMF672 hub receives role Create, AttributeValueChange and Delete events from change sets, generic definition writes and set loads, in each role's version order, and none from a change set that rolled back (`config-events`, Contracts 4.6).
- Party and roles: a user's TMF672 `PermissionSet`s equal its role assignments; a role created through TMF672 is the same `core.role` the generic API shows; a TMF672 write is refused exactly when the change-set path refuses the same change; `CheckPermission` agrees with enforcement (property test, as explain mode).
- Explain mode names the rule that decided and agrees with enforced decisions (property test).
- CMDB: a TMF639 `PhysicalResource` is a `cmdb.physical_resource` through every API; CI relationships keep referential integrity (a CI with relationships cannot be deleted); incidents, problems and changes reference CIs (`cmdb-relationships`).
- ITIL change enablement: standard changes skip authorization, normal changes cannot be scheduled before every required approval is given, emergency changes need the emergency change authority, a rejected approval rejects the change, and a completed change item updates the service it names in the inventory (`itil-change`, `change-updates-cmdb`).
- Service requests: a request whose catalog item needs approval waits in `pending` until approved; a rejected approval ends it `rejected`; cancellation through `CancelProductOrder` follows Contracts 14 (`itil-request`).
- Import resume: killing the runner after batch 3 of 10 ends with one record per source row, one result per row and no duplicate identity mappings.
- Concurrency: the match-key race ends with exactly one record; a concurrent user edit to a mapped field is reported as a conflict under `skip`.
- Re-importing an unchanged 10,000-row file creates no versions, change entries, deliveries or rule runs.
- Grouped and one-row-at-a-time imports are equivalent, and no `SAVEPOINT` appears in the statement log. Equivalent means equal field values, versions, change-entry field maps and row results, compared after mapping generated IDs by source row and ignoring timestamps and operation IDs.

**Includes.**

- Groups, nested roles, roles from group membership; API tokens; explain mode; an access-rule editor built on the filter builder; `myGroups` in conditions; one reference hop in access-rule conditions (moved from Step 3).
- Party roles in `core` and the TMF632, TMF669 and TMF672 adapters over the Step 3 party foundation and over STD's roles and access rules, with config subscriptions for role events (Contracts 4.6, 11.3).
- The `cmdb` app set and TMF638 and TMF639 (Contracts 11.4).
- Change requests, approvals, service requests and a minimal request catalog in the helpdesk set v4, behind TMF641 and TMF622 (Contracts 11.5, 14).
- CSV and JSON import with source systems and the external identity mapping, matching, field-level conflict detection, reference resolution, jobs with batches, checkpoints, resume, reports and dry run (Contracts 7), moved from Step 3: its first real consumers are CMDB and party loads.
- `RecordService.saveBatch` (Contracts 7.7), moved from Step 3.

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 4D Identity, parties and access admin (was 3D) | Explain mode and TMF672 `CheckPermission` name the rule that decided and agree with enforcement; TMF632, TMF669 and TMF672 change only what the change-set and record paths allow; role events are transactional | Explain property test [judgment]; CTKs for TMF632, TMF669 and TMF672; `tmf672-roles` (TMF672 and generic writes agree, refusals included); `config-events` |
| 4C CMDB | Every CI has one class and one identity through the generic API, TMF638 and TMF639; relationships keep referential integrity | CTKs for TMF638 and TMF639; `cmdb-relationships`; `@type` polymorphism test over the resource subtypes |
| 4O Change enablement and service requests | The Contracts 14.4 transition tables, approval invalidation, request derivation and cancellation rules hold through every API, and every concurrent outcome is one of those 14.4 lists | CTKs for TMF641 and TMF622; `itil-change` (every table cell, the concurrent outcomes with forced interleavings); `itil-request` (derivation property test, terminal guards); `approval-finality`; `change-updates-cmdb` |
| 4E Import reconciliation (was 3E) | Imports are resumable, re-runnable and safe under concurrent edits | Resume, match-key race, concurrent-edit and unchanged re-import tests |
| 4F Bulk save (was 3F) | Grouping is never observable | Equivalence test; no-`SAVEPOINT` test |

**Runnable result.** `examples/cmdb/import.sh` imports a sample CI file twice (second run all `unchanged`); `examples/helpdesk/change.sh` raises a normal change through TMF641, approves it and completes it, and TMF638 then shows the updated service; a service request through TMF622 waits for approval. Tag `v0.0.4`.

## Step 5. ODA Components and release (v0.1)

**Purpose.** Ship v0.1.0 as ODA Components that deploy on the ODA Canvas, with measured performance and proven upgrade, backup and recovery paths. This is the old Step 4 plus ODA.

**Gate.** Measured import and query performance, upgrade test, backup restoration, recovery documentation, and a Canvas deployment that passes the conformance kits through the Canvas gateway. Concretely:

- A 100,000-row import on the reference machine: total time recorded, every batch commits in under 2 s, no `SAVEPOINT`.
- The benchmark reruns at 10M records with Q1 to Q7 and W1 to W3 issued through the record service (STD-generated SQL, unrestricted and restricted callers) and meets the Contracts 2.6 budgets, with Q3 and Q4 measured on a quiet or dedicated machine (Martin, 2026-10-22). Q7 is reported against its budget and stays a known risk until one of the options in decision 0004 is chosen. A TMF list with `X-Total-Count` is measured too (Contracts 10.4).
- Release upgrade: from `v0.0.4` with the helpdesk and CMDB sets, 10,000 records with history and customizations, the candidate's `std upgrade` leaves `doctor` exiting 0, content checksums unchanged except where a documented migration changes them, every customization effective, and exactly the expected conflicts open.
- Backup and restore: a `pg_dump` taken under load during a change set's follow-up phase restores into an empty Postgres 18; the change set completes, auto-numbers continue, sign-in works, and outbox consumers that dedupe by change ID (hub listeners by `eventId`) apply each repeated delivery once.
- Restore then upgrade: a `v0.0.4` backup restored and upgraded reaches the same state as the release upgrade test.
- The recovery runbook (interrupted schema change, failed or waiting index build, dead letters, paused imports) is executed by CI, so documented commands cannot drift from the code.
- ODA: the component's YAML validates against the `oda.tmforum.org/v1` Component CRD; on kind with the pinned Canvas chart, the component reaches `Complete`, its exposed APIs are published through the Canvas gateway, the Canvas identity operator has created its Keycloak client with exactly the roles STD's TMF672 serves (and follows a role created afterwards), and every CTK of Steps 3 and 4 passes again through the gateway with Keycloak-issued tokens (`oda-canvas-deploy`). The Canvas BDD features for install, upgrade, uninstall, exposed APIs and permission specification sets pass with STD's chart as the component under test. `helm install` (bundled or external database, with and without `--wait`) starts no server or worker before this attempt's `std upgrade` has finished; a real `helm upgrade` from the previous release rolls: both releases serve side by side through expand, roll and finalize, and no request fails (`rolling-upgrade`, `expand-compat`, Contracts 8.8; decision 0021, decision 51); a failed expand leaves the old pods serving and the new ones waiting until a fixed new attempt completes (checked through Kubernetes in every mode, and as a Helm failure with `--wait`); going back before finalize is a `helm upgrade` of the older chart, after finalize a restore plus `helm upgrade`; and `helm uninstall` removes the component's APIs and Keycloak client and keeps the data (`oda-helm-lifecycle`, Contracts 13.1).
- `check-conformance-matrix --gate step5` passes for every pinned specification, the ODA Component CRD included.
- ODA security: a Keycloak token whose roles include `agent` gets exactly what a local `agent` session gets, through the generic API and TMF621 (the Contracts 3 hidden-field tests repeated with OIDC callers); a role the token names that STD does not know grants nothing.
- Release checklist: TMF630 v5 rules checked by a TM Forum member (Martin, 2026-10-22; decision 0021, decision 1). Met by 3G's matrix: its rows are checked against the v5.0.0 text Martin supplied, which is the baseline (decision 0021, decision 35); `check-conformance-matrix --gate step5` proves no TMF630 row is pending.

**Includes.**

- COPY only if the import measurement requires it (Contracts 7.8).
- Docker image on ghcr.io with the web app built in, OpenTelemetry tracing and a metrics endpoint (the component's management API).
- The ODA Component (Contracts 13): component YAML, a hook-free, signed Helm chart whose per-attempt Jobs run `std upgrade --expand` while the old pods serve and `std upgrade --finalize` once they are gone, with `RollingUpdate` Deployments whose new pods wait in init containers for that attempt's expand (works with and without `--wait`; the attempt ID can be supplied for GitOps), the three upgrade phases and the new startup ledger check (Contracts 8.8), recovery to an older version by `helm upgrade` before finalize and by restore and `helm upgrade` after it (no `helm rollback` after migrations), uninstall that keeps the data, password sign-in off by default under OIDC, OIDC bearer tokens from the Canvas identity provider, the Canvas deployment workflow.
- Docs site with the contracts, the ServiceNow and TM Forum mappings, backup and recovery runbooks.
- Schema snapshot endpoint and SDK codegen CLI (Contracts 6.8).
- Final public project name and npm scope.
- Tag `v0.1.0` and label good-first-issues.

**Workstreams.**

| Workstream | Guarantee it proves | Test that proves it |
| --- | --- | --- |
| 5A Performance (was 4A) | Published numbers are reproducible | Committed import and benchmark results, rerunnable by script; Q3 and Q4 on a quiet or dedicated machine; Q7 reported as a known risk |
| 5B Upgrade (was 4B) | An existing install with data and customizations upgrades safely, also while the previous release keeps serving | Release upgrade test; `expand-compat`; `rolling-upgrade` |
| 5C Backup and recovery (was 4C) | A restore, and an interrupted change, end in a consistent, usable install | Backup-restore drill; restore-then-upgrade test; runbook in CI |
| 5D Packaging, docs, SDK (was 4D) | What we ship matches what we tested | Image smoke test; SDK golden-file test |
| 5O ODA Component and Canvas | What the Canvas deploys is what CI tested, every exposed API is conformant behind the Canvas gateway, and chart upgrades roll without failed requests | `oda-component-schema`; `oda-canvas-deploy` with the CTKs through the gateway; `oda-helm-lifecycle`; the Canvas BDD features |
| 5S ODA security | The Canvas identity provider authenticates and assigns roles; STD alone decides access | OIDC versions of the Contracts 3 tests; `oidc-unknown-role`; Keycloak role sync test |

**Runnable result.** `docker run` of the v0.1.0 image, or `docker compose up` from the release, then the helpdesk and CMDB examples; or `helm install` of the component onto an ODA Canvas (`deploy/oda/README.md`). Tag `v0.1.0`.

## Stack

- Runtime and tooling: Node 26, TypeScript 7 strict, pnpm workspace. On 2026-10-20 Node 26 is Current; it is scheduled to enter LTS on 2026-10-28 ([Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)). TypeScript is pinned to 7.0.2, the first stable 7.x on npm ([TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
- Server: Effect 4 (`HttpRouter` for generic table routes, `HttpApi` for fixed platform endpoints), Effect services and typed errors, spans exported over OpenTelemetry.
- Database: Postgres 18 through `@effect/sql-pg`, behind STD's own SQL layer. CI tests Postgres 18 only. Postgres 19 is at RC 1, so support for it is added after its release, in its own PR. [judgment]
- Validation: Effect Schema, built at run time from definitions, shared by server and browser.
- Web app: [Foldkit](https://foldkit.dev) (Elm Architecture on Effect: Schema Model, pure `update`, Commands and Subscriptions as Effects) with [Foldkit UI](https://foldkit.dev/ui/overview) components and Vite, chosen by Martin on 2026-10-21 in place of React. Effect runs the whole web app, not only Schema and the typed client. Foldkit pins `effect` and `@effect/platform-browser` to exactly 4.0.0 as peers; STD keeps one 4.0.5 copy (see `AGENTS.md`, "Frontend: Foldkit").
- Tests: vitest with `@effect/vitest` against a real Postgres 18.
- Standards tooling (decision 0021): TM Forum's dockerized CTKs, downloaded in CI by pinned URL and digest; from Step 5, an ODA Component Helm chart deployed in CI on the ODA Canvas (pinned `canvas-oda` chart, kind with Kubernetes 1.30, Istio, Keycloak).
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
| How data is stored | Postgres 18, typed columns, namespaces as Postgres schemas, UUIDv7 IDs. Class-table inheritance: each class has its own table for the fields it adds, sharing the record's `id`; the root row holds the concrete class, the single version and the audit fields. For: the 1,600-column cap applies per table; every class is a real foreign-key target; unique constraints work at any level; data reads with plain SQL. Against: joins grow with depth; a filter on one level with a sort on another cannot use one index; writes touch one row per level; adding a class briefly locks every ancestor. Considered: one table per hierarchy (no joins, but the whole hierarchy shares the column cap and needs a field-to-column map), one table per hierarchy partitioned by class (keys must include the class), and one table per concrete class with all inherited fields (child reads hit one table, but parent endpoints need UNION ALL, and there is no real foreign key or unique constraint across the hierarchy). The Stage 0 benchmark keeps or reopens this. Result (`docs/decisions/0004-storage-benchmark.md`): the rule is formally not met, because every storage model misses the Q6 and Q7 budgets; the baseline is never more than 2x faster. Q2 misses in every model under concurrent load. Q3 and Q4 miss only in class-table under load (every alternative passes them) and met their budgets in a quieter run: the storage-specific risk. Decision (confirmed by Martin on 2026-10-22): keep class-table storage; Q3 and Q4 are rerun on a quiet or dedicated machine in Step 5, and Q7 stays a known risk until one of its options in decision 0004 is chosen. The read compiler's branch form (rule OR split into index-friendly UNION ALL branches) meets Q6 and is a requirement for ws/0c-reads and the Step 5 rerun. Q7 still misses (53.2 ms p95 at best) | Very hard to change once real data exists |
| Configuration ownership | Every config record, roles included, has a stable ID and an owner layer (`core`, `app`, `local`); shipped values and local overrides are stored separately, and upgrades open conflicts instead of overwriting | Step 1 already loads shipped definitions that admins will edit |
| Import identity | An external identity mapping keyed by source system, source table and source record ID, with no source ID field on records | One field cannot hold IDs from several systems |
| Deletes | Every reference refuses deletion of its target in v0.1; only the storage links between a record's own inheritance rows cascade | Database cascades would change records without hooks, authorization or history |
| Standards | Strict TM Forum, ODA and ITIL compatibility from Step 3, chosen by Martin (decision 0021): STD's generic API follows TMF630; TMF Open APIs are mappings onto STD classes, each gated by TM Forum's CTK at a pinned version (Contracts 11.1); STD ships as ODA Components tested on the ODA Canvas; ITIL 4 practice concepts, in STD's own words. STD's record service stays the one place that enforces access, history and the outbox, so a TMF API can never show or accept more than the generic API | Every later API, app and deployment decision depends on it |
| API versions and compatibility | One API: the TMF630 API is `/api/v1` from Step 3 and the Step 0 to 2 API is deleted (decision 0021, decision 56). TMF APIs live under `/tmf-api/{apiName}/v{major}` and keep their major version in the path | Releases upgrade databases; old clients are not supported |
| Authorization with ODA | STD stays the policy decision point for every record and field. The Canvas identity provider (Keycloak) authenticates users and may assign STD roles through token claims; STD publishes its roles to the Canvas through TMF672 | ODA security could otherwise move decisions out of STD's access rules |
| ODA packaging | One STD component per install for v0.1 (all exposed APIs in one component, one database), not split along TM Forum's golden components | ODA Components are meant to own their data; STD's one data model is its point (decision 0021) |
| Project name | STD stays the code name. Pick the final public name, and check that a matching npm scope is free, before v0.1.0. Internal packages use a placeholder scope until then | Names are awkward to change after the first release |

## Deliberately later

- Changing a field's type on a table that holds data.
- Clear-on-delete and cascading deletes, as audited record-service operations that authorize each affected record.
- Changing a record's class, as a dedicated record-service operation.
- Outbox consumers beyond rules and hub callbacks: generic webhooks with their own payload contract (the TMF event envelope of Contracts 12 is the one payload contract in v0.1), search indexing, an optional pull feed, and backfill for new subscriptions.
- History retention, and erasure of a purged field's values from history (with data-protection work).
- History of deleted records for non-admins.
- Selecting child-only fields through a parent endpoint.
- High availability beyond rolling upgrades, clustering, multi-tenancy, other databases. (Rolling upgrades moved into v0.1: Martin, 2026-10-22; decision 0021, decision 51.)
- Accent-insensitive search; field types such as duration, currency, multi-choice, attachment, rich text, comment and internal-note logs.
- Migration toolkit: a ServiceNow importer, and an optional ServiceNow-compatible API adapter.
- Scripting: JavaScript or TypeScript checked against generated types, run in a locked-down process behind one protocol, reading and writing through the record service as a known user.
- Flows, SLAs and service level management, notifications, email and scheduled jobs (auto-close of resolved incidents included), on a Postgres-backed engine over versioned definitions. Effect's workflow module is an option, not a commitment. Approvals in v0.1 are approval records driven by record rules (Contracts 14.4), not a flow engine.
- Full apps beyond the v0.1 ITIL scope (incident, problem, change enablement, service request and the CMDB at the depth of Contracts 14): knowledge, a service catalog UI and portal, the TMF620 and TMF633 catalog APIs, CSDM-style service modeling.
- TMF APIs beyond the nine in scope, and second major versions of those (for example v4 next to v5 for TM Forum's golden components, which mostly name v4); TMF724 Incident and TMF656 Service Problem; JSONPath filtering and JSON Patch Query (TMF630 parts 5 and 6, Contracts 10).
- Splitting STD into several ODA Components along TM Forum's golden components, with federated references between them.
- App packaging beyond definition sets: data in sets, transformations, a distribution channel.
- SAML, LDAP, MFA, impersonation, and OIDC sign-in for the web app outside a Canvas. OIDC bearer tokens from the Canvas identity provider are in v0.1 (Step 5).
- Reporting, dashboards, search UI, portal, mobile, translations, GraphQL.

## Known risks

- Every config commit briefly pauses all requests (one global lock). Per attempt, the pause is bounded by the `CONFIG_KEY` wait (200 ms) plus a 2 s lock budget for the whole attempt plus the main transaction's own work. `lock_timeout` applies to each lock separately, so the budget is enforced by taking every table lock a DDL statement needs explicitly with `LOCK TABLE` under the remaining budget, from a per-form lock inventory that a CI guard keeps complete (Contracts 1.4). The budget covers all contention from application traffic and STD itself. Locks the DDL takes internally on indexes and system catalogs cannot be taken in advance; only direct index or catalog maintenance (`ALTER INDEX`, `REINDEX`, amcheck, `VACUUM FULL` or `CLUSTER` of a catalog) contends them, each such wait is capped at the remaining budget computed when its statement started, and an attempt's lock-wait time is at most the budget × (1 + N), N counting contended internal acquisition attempts (reacquisitions included), with ordinary transaction work on top. Do not run index or catalog maintenance during schema changes. Accepted for v0.1 and measured in Stage 0 (decision 0007). Per-table locking is the fallback.
- Many `ALTER TABLE` forms take `ACCESS EXCLUSIVE`, and a waiting lock request queues later conflicting requests behind it, plain reads included [checked: `waitMask` test in src/backend/storage/lmgr/lock.c, REL_18_STABLE]. Short lock timeouts with retry bound the wait. Adding a reference field locks writes to the target table briefly, which matters for `core.user`.
- Postgres limits: 63-byte identifiers, and 1,600 columns per table with dropped columns still counted. `doctor` warns at 1,400.
- Adding a class briefly locks every ancestor table. The fallback design (a stored class path) is in the contracts.
- The benchmark may reopen the storage decision after Stage 0.
- Restricted list requests depend on the read compiler, not storage. Stage 0 measured Q6 at 10M at 300 ms p95 in the plain form and 1.1 ms in the branch form. On a referencing endpoint, the branch form is correct only when the request filters on the target. Q7 (a reference filter behind the target's visibility guard, about 0.4% of tickets) stays at 53.2 ms p95 even with serial execution and a covering index. In one run, rule-shaped `OR` predicates also made Postgres's generic plans about 5x slower than custom plans. Mitigations: the branch form, per-statement plan settings, and a decision on Q7 (`docs/decisions/0004-storage-benchmark.md`).
- Class-table Q3 and Q4 (a filter on one level, a sort on another) run at about 50 ms p50 at 10M. They met the 50 ms p95 budget in a quiet run and missed it (58 ms) under concurrent load on the shared host, where every other storage model passed them. Unlike Q2, Q6 and Q7, these misses are specific to class-table. The Step 5 rerun needs a quiet or dedicated machine to settle them.
- STD's server layer sits on unstable Effect APIs, the driver is young, and agents default to Effect 3. See "Effect".
- TypeScript 7.0 has no programmatic API, so tools that embed the compiler stay on TypeScript 6 until 7.1.
- Outbox delivery is blocked per record by a dead letter under the default policy, and writes one row per matching subscription per change.
- A Postgres major upgrade with newer Unicode data can change case-folding results. The upgrade procedure checks the fold table version and reindexes.
- With its own names and API, STD needs a mapping step for anyone switching from ServiceNow. `docs/servicenow-mapping.md` records it from Step 1.
- TMF630 v5.0.0 is pre-production and member-only; Martin supplied parts 1 and 4 to 8 (parts 2 and 3 exist only as v4.0.0) and made them the baseline (2026-10-22; decision 0021, decision 35). Contracts 10's first draft was read from the 2015 Part 1 and the public v5 documents; workstream 3G checks every rule against the v5 text through the requirements matrix. A later v5 release can still change rules before it becomes production. The CTKs are the only external check, and they test the TMF APIs, not STD's own generic API.
- CTK licensing is unclear: the dockerized v5 kits download from a public bucket without login and their scripts carry Apache-2.0 headers, but the bundles have no licence file and older kits and the conformance profiles are under TM Forum's RAND terms. CI downloads pinned kits by URL and digest and never commits them. TMF621's kit container exits 0 even when tests fail (observed for that kit), so the runner trusts no kit's exit code and checks the report against the expected mandatory cases (Contracts 11.1).
- Spec churn: TMF641 has no stable v5 (v5.0.0 is a 2024 preview without a kit); TMF688 has only a pre-production v4.0.0 and no kit; TMF672 v5.1 replaced v4's `UserRole` and `Permission` with permission specifications and sets; TM Forum's golden ODA components mostly name v4 APIs; ITIL (Version 5) launched in 2026 while ITIL 4 runs until the end of 2027; the Canvas chart moves fast (1.2.5 stable, 1.2.6 release candidates) and supports Kubernetes only up to 1.30. Every version is pinned in one table (Contracts 11.1) and moved in its own PR.
- The ODA Canvas in CI is heavy and flaky: TM Forum's own kind-based workflow takes about 30 minutes, and about half of recent upstream runs failed (sampled 2026-10-22, [runs](https://github.com/tmforum-oda/oda-canvas/actions/workflows/trigger_tests.yml)); a GitHub runner has 14 GB of disk against the documented 50 GB. The Step 3 probe measures it first; the Canvas workflow runs nightly and on release candidates, not on every PR (Contracts 13.6).
- The TMF630 rework touches every generic route, the record JSON, the error shape, the web app's client, the quickstart and most HTTP tests. The authorization tests were ported to the one API (decision 0021, decision 56) so the rework cannot weaken them.
- ODA Components are meant to own their data and talk through APIs; STD is one data model with foreign keys and one set of access rules. v0.1 ships one component, so STD cannot claim conformance to a TM Forum golden component (none of the 35 examined golden specifications exposes TMF621 anyway; decision 0021).
- TMF resources embed arrays (notes, related parties, order items) that STD stores as child records, so one TMF write can be several record saves with their own versions, history and deliveries (Contracts 11.1).
- `X-Total-Count` on every list costs a count query per page, and deep `offset` paging costs O(offset); both are measured in Step 5 (Contracts 10.4).
- A hub registration is a subscription, which is config, so each registration is a config commit with its brief global pause (Contracts 12.2).
- ITIL is a trademark and its guidance is licensed: STD describes the concepts in its own words, links to the sources and carries the trademark notice; commercial use of official ITIL content needs a PeopleCert licence.
- The requirement grows v0.1 from four steps to five.
- "Strict compatibility" is only as good as the requirements matrix (Contracts 15): its completeness against each source is a reviewed judgment, not a mechanical check, and each excluded requirement needs Martin's decision before its step's gate.
- Aggregate parts lock their parent first, so concurrent writes to many parts of one popular record serialize on it; config subscriptions add delivery inserts to config commits under `CONFIG_KEY`.
