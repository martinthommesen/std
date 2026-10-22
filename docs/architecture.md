# STD architecture and engineering conventions

This is the working brief for everyone writing STD code, human or agent. The product requirements live in `docs/plan.md` (stages, gates, workstreams) and `docs/contracts.md` (the detailed contracts, cited as "Contracts 3.5" and so on). When this file and the contracts disagree, the contracts win; fix this file in the same change.

## Toolchain (fixed)

- Node 26.12.0, pinned through `devEngines.runtime` in the root `package.json`. pnpm downloads it; always run tools through `pnpm` (`pnpm exec`, `pnpm run`, `pnpm test`) so the pinned Node is used. Plain `node` on this machine is 24.
- pnpm 12 workspace. Versions come from the `catalog:` in `pnpm-workspace.yaml`. Effect runtime packages are pinned to exactly 4.0.5. Never install `@effect/sql` or `@effect/platform` (Effect 3-era packages).
- TypeScript 7.0.2, patched by `effect-tsgo patch` (root `prepare` script) so plain `tsc` reports Effect diagnostics. Each package type-checks with `pnpm --filter <pkg> typecheck` (`tsc -p tsconfig.json`, `noEmit`); `pnpm typecheck` runs `tsc -p` on the root project and on every workspace package, whether or not it has that script.
- Lint and format: Ultracite (Oxlint + Oxfmt) with type-aware rules and every JS plugin. `pnpm check` must pass; `pnpm fix` auto-fixes. The lefthook pre-commit hook runs `ultracite fix` on staged files. Never commit with `--no-verify`, and never weaken `oxlint.config.ts`. A rule may be disabled only on a single line with an `oxlint-disable-next-line <rule> -- <reason>` comment, and only when the rule is genuinely wrong for that line.
- Foldkit tooling: `@foldkit/oxlint-plugin` (exact pin) runs its `all` preset, including the preset's own overrides, on `apps/web/**` only; the plugin loads once from `oxlint.config.ts`, and the `foldkit-oxlint-scope` canary keeps it off the server and plain packages. Foldkit's agent skills (`foldkit`, `generate-program`, `audit-program`) link from `.agents/skills/` and `.claude/skills/` into `repos/foldkit/skills/`, and `FOLDKIT.md` is Foldkit's own agent guide, copied verbatim from the vendored template (`docs/decisions/0010-foldkit-tooling.md`).
- Tests: Vitest 5 with `@effect/vitest`, against a real Postgres 18.
- Effect documentation: read `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` before writing Effect code. The source is the reference, not memory: most training data is Effect 3, and Effect 4 renamed and moved many APIs. `repos/effect` holds Effect's repository at the tag matching the lockfile (all packages, tests, `MIGRATION.md` and the rename map `migration/v3-to-v4.md`).

## Database for development and tests

- `pnpm db:up` starts Postgres 18 from `docker-compose.yml` on `127.0.0.1:54329`, user `std`, password `std`, database `std`.
- Tests never share a database. The test harness (`@std/testing`) creates a fresh database per test file (from a migrated template where possible) and drops it afterwards, so any number of agents and test workers can run at the same time against the one server. Every Postgres test gets its database from the harness; only `@std/values`'s codec tests connect directly, and they create nothing.
- Concurrent runs on one server, with any `STD_DATABASE_URL` database on it, do not interfere:
  - The harness drops and terminates only what it owns. A run drops its own test databases `WITH (FORCE)`. The janitor drops only databases with the harness's exact generated name and ownership comment: test databases older than 3 h and templates created more than 7 days ago. Tests terminate backends only in their own database (`datname = current_database()`). No test creates, alters or drops roles.
  - Template work is serialized by one advisory lock per template, taken in the server's `postgres` database. Advisory locks belong to the database they are taken in, so the harness does all admin work there, whatever database the URL names. Cloning holds the template's lock shared from the readiness check through `CREATE DATABASE ... TEMPLATE`. Building and dropping hold it exclusive. A template is therefore never dropped while another run is cloning or building it.
  - The janitor runs on its own connection and handles each database separately. It re-reads a template under its lock before dropping it, and skips a template that another run has already dropped. It never sends `ALTER DATABASE` to an invalid database (one whose `DROP DATABASE` is in progress or was interrupted). Postgres answers that with FATAL and closes the connection, which used to break the build of the next test database (`docs/decisions/0015-test-isolation.md`).
  - The harness needs a role that can create databases and connect to `postgres`. Its own tests also mark a database invalid through `pg_database`, which needs a superuser, as the compose and CI role `std` is.
