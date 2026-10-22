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
| 5 | `ws/plan-tmf-oda-itil` | re-plan | Martin's hard requirement (2026-10-22): strict TM Forum (TMF630 on the generic API, TMF621/632/669/672/688/638/639/641/622 with conformance kits), ODA Components on the ODA Canvas, ITIL practices; rework of the plan, contracts and Steps 3–4 | in progress |
| 6 | `ws/3a-hooks` | 3A | hooks and record rules | planned |
| 6 | `ws/3b-outbox-worker` | 3B | delivery worker, leases, dead letters | planned |
| 6 | `ws/3c-form-rules` | 3C | form rules, browser evaluator, form-state | planned |
| 6 | `ws/3d-identity` | 3D | groups, nested roles, tokens, explain, rule editor | planned |
| 6 | `ws/3e-import` | 3E, 3F | import reconciliation, `saveBatch`, `v0.0.3` | planned |
| 7 | `ws/4a-performance` | 4A | import measurement, benchmark through the record service | planned |
| 7 | `ws/4b-upgrade-recovery` | 4B, 4C | release upgrade, backup and restore, runbooks in CI | planned |
| 7 | `ws/4d-release` | 4D | image, telemetry, docs site, snapshot and SDK codegen, `v0.1.0` | planned |
