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
- Tests never share a database. The test harness (`@std/testing`) creates a fresh database per test file (from a migrated template where possible) and drops it afterwards, so any number of agents and test workers can run at the same time against the one server.
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
  codegen/       @std/codegen      plain: SDK code generation from schema snapshots (Step 4)
apps/
  web/           @std/web          Foldkit + Foldkit UI + Vite web app (Step 2; see AGENTS.md, "Frontend: Foldkit")
examples/
  acme/          Stage 0 two-user example (definition set, demo script)
  helpdesk/      Step 2 and 3 example app definition set, import sample
bench/           Stage 0 inheritance benchmark, Step 4 rerun
docs/            plan, contracts, architecture, decisions/, servicenow-mapping.md, runbooks
repos/           read-only upstream source: effect/ (effect@<lockfile version>), foldkit/ (foldkit@<pinned tag>)
FOLDKIT.md       Foldkit's agent guide, owned by Foldkit, copied verbatim from repos/foldkit
```

### Dependency rules

- Plain packages (`values`, `conditions`, `definitions`, `access`, `codegen`) may import only `Schema`, `SchemaAST`, `SchemaGetter`, `SchemaIssue`, `SchemaParser`, `SchemaTransformation`, `Option` and `Result` from Effect (reasons in `docs/decisions/0001-effect.md`), their own `src/` files, other plain packages, and npm libraries listed with a reason in `tooling/plain-allowed-deps.json` whose dependency graph has no Effect. No I/O: no Node built-ins and no host globals. `tooling/check-imports.ts` enforces it for `src/`. Their tests may use anything their profile's test override allows.
- `api` may import `effect` stable modules, `effect/http-api` and `effect/http`.
- `server` may use the server allow list (Contracts 9).
- Direction: `values` <- `conditions` <- `definitions` <- `access` <- `server`; `api` depends on `values` and `definitions` only; `web` depends on `api`, `values`, `conditions`, `definitions`; nothing depends on `server` except `testing`, `examples`, `bench`.

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
| `plain` | `values`, `conditions`, `definitions`, `access`, `codegen` | nothing | `tooling/tsconfig/plain.json` |
| `api` | `api` | `effect/http-api`, `effect/http` | `tooling/tsconfig/api.json` |
| `web` | `apps/web` | `effect/http-api`, `effect/http` | `tooling/tsconfig/web.json` |
| `server` | `server`, `testing`, `examples`, `bench` | `effect/sql`, `effect/http`, `effect/http-api`, `effect/observability`, `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` | `tooling/tsconfig/server.json` |

Every profile raises the six Effect diagnostics (`unstableApiUsage`, `experimentalApiUsage`, `outdatedApi`, `obsoleteSchemaImport`, `duplicatePackage`, `floatingEffect`) to `error`, keeps `ignoreEffectWarningsInTscExitCode: false` and allows no experimental API. Its one override gives `test/**/*` the server entries plus `@effect/vitest`, in every profile, so any package's tests can use Postgres. The override glob resolves relative to the tsconfig that declares it, which is the second reason the entry cannot live in a shared file. `tooling/lib/profiles.ts` is the source of truth; `tooling/check-tsconfig.ts` fails any package (or template) whose entry is not exactly its profile's. Never edit an allow list in one package: change the profile, with a reason in `docs/decisions/0001-effect.md`.

### Checks and scripts

| Command | What it does |
| --- | --- |
| `pnpm check` / `pnpm fix` | Ultracite (Oxlint type-aware, Oxfmt) |
| `pnpm typecheck [dir ...]` | `tsc -p` for the root project (tooling and config files) and every workspace package |
| `pnpm test` | Vitest, one project per workspace package |
| `pnpm check:tooling` | `check-tsconfig` (profiles), `check-imports` (plain packages import only Schema), `check-lockfile` (one Effect version, no `@effect/sql` or `@effect/platform`), `check-vendor` (vendored Effect and Foldkit tags equal the lockfile, `FOLDKIT.md` equals its template) |
| `pnpm check:postgres` | Signs in at `STD_DATABASE_URL` (SCRAM, MD5 or cleartext) and requires Postgres 18 and a UTF8 database |
| `pnpm test:canaries` | The Contracts 9 acceptance tests in `tooling/test/`, against the fixture packages in `tooling/canaries/` |
| `pnpm ci:local` | Every `run:` step of `.github/workflows/ci.yml`, in order |

The fixture packages in `tooling/canaries/` are not workspace packages and are excluded from `pnpm typecheck`; they resolve `effect` and `@effect/vitest` from the root `node_modules`. CI (`.github/workflows/ci.yml`) runs Node 26.12.0, pnpm 12.14.0 and a Postgres 18 service on port 54329; `pnpm ci:local` runs the same steps here, where GitHub Actions cannot run.

### Vendored source (`repos/`)

`repos/effect` is Effect's repository at the `effect@<version>` tag that matches the lockfile; `repos/foldkit` is Foldkit's at the `foldkit@<version>` tag that the web app installs. `tooling/vendor.ts effect|foldkit <version>` imports each as a squashed subtree (a signed-off squash commit with `git-subtree-dir` and `git-subtree-split` trailers, merged in, as `git subtree add --squash` would) without fetching upstream history into the repository, and records it in `repos/<package>-version.json` with the tag's commit and tree hash; `check-vendor` compares each committed tree with its hash. Both are reference material only: never imported, not workspace packages, and excluded from lint (`.eslintignore`, `oxlint.config.ts`), formatting (`.prettierignore`, `oxfmt.config.ts`), the pre-commit hook (`lefthook.yml`), type checks, tests and the pnpm workspace. Their own `package.json`, pnpm workspace, tsconfig and Oxlint files are never read. `.ignore` keeps `repos/` out of editor file trees and root-level ripgrep searches; search them by explicit path (`rg <pattern> repos/effect/packages`). Agent worktrees under `.claude/` are excluded the same way. The upgrade procedures are in `docs/decisions/0001-effect.md` and `docs/decisions/0010-foldkit-tooling.md`.

## Server structure (`packages/server/src`)

| Directory | Contents | Contracts |
| --- | --- | --- |
| `sql/` | STD's SQL layer over `@effect/sql-pg`: pool config, text-format type parsers, session parameters, READ COMMITTED request transactions, joining nested transactions without `SAVEPOINT`, transaction poisoning, statement log for tests, dedicated connections, LISTEN with reconnect | 1.3, 4.1, 5.6, 5.7 |
| `platform/` | platform migrations (numbered SQL), ledger, runner, startup checks | 1.9 |
| `catalog/` | load the effective config snapshot at `(revision, change_set_id)`, per-process cache, reload on NOTIFY, definition revisions | 1.2, 1.3, 4.4 |
| `schema/` | change sets, `SCHEMA_KEY`/`CONFIG_KEY`, DDL generation for class-table storage, journal and follow-up steps, coordinator, resume, abandon, retire and purge, dependency index, protected definitions | 1, 2 |
| `config/` | owner layers, definition sets, base and overrides, conflicts, `std upgrade` plan and apply | 8 |
| `auth/` | users, password hashing, sessions, roles and permissions, acting-user service, API tokens (Step 3) | 3.1 |
| `records/` | read compiler (visibility, masking, projection, cursors, references, counts), save pipeline, history, outbox producer, `saveBatch` (Step 3) | 2, 3, 4 |
| `http/` | generic record routes, `HttpApi` handlers, error mapping, schema-revision header, stale-request checks | 3.8, 6 |
| `cli/` | the `std` command: `serve`, `upgrade`, `doctor`, `schema status | resume | abandon`, `schema pull`, `codegen` | 1.10, 8.5, 8.7 |
| `hooks/` | hook phases and record rules (Step 3) | 4.1 |
| `outbox/` | delivery worker (Step 3) | 4.6 |
| `import/` | import jobs (Step 3) | 7 |
| `definitions/` (directory at package root, not in `src`) | the shipped `core` definition set files | 1.8, 3.1 |

## Cross-cutting decisions

- **Stable IDs.** Shipped definitions carry fixed UUIDs in their files; records and API-created definitions get `uuidv7()`. Generated index and constraint names are `std_<kind>_<32 hex of the stable ID>`.
- **Config snapshot.** The runtime reads one immutable `ConfigSnapshot` (defined in `@std/definitions`) per `(revision, change_set_id)`: namespaces, classes with their hierarchy, fields, overrides, indexes, choices, layouts, roles, permissions, grants, access rules, subscriptions, rules. Every request resolves names and compiles SQL from the snapshot of the revision that `core.begin_request()` returned.
- **Definitions are records.** Definition and other config tables are platform tables created by migrations, laid out like root classes (`id`, `class_id`, `version`, audit fields, typed columns) and described by the `core` definition set, so admins reach them through the generic record API, where writes become one-operation change sets (Contracts 1.4).
- **Generated SQL** never uses `SELECT *`, binds every value as a parameter (text with casts for numeric, int8, date, timestamptz), and quotes identifiers that come from definitions.
- **Acting user.** Every record-service operation requires the `Actor` service in its Effect environment; there is no default actor in the HTTP layer.
- **HTTP shape.** Generic records live under `/api/v1/tables/{table}/records[/{id}[/history]]`, metadata under `/api/v1/meta/tables/{table}`, fixed endpoints under `/api/v1/...` from the `@std/api` definition. Every response carries `STD-Schema-Revision`.
- **Text filter syntax.** The `filter` query parameter uses the condition text syntax defined in `@std/conditions` (names resolved against the visible schema); `parse(print(a)) = a`.
- **Sessions.** `POST /api/v1/auth/sign-in` returns a session token, sent back as `Authorization: Bearer <token>` (the web app also uses an HTTP-only cookie). Only a hash of the token is stored.

## Workflow for each workstream

1. Work on a branch named `ws/<id>-<slug>` (for example `ws/1d-values`).
2. Read the plan rows and contract sections for your workstream first, then the code you build on.
3. Every PR-sized commit adds or extends a proving test from the plan and passes it. Tests named in the contracts keep their names (`describe("rows-count", ...)`).
4. Before you finish: `pnpm fix`, then `pnpm check`, `pnpm check:tooling`, `pnpm typecheck` and the tests of every package you touched must all pass (`pnpm ci:local` runs all of CI). Commit with `git commit -s` (signed-off, Apache-2.0, no CLA).
5. Record facts you verified about Postgres or Effect (the contracts' `[spike]` items) in `docs/decisions/` and update the contract text if reality differs.
6. Extend `docs/servicenow-mapping.md` when you add a feature that has a ServiceNow counterpart.