- Connection settings come from `STD_DATABASE_URL` (default `postgres://std:std@127.0.0.1:54329/std`).
- Benchmarks use their own container and port (see `bench/README.md`) so they never compete with test databases for buffers.

## Repository layout

```
packages/
  values/        @std/values       plain: field types, canonical JSON, text, fold, decimal, dates
  conditions/    @std/conditions   plain: condition AST, checker, resolver, evaluators, SQL compiler, text syntax
  definitions/   @std/definitions  plain: definition model, config snapshot, effective records, set files, dependency graph, recordSchema
  access/        @std/access       plain: access-rule decisions, visible schema, predicates, explain
  api/           @std/api          HttpApi definition shared by server, web app and SDK
  server/        @std/server       Effect server: SQL layer, migrations, schema engine, config layers,
                                   record service, history, outbox, auth, HTTP, CLI (`std`), hooks, import
  testing/       @std/testing      test harness: databases, fixtures, HTTP helpers
  codegen/       @std/codegen      plain: SDK code generation from schema snapshots (Step 5)
  tmf/           @std/tmf          plain: TMF Open API mappings, TMF630 query translation, event rendering; pinned TM Forum OpenAPI documents in specs/ (Steps 3 and 4)
apps/
  web/           @std/web          Foldkit + Foldkit UI + Vite web app (Step 2; see AGENTS.md, "Frontend: Foldkit")
examples/
  acme/          Stage 0 two-user example (definition set, demo script)
  quickstart.sh  Step 1 runnable result, against `std serve` (decision 0016)
  quickstart/    `pnpm quickstart:ci`: runs quickstart.sh against a disposable database; `pnpm release-compat:ci`: the previous release upgraded to this branch
  helpdesk/      Step 2 and 3 example app definition set, import sample
bench/           Stage 0 inheritance benchmark, Step 5 rerun
docker/          the quickstart's development image (the release image is Step 5)
deploy/oda/      the ODA Component Helm chart and Canvas workflow inputs (Step 5)
docs/            plan, contracts, architecture, decisions/, conformance/ (requirements matrix, Contracts 15), servicenow-mapping.md, runbooks
repos/           read-only upstream source: effect/ (effect@<lockfile version>), foldkit/ (foldkit@<pinned tag>)
FOLDKIT.md       Foldkit's agent guide, owned by Foldkit, copied verbatim from repos/foldkit
```

### Dependency rules

- Plain packages (`values`, `conditions`, `definitions`, `access`, `codegen`, and `tmf` from Step 3) may import only `Schema`, `SchemaAST`, `SchemaGetter`, `SchemaIssue`, `SchemaParser`, `SchemaTransformation`, `Option` and `Result` from Effect (reasons in `docs/decisions/0001-effect.md`), their own `src/` files, other plain packages, and npm libraries listed with a reason in `tooling/plain-allowed-deps.json` whose dependency graph has no Effect. No I/O: no Node built-ins and no host globals. `tooling/check-imports.ts` enforces it for `src/`. Their tests may use anything their profile's test override allows.
- `api` may import `effect` stable modules, `effect/http-api` and `effect/http`.
- `server` may use the server allow list (Contracts 9).
- Direction: `values` <- `conditions` <- `definitions` <- `access` <- `server`; `tmf` depends on `values`, `conditions` and `definitions`, and `server` on it; `api` depends on `values` and `definitions` only; `web` depends on `api`, `values`, `conditions`, `definitions`; nothing depends on `server` except `testing`, `examples`, `bench`.

### Package conventions

- Each package has `package.json` (`"type": "module"`, `"private": true`, `"std": { "profile": "<profile>" }`), `tsconfig.json` (a copy of `tooling/tsconfig/<profile>.json`, see below), `src/`, and tests in `test/` (`*.test.ts`).
- Source is consumed directly as TypeScript: packages export `"./*": "./src/*.ts"` subpaths. There are no barrel `index.ts` files (`oxc/no-barrel-file`). Import a module by its subpath, e.g. `@std/values/decimal`.
- Relative imports use the `.ts` extension. Only erasable TypeScript syntax (no enums, no namespaces, no parameter properties), so Node 26 runs the sources directly.
- File names are kebab-case. Exported functions, classes and constants carry a JSDoc comment (`jsdoc/require-jsdoc`).
- Errors are `Schema.TaggedError` classes with PascalCase tags that match Contracts 3.8 where they are API errors.

## Tooling, CI and the vendored source

### tsconfig profiles

