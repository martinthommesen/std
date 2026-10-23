# Workstream tracker

How the plan's stages are being delivered. Each row is one branch (`ws/<id>-<slug>`), written by an implementation agent, reviewed by a separate review agent, fixed, then merged into `main`. Status values: `planned`, `in progress`, `in review`, `merged`.

| Wave | Branch | Plan workstreams | Scope | Status |
| --- | --- | --- | --- | --- |
| 1 | `ws/0a-toolchain` | 0A | tsconfig profiles, import/lockfile/vendor checks, canaries, CI, Effect decision note, license | merged |
| 1 | `ws/1d-values` | 1D (values) | `@std/values`: every field type's representation, canonical JSON, text, fold table, decimal, dates, Postgres text I/O | merged |
| 1 | `ws/0e-bench` | 0E | storage benchmark at 1M and 10M, decision rule, committed results | merged |
| 1 | `ws/0a-sql-layer` | 0A (driver), 1A/1B groundwork | `@std/server` skeleton, SQL layer, platform migrations, `@std/testing`, driver smoke test | merged |
| 3 | `ws/0a-sql-read-tuning` | 0A follow-up | `SET LOCAL` planner settings (`max_parallel_workers_per_gather`, `plan_cache_mode`), unprepared `readOnly` statements, for the read compiler's branch form | merged |
| 2 | `ws/1d-conditions` | 0D, 1D (conditions) | `@std/conditions`: AST, checker, resolver, evaluators, SQL compiler, text syntax, differential test | merged |
| 2 | `ws/0b-schema-core` | 0B, 1A (core) | `@std/definitions`, platform definition tables, catalog snapshots, change sets, class-table DDL, core definition set | merged |
| 2 | `ws/0f-probes` | 0F | Postgres behavior probes and measurements | merged |
| 3 | `ws/0c-reads` | 0C | `@std/access`, read compiler (visibility, masks, cursors, references, counts), auth, generic read routes, acme fixture | merged |
| 3 | `ws/0c-writes` | 0B, 0C, 1E (history) | save pipeline, deletes, history and history endpoint, two-user write scenario, `spike:demo` | merged |
| 3 | `ws/0a-foldkit-tooling` | 0A (web toolchain) | Foldkit source vendored at `repos/foldkit`, Foldkit agent skills for Claude Code and Codex, `@foldkit/oxlint-plugin` (all preset) on `apps/web`, vendor checks and canaries; vendored Effect moved to `repos/effect` | merged |
| 4 | `ws/1a-schema-lifecycle` | 1A | rename, retire, purge, dependency index, protected definitions, indexes, follow-up steps, coordinator, resume, abandon | merged |
| 4 | `ws/1b-config-layers` | 1B | owner layers, sets, overrides, conflicts, `std upgrade --plan`, `doctor` | merged |
| 4 | `ws/0a-lock-holder-sampling` | 0A follow-up | `SchemaLockTimeout` names the sessions that held the waited lock, sampled while waiting | merged |
| 4 | `ws/0a-test-isolation` | 0A follow-up | Postgres-backed suites stay reliable when several CI runs share one cluster; conditions tests use `@std/testing` | merged |
| 4 | `ws/1d-differential-coverage` | 1D follow-up | the differential test's coverage gate holds independently of machine speed | merged |
| 4 | `ws/1e-outbox-producer` | 1E | subscriptions, delivery rows, claim query tests, version invariant property test | merged |
| 4 | `ws/1c-authz-complete` | 1C | every read and write path, stale requests, `@std/api`, error fuzz, users, no-bypass | merged |
| 4 | `ws/1c-schema-paths` | 1C follow-up | the "Waiting on 1A" items of decision 0014 and gate gaps 1.4 to 1.9: change-set endpoints and definition-table generic writes in `authz-paths`, `stale-paths`, `built-ins`, `no-bypass` and `error-fuzz`; retire, purge and role-dependency refusals over HTTP; the protected-definition matrix through both HTTP paths | merged |
| 4 | `ws/1-gate-gaps` | Step 1 gate | gaps from the gate map: two-user filters, sorts and labels through child endpoints; the last [spike] item; cross-process invalidation with two processes; `secret` and `condition` codecs | merged |
| 4 | `ws/1d-condition-fields` | 1D follow-up | a `condition` field's value is checked against its profile and class on save (Contracts 6.5); the field definition names the class its conditions apply to; cross-process test commits through A's change-set endpoint | merged |
| 4 | `ws/1-gate-final` | Step 1 gate | the last gaps of gate rows 1.4 to 1.7 over HTTP: retiring a table with a child class not retired; table-purge refusals for a child class, an incoming reference, an access rule and a subscription; deleting a role only an inactive access rule names; local additions refused as `reserved`, `notExtensible` and `platform`; after review and the gate audit, one guard for every new definition (fixing a 500 on platform storage), history through `/acme.monitor`, condition-field, self-reference and retired-source refusals | merged |
| 4 | `ws/0a-ci-foldkit-lint` | 0A follow-up | GitHub CI: the Foldkit lint canary reads oxlint's JSON output under a controlled environment; `pnpm check` fails if the Foldkit plugin is not loaded; `pnpm/action-setup@v6` | merged |
| 4 | `ws/1-ci-strace-compat` | Step 1 follow-up | GitHub CI: the quickstart's execve-trace parser accepts strace's padded PID column (strace 6.8 and 6.19 fixtures); diagnostic snippets mask quoted strings | merged |
| 4 | `ws/1-quickstart` | Step 1 gate | quickstart, ServiceNow mapping, gate map (`docs/gates.md`), `v0.0.1` | merged; tagged `v0.0.1` |
| 5 | `ws/2a-metadata` | 2A, 2D | metadata endpoint, `recordSchema`, choices, layouts, auto-numbers, per-table OpenAPI, admin editing of roles, assignments and rules; release-compatibility CI step | merged |
| 5 | `ws/2b-web-foundation` | 2B (foundation) | `apps/web` on Foldkit and Foldkit UI over Effect 4.0.5, cookie sessions with CSRF protection, app shell, serving from `std serve`, story, scene and browser test harness | merged |
| 5 | `ws/2b-web-pages` | 2B, 2C | table navigation, lists, forms, filter builder, picker, related lists, history panel, stale forms, admin pages, browser tests, compose browser smoke test | merged |
| 5 | `ws/2d-helpdesk` | 2D | helpdesk set v1 and v2, upgrade test, rename test, saved filters, compose runnable result, browser-test fixture | merged |
| 5 | `ws/plan-tmf-oda-itil` | re-plan | Martin's hard requirement (2026-10-22): strict TM Forum (TMF630 on the generic API, TMF621/632/669/672/688/638/639/641/622 with conformance kits), ODA Components on the ODA Canvas, ITIL practices; rework of the plan, contracts and Steps 3–4 | merged (signed off by Martin, 2026-10-22) |
| 6 | `ws/3a-record-rules` | 3A | record rules as Contracts 4.10 declares them (all four phases; `aggregate` declared, executed by the aggregates workstream); `keepSupplied`; any failed nested save poisons its transaction | merged |
| 6 | `ws/3a-aggregates` | 3A, 3T | aggregates (Contracts 4.9): owner references, root-first locks, settle and persist, aggregate saves, aggregate rules and quantifiers | merged |
| 6 | `ws/3b-outbox-worker` | 3B | delivery worker (`std worker`), leases with fencing, dead letters, config subscriptions, payloads rebuilt from history (fail closed), afterCommit rules run from carrier deliveries | merged |
| 6 | `ws/3b-dead-letter-admin` | 3B follow-up | dead-letter operator API (`/api/v1/deadDelivery`, retry and discard tasks), append-only stored actions `core.dead_delivery_action` (migration 0029, core set v4), admin page (decision 0037) | merged |
| 6 | `ws/3c-form-rules` | 3C | form rules, browser evaluator, form-state | planned |
| 6 | `ws/3g-tmf630-api` | 3G | the TMF630 API per Contracts 10 on the v5 baseline (Martin, 2026-10-22), TMF630 matrix file | merged |
| 6 | `ws/3r-migration-phases` | 3R | migration phases and the `migration-phases` check (libpg-query AST allow-list), RU9/RU10/RU12 groundwork, release version 0.0.3 | merged |
| 6 | `ws/ci-flakes-load`, `ws/ci-flakes-2-main` | CI follow-up | load flakes diagnosed by Gemini 4 Argon | merged |
| 6 | `ws/api-v1-consolidation` | 3G follow-up | Martin, 2026-10-23: the old `/api/v1` is deleted and the TMF630 API becomes `/api/v1`; release compatibility becomes a database-upgrade check | merged |
| 6 | `ws/web-new-api` | 3G follow-up | the web app on the TMF630 API (merged with the consolidation) | merged |
| 6 | `ws/3h-events-hubs` | 3H | hubs on the generic API and the TMF framework, event delivery from per-change images, TMF688 topics and events (decision 0032) | merged |
| 6 | `ws/3h-events` | 3H | the listener example (`examples/listener`) | planned |
| 6 | `ws/3t-conformance-matrix` | 3T | `@std/tmf` pins and vendored OpenAPI documents, `check-conformance-matrix`, Step 3 matrix files, spec check of Contracts 10–15 against the member documents and Martin's decisions on it (decision 0026; 0021 decisions 34–55); Contracts 8.8 rolling-upgrade draft | merged |
| 6 | `ws/3t-tmf-framework` | 3T | mapping rules over the aggregates, CTK runner and OpenAPI contract tests in CI (Contracts 11.1); decision 0033 | merged |
| 6 | `ws/3p-party-foundation` | 3P | `core.party`, `core.individual`, `core.organization`, `core.user.individual`, the `data` migration kind and the user backfill (Contracts 1.9, 11.3), release-compat baseline `v0.0.2` | merged |
| 6 | `ws/3i-helpdesk-v3` | 3I part A | helpdesk v3: ITIL incident and problem, cascade service identity, v2→v3 upgrade (decision 0034) | merged |
| 6 | `ws/3i-itil-helpdesk` | 3I part B | TMF621 on the framework, CTK CI job, `v0.0.3` | planned |
| 6 | `ws/3k-oda-canvas-probe` | 3K | ODA Canvas on kind in GitHub Actions, committed measurements (Contracts 13.6): 10 of 10 runs succeeded | merged |
| 6 | `ws/ci-pin-actions` | CI follow-up | `ci.yml` and `quickstart-compose.yml` pin every action by commit SHA | merged |
| 6 | `ws/3s-tls-signing` | 3R (Martin's M16) | TLS to Postgres for every connection (`@std/postgres/transport`), quickstart PKI, doctor check 17, signed release workflow (cosign keyless, SBOM, provenance) | merged |
| 6 | `ws/sec-part-owner` | security follow-up | scan finding F3: a write to a part is a write to its owner; part creates, updates and deletes need update rights on every owner up to the root (decision 0039) | merged |
| 7 | `ws/4d-identity-party` | 4D | groups, nested roles, tokens, explain, rule editor; party roles; config subscriptions; TMF632, TMF669, TMF672 | planned |
| 7 | `ws/4c-cmdb` | 4C | `cmdb` set, TMF638, TMF639 | planned |
| 7 | `ws/4o-orders` | 4O | helpdesk v4: changes, approvals, requests, catalog items; TMF641, TMF622 | planned |
| 7 | `ws/4e-import` | 4E, 4F | import reconciliation, `saveBatch`, `v0.0.4` | planned |
| 8 | `ws/5a-performance` | 5A | import measurement, benchmark through the record service, TMF list counts | planned |
| 8 | `ws/5b-upgrade-recovery` | 5B, 5C | release upgrade, backup and restore, runbooks in CI | planned |
| 8 | `ws/5o-oda` | 5O, 5S | ODA Component chart, OIDC bearer tokens, Canvas deployment workflow (Contracts 13) | planned |
| 8 | `ws/5d-release` | 5D | image, telemetry, docs site, snapshot and SDK codegen, removal of `/api/v1`, `v0.1.0` | planned |