TypeScript's `extends` replaces the whole `plugins` array, so every package's `tsconfig.json` repeats the full `@effect/language-service` entry. A package declares one of four profiles in `package.json` and copies the matching template from `tooling/tsconfig/` (the templates assume `packages/<name>/`; adjust `extends` for other depths):

| Profile | For | `src/` may use (unstable) | Template |
| --- | --- | --- | --- |
| `plain` | `values`, `conditions`, `definitions`, `access`, `codegen`, `tmf` (Step 3) | nothing | `tooling/tsconfig/plain.json` |
| `api` | `api` | `effect/http-api`, `effect/http` | `tooling/tsconfig/api.json` |
| `web` | `apps/web` | `effect/http-api`, `effect/http`, `@effect/platform-browser` | `tooling/tsconfig/web.json` |
| `server` | `server`, `testing`, `examples`, `bench` | `effect/sql`, `effect/http`, `effect/http-api`, `effect/observability`, `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` | `tooling/tsconfig/server.json` |

Every profile raises the six Effect diagnostics (`unstableApiUsage`, `experimentalApiUsage`, `outdatedApi`, `obsoleteSchemaImport`, `duplicatePackage`, `floatingEffect`) to `error`, keeps `ignoreEffectWarningsInTscExitCode: false` and allows no experimental API. Its one override gives `test/**/*` the server entries plus `@effect/vitest`, in every profile, so any package's tests can use Postgres. The override glob resolves relative to the tsconfig that declares it, which is the second reason the entry cannot live in a shared file. `tooling/lib/profiles.ts` is the source of truth; `tooling/check-tsconfig.ts` fails any package (or template) whose entry is not exactly its profile's. Never edit an allow list in one package: change the profile, with a reason in `docs/decisions/0001-effect.md`.

### Checks and scripts

| Command | What it does |
| --- | --- |
| `pnpm check` / `pnpm fix` | Ultracite (Oxlint type-aware, Oxfmt); `check` then runs `check-foldkit-lint`, which fails unless the Foldkit plugin's rules fire on `apps/web` and not elsewhere |
| `pnpm typecheck [dir ...]` | `tsc -p` for the root project (tooling and config files) and every workspace package |
| `pnpm test` | Vitest, one project per workspace package (for `apps/web`, the Foldkit story and scene tests) |
| `pnpm --filter @std/web test:browser` | The web app in Playwright's Chromium against a real `std serve` on a disposable database (decision 0018); needs `pnpm --filter @std/web exec playwright install chromium` once |
| `pnpm check:tooling` | `check-tsconfig` (profiles), `check-imports` (plain packages import only Schema), `check-lockfile` (one Effect version, no `@effect/sql` or `@effect/platform`), `check-vendor` (vendored Effect and Foldkit tags equal the lockfile, `FOLDKIT.md` equals its template) |
| `pnpm check:postgres` | Signs in at `STD_DATABASE_URL` (SCRAM, MD5 or cleartext) and requires Postgres 18 and a UTF8 database |
| `pnpm test:canaries` | The Contracts 9 acceptance tests in `tooling/test/`, against the fixture packages in `tooling/canaries/` |
| `pnpm ci:local` | Every `run:` step of `.github/workflows/ci.yml`, in order |
| `pnpm release-compat:ci` | Release compatibility, below |

The fixture packages in `tooling/canaries/` are not workspace packages and are excluded from `pnpm typecheck`; they resolve `effect` and `@effect/vitest` from the root `node_modules`. CI (`.github/workflows/ci.yml`) runs Node 26.12.0, pnpm 12.14.0 and a Postgres 18 service on port 54329; `pnpm ci:local` runs the same steps here, where GitHub Actions cannot run.

**Release compatibility** (CI step "Release compatibility", `examples/quickstart/src/release-compat.ts`). Step 5 upgrades installs from real releases, so every branch proves that the latest release's databases and clients keep working. The step extracts the tree of the previous release's tag with `git archive` (without `repos/`) into a temporary directory and installs it; on a disposable empty database it runs that release's own `std upgrade`, `std bootstrap-admin`, `std serve` and `examples/quickstart.sh`, then this branch's `std upgrade` on the same database, `std doctor` (must exit 0), this branch's `std serve`, the release's quickstart again, unchanged, and this branch's quickstart. On a second empty database it installs this branch and runs the release's quickstart first, so the release's change-set, user and record requests reach this branch's API in the release's wire format. It needs the tag in the clone (CI checks out with `fetch-depth: 0` and `fetch-tags: true`) and takes about 15 s. The previous release is one setting, `PREVIOUS_RELEASE` in `examples/quickstart/src/previous-release.ts`: each release moves it to the tag it publishes. What it implies for code (decision 0017): a property added to a definition or request schema decodes an absent key as its documented default (`nullWhenAbsent` in `@std/definitions/definition`); stored JSON from a release is compared after `withAddedDefaults`; the catalog load reads the definition tables in the shape the database has, so `std upgrade` and `--plan` can read a database before its pending migrations run.

### Vendored source (`repos/`)

`repos/effect` is Effect's repository at the `effect@<version>` tag that matches the lockfile; `repos/foldkit` is Foldkit's at the `foldkit@<version>` tag that the web app installs. `tooling/vendor.ts effect|foldkit <version>` imports each as a squashed subtree (a signed-off squash commit with `git-subtree-dir` and `git-subtree-split` trailers, merged in, as `git subtree add --squash` would) without fetching upstream history into the repository, and records it in `repos/<package>-version.json` with the tag's commit and tree hash; `check-vendor` compares each committed tree with its hash. Both are reference material only: never imported, not workspace packages, and excluded from lint (`.eslintignore`, `oxlint.config.ts`), formatting (`.prettierignore`, `oxfmt.config.ts`), the pre-commit hook (`lefthook.yml`), type checks, tests and the pnpm workspace. Their own `package.json`, pnpm workspace, tsconfig and Oxlint files are never read. `.ignore` keeps `repos/` out of editor file trees and root-level ripgrep searches; search them by explicit path (`rg <pattern> repos/effect/packages`). Agent worktrees under `.claude/` are excluded the same way. The upgrade procedures are in `docs/decisions/0001-effect.md` and `docs/decisions/0010-foldkit-tooling.md`.

## Server structure (`packages/server/src`)

| Directory | Contents | Contracts |
| --- | --- | --- |
| `sql/` | STD's SQL layer over `@effect/sql-pg`: pool config, text-format type parsers, session parameters, READ COMMITTED request transactions, joining nested transactions without `SAVEPOINT`, transaction poisoning, statement log for tests, dedicated connections, LISTEN with reconnect | 1.3, 4.1, 5.6, 5.7 |
| `platform/` | platform migrations (numbered SQL), ledger, runner, startup checks | 1.9 |
| `catalog/` | load the effective config snapshot at `(revision, change_set_id)`, per-process cache, reload on NOTIFY, definition revisions | 1.2, 1.3, 4.4 |
| `schema/` | change sets, `SCHEMA_KEY`/`CONFIG_KEY`, DDL generation for class-table storage, journal and follow-up steps, coordinator, resume, abandon, retire and purge, dependency index, protected definitions | 1, 2 |
| `config/` | owner layers, definition sets, base and overrides, conflicts, the config service, `std upgrade` plan and apply | 8 |
| `auth/` | users, password hashing, sessions, roles and permissions, acting-user service, API tokens (Step 4) | 3.1 |
| `records/` | read compiler (visibility, masking, projection, cursors, references, counts), save pipeline, history, outbox producer, `saveBatch` (Step 3) | 2, 3, 4 |
| `http/` | generic record routes, `HttpApi` handlers, error mapping, schema-revision header, stale-request checks | 3.8, 6 |
| `cli/` | the `std` command: `serve`, `worker` (Step 3), `wait-upgraded` (Step 5), `upgrade`, `doctor`, `schema status | resume | abandon`, `bootstrap-admin`(decision 0016),`schema pull`, `codegen` | 1.10, 8.5, 8.7 |
| `doctor/` | `runDoctor`: the 16 read-only checks of `std doctor`, as a library function returning typed findings and the exit code | 1.10 |
| `hooks/` | hook phases and record rules (Step 3) | 4.1 |
| `outbox/` | claim, fenced `done` and failure updates, backoff (1E); delivery worker (Step 3) | 4.6 |
| `import/` | import jobs (Step 4) | 7 |
| `definitions/` (directory at package root, not in `src`) | the shipped `core` definition set files | 1.8, 3.1 |

## Cross-cutting decisions

- **Stable IDs.** Shipped definitions carry fixed UUIDs in their files; records and API-created definitions get `uuidv7()`. Generated index and constraint names are `std_<kind>_<32 hex of the stable ID>`.
- **Config snapshot.** The runtime reads one immutable `ConfigSnapshot` (defined in `@std/definitions`) per `(revision, change_set_id)`: namespaces, classes with their hierarchy, fields, overrides, indexes, choices, layouts, roles, permissions, grants, access rules, subscriptions, rules. Every request resolves names and compiles SQL from the snapshot of the revision that `core.begin_request()` returned.
- **Definitions are records.** Definition and other config tables are platform tables created by migrations, laid out like root classes (`id`, `class_id`, `version`, audit fields, typed columns) and described by the `core` definition set, so admins reach them through the generic record API, where writes become one-operation change sets (Contracts 1.4).
- **Generated SQL** never uses `SELECT *`, binds every value as a parameter (text with casts for numeric, int8, date, timestamptz), and quotes identifiers that come from definitions.
- **Acting user.** Every record-service operation requires the `Actor` service in its Effect environment; there is no default actor in the HTTP layer.
- **HTTP shape.** Through Step 2 (and for `/api/v1` until `v0.1.0`), generic records live under `/api/v1/tables/{table}/records[/{id}[/history]]`, the table list and metadata under `/api/v1/meta/tables[/{table}[/openapi.json]]`, fixed endpoints under `/api/v1/...` from the `@std/api` definition. Every response carries `STD-Schema-Revision`. From Step 3, `/api/v2` is the TMF630 version of the same API (Contracts 10; tables as `/api/v2/{v2 collection name}`, such as `/api/v2/helpdeskIncident`, served by `server/src/http/v2/`) and `/api/v1` is frozen until `v0.1.0`, every response carrying `Deprecation` and a `successor-version` link; TM Forum Open APIs live under `/tmf-api/{apiName}/v{major}` (Contracts 11). Every one of them is an adapter over the record service (decision 0021).
- **Text filter syntax.** The `filter` query parameter uses the condition text syntax defined in `@std/conditions` (names resolved against the visible schema); `parse(print(a)) = a`.
- **Sessions.** `POST /api/v1/auth/sign-in` returns a session token, sent back as `Authorization: Bearer <token>`. The web app signs in with `POST /api/v1/auth/cookie-sign-in` instead: the same kind of session, its token in an `HttpOnly`, `SameSite=Strict` cookie (`std_session`, path `/api` from Step 3 (it was `/api/v1`), `Secure` unless the request's host is loopback, `STD_SESSION_COOKIE_SECURE`), never in a response body or anything a script can read. The server accepts the cookie wherever it accepts the bearer token (the bearer token first); a cookie-authenticated request that is not GET, HEAD or OPTIONS must carry `STD-Client: web` (CSRF), or it is `Unauthenticated`. Sign-out clears the cookie it ended. Only a hash of the token is stored (decision 0018). This is the Step 2 behavior: from Step 3 the session endpoints are `POST /api/v2/session` and `GET`, `DELETE /api/v2/session/current`, and the cookie's path widens to `/api` so one session serves both API versions until `/api/v1` is removed (Contracts 10.1); from Step 5, OIDC bearer tokens from the ODA Canvas identity provider are accepted too (Contracts 13.4).
- **Web app.** `std serve` serves the built app (`apps/web/dist`, `STD_WEB_ROOT`) at `/`, with `index.html` for client routes and a strict Content-Security-Policy; the API stays under `/api/v1`, only `/api/` responses carry `STD-Schema-Revision`, and every one of them `Cache-Control: no-store`. Only files whose real path lies inside the real web root are served, and the web root must not be writable by the server process. In development Vite proxies `/api` to a running `std serve`. Browser state never holds a session token, and the sign-in password only as `Redacted` (AGENTS.md, "Frontend: Foldkit"). Through Step 2 the web app calls `/api/v1`; in Step 3 it moves to `/api/v2` with the typed client (Contracts 10.7).

## Workflow for each workstream

1. Work on a branch named `ws/<id>-<slug>` (for example `ws/1d-values`).
2. Read the plan rows and contract sections for your workstream first, then the code you build on.
3. Every PR-sized commit adds or extends a proving test from the plan and passes it. Tests named in the contracts keep their names (`describe("rows-count", ...)`).
4. Before you finish: `pnpm fix`, then `pnpm check`, `pnpm check:tooling`, `pnpm typecheck` and the tests of every package you touched must all pass (`pnpm ci:local` runs all of CI). Commit with `git commit -s` (signed-off, Apache-2.0, no CLA).
5. Record facts you verified about Postgres or Effect (the contracts' `[spike]` items) in `docs/decisions/` and update the contract text if reality differs.
6. Extend `docs/servicenow-mapping.md` when you add a feature that has a ServiceNow counterpart.
