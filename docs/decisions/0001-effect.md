# 0001: Effect 4 and its toolchain guards

- Status: accepted (Stage 0, workstream 0A), 2026-10-20
- Implements: plan "Effect" and "Stack", Contracts 9

## Decision

STD's server is written in Effect 4, pinned to 4.0.5. Effect's typed errors, services and structured concurrency fit a platform whose correctness depends on transactions, cancellation and background work. The 4.x line gets fixes until September 2029 or one year after 5.0, all Effect packages share one version, and since 4.0.2 every module and export declares its stability, which the `@effect/tsgo` diagnostics turn into compile errors.

The cost is accepted with guards: STD's server layer sits on unstable modules, coding models mostly know Effect 3, and leaving Effect later would be a large migration. The guards are the tsconfig profiles below, three CI checks, a vendored copy of Effect's source, and the measured review at every stage gate.

## Versions

- `effect`, `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` and `@effect/vitest`: exactly 4.0.5, through the `catalog:` in `pnpm-workspace.yaml`.
- `@effect/tsgo`: exactly 0.54.1, its own version line. `typescript`: 7.0.2, from `@effect/tsgo`'s supported table.
- Never installed: `@effect/sql`, `@effect/platform` (Effect 3-era 0.x packages; in Effect 4 they are `effect/sql` and `effect/http`).
- `pnpm check:tooling` enforces this through `tooling/check-lockfile.ts`: one resolved version of `effect` and of every `@effect/*` runtime package, all equal to the catalog's `effect`; the catalog itself consistent; one `@effect/tsgo` at its pin; no `@effect/sql` or `@effect/platform`.

## Profiles and allow lists

Each workspace package declares a profile in `package.json` (`"std": { "profile": "plain" }`) and carries that profile's `@effect/language-service` entry in `tsconfig.json`. Templates: `tooling/tsconfig/{plain,api,web,server}.json`. The source of truth is `tooling/lib/profiles.ts`; `tooling/check-tsconfig.ts` fails any package whose entry differs from it.

Every profile sets `unstableApiUsage`, `experimentalApiUsage`, `outdatedApi`, `obsoleteSchemaImport`, `duplicatePackage` and `floatingEffect` to `error`, keeps `ignoreEffectWarningsInTscExitCode: false`, and has `allowedExperimentalApis: []`. Unstable Schema exports are added one export at a time (`effect/Schema#name`), only when needed, with a reason here.

| Entry | Allowed in | Reason |
| --- | --- | --- |
| `effect/http-api` | api, web, server; all tests | The shared `HttpApi` definition (`HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiSchema`), `HttpApiClient.make` for the typed client, and `HttpApiBuilder` for the server's fixed endpoints. |
| `effect/http` | api, web, server; all tests | `HttpApiClient.make` needs an `HttpClient` (`FetchHttpClient` in the browser); the server's generic table routes use `HttpRouter` and `HttpServer`. |
| `effect/sql` | server; all tests | `SqlClient`, statements and transactions, under STD's own SQL layer. |
| `effect/observability` | server; all tests | OTLP export of spans and logs. |
| `@effect/sql-pg` | server; all tests | The Postgres driver behind `SqlClient`. |
| `@effect/platform-node` | server; all tests | `NodeHttpServer`, `NodeRuntime.runMain` and the Node implementations of platform services. |
| `@effect/opentelemetry` | server; all tests | OpenTelemetry SDK integration, for deployments with an existing OpenTelemetry setup. |
| `@effect/vitest` | all tests | `it.effect`, `it.layer` and the Effect-aware assertions. |

Plain packages (`values`, `conditions`, `definitions`, `access`, `codegen`) have an empty list. Test files (`test/**/*`) of every profile, plain included, get the server entries plus `@effect/vitest`, so any package's tests can use Postgres; overrides replace the base list, so the entries are repeated.

Every Effect upgrade PR re-reads the API reference of the allowed modules and removes entries for modules promoted to stable.

## "Schema only" in plain packages

Stability diagnostics only flag unstable APIs, so stable `Effect`, `Layer` or `Stream` would pass them. `tooling/check-imports.ts` parses every `src/` file of plain packages with oxc-parser and allows only these `effect` modules, by subpath (`effect/Schema`) or by name from the barrel (`import { Schema } from "effect"`):

| Module | Why plain code needs it |
| --- | --- |
| `Schema` | The point of the rule: field types, records, validation. |
| `SchemaAST` | Walking a schema (codegen, visible-schema derivation). |
| `SchemaGetter`, `SchemaTransformation` | Effect 4 transformations: `decodeTo(target, SchemaTransformation.transform({ decode, encode }))`. |
| `SchemaIssue` | Custom checks report their failures as issues. |
| `SchemaParser` | Parsing without an `Effect` (`decodeUnknownSync`, `decodeUnknownResult`). |
| `Option`, `Result` | What Schema's synchronous decoders return (`decodeUnknownOption`, `decodeUnknownResult`) and what optional fields decode to. |

Everything else is refused, including `Effect`, `Exit`, `Layer`, `Stream`, `Context`, `Predicate`, `Data`, every unstable module and every `@effect/*` package. Tests are not checked.

The check reads every way a file can load a module (static imports and re-exports, `import()`, `require()`, `import x = require()`, `import("...")` types), uses the decoded specifier from the AST, and resolves it to what it loads:

- `effect` and `@effect/*` follow the list above.
- Node built-ins are refused, as `node:x` or as a bare name (`process`, `module`, `fs`, ...): plain packages run in the browser and do no I/O.
- The host globals `process`, `require`, `module`, `exports`, `globalThis`, `global`, `window`, `self`, `Deno` and `Bun`, the string evaluators `eval` and `Function`, `import.meta` and any read of `constructor` (as `.constructor`, as a destructuring key, nested or in an assignment pattern, or as any string literal or substitution-free template, such as ``f[`constructor`]`` or `Reflect.get(f, "constructor")`) are refused wherever they appear as references (destructuring, computed access and local bindings of those names included). Property names such as `a.process` or `{ module: 1 }` are not references and pass.
- Relative, absolute, `file:` and `#` targets must be source files that the check itself scans: an existing regular file inside the package's own `src/`, with a scanned extension (or `.json`), reached without any symlink. The check scans every file under `src/` and refuses any symlink and any `node_modules` directory there, so nothing in `src/` goes unread; local re-exports are therefore covered transitively.
- Another workspace package must have the plain profile, and the subpath must map, through its `exports`, to a source file in its `src/`.
- Any other package must be listed, with a reason, in `tooling/plain-allowed-deps.json` (empty today: `@std/values` needs no third-party runtime package). The check then walks the package's installed dependency graph (`dependencies`, `optionalDependencies`, `peerDependencies`; npm aliases resolved to the package they install; each package once, so cycles end) and refuses the import if `effect` or any `@effect/*` package appears anywhere in it, installed or not.
- `import()` and `require()` need a string literal or a template without expressions.

**Residual risk.** The import check stops accidental and agent-written Effect use, which is what it is for; it is not a sandbox against deliberately hostile code. Code that builds property keys at run time from pieces (`obj[a + b]`) to reach something the rules name can still escape it. Review of plain packages is the guard for that.

The `plain-import-check` canaries (`tooling/canaries/plain-bypass`) cover each route.

## Verified facts (Contracts 9 `[spike]` items)

Checked with `@effect/tsgo` 0.54.1, TypeScript 7.0.2 and `effect` 4.0.5; the canaries in `tooling/test/` keep them true (`pnpm test:canaries`).

1. **Allow-list entry strings.** The entries above work as written. A module entry covers the module and every submodule: `effect/sql` allows `effect/sql/SqlClient`, and `effect/http-api` allows `effect/http-api/HttpApiClient`. Diagnostics name the API as `module#export` (`effect/sql/SqlClient#SqlClient`, `effect/http-api/HttpApiClient#make`, `@effect/vitest#it`), and an entry of that form allows only that export. Matching respects path segments: `effect/http` does not allow `effect/http-api`. Package entries such as `@effect/vitest` work the same way.
2. **Diagnostics fire on use, not on import.** `import { SqlClient } from "effect/sql"` alone passes; `SqlClient.SqlClient` fails. The canaries therefore use an API.
3. **Test override glob.** `"include": ["test/**"]` matches no file; `["test/**/*"]` does. The glob resolves relative to the tsconfig that declares it, so a package cannot inherit the entry through `extends` (its test files would not match). An override replaces only the options it names; the base `diagnosticSeverity` still applies to test files.
4. **`outdatedApi`.** `Effect.catchAll` fails with TS377052 ("uses the Effect v3 API `catchAll` ... Renamed to catch"), as do `Effect.either` and `Effect.zipRight`, plus TS377053 on the import. `Context.Tag` only gets TypeScript's own TS2339.
5. **`duplicatePackage`.** A program that resolves two versions of `effect` fails with TS377051 on every file that imports it.
6. **`effect-tsgo patch` and pnpm hard links.** pnpm hard-links package files from its content-addressed store. The patch renames the store-linked `lib/tsc` of `@typescript/typescript-<platform>-<arch>` to `lib/tsc.original` (same inode) and writes a new `lib/tsc` (link count 1); `unpatch` renames it back. The store copy keeps its inode and content, so no `package-import-method` setting is needed. The `effect-tsgo-patch-and-pnpm` canary proves it on every run with an isolated fixture: a temporary project whose compiler is a deliberate hard link to a sentinel "store" file (shared inode asserted first), patched by the real `effect-tsgo patch`; the sentinel keeps its content and inode, and the fixture's new `tsc` is unshared.
7. **Stability levels.** `@stability unstable` APIs may break in minor releases and `@stability experimental` ones in patch releases (`repos/effect/MIGRATION.md`). Contracts 9 said "minor or patch" for both; fixed there (the plan's "Effect" section uses the same loose wording).
8. **Unstable root modules in 4.0.5.** Most root modules are stable, but these are unstable as modules: `Arbitrary`, `ByteSize`, `ChannelSchema`, `Crypto`, `ErrorReporter`, `ExecutionPlan`, `FileSystem`, `Graph`, `HashRing`, `LayerMap`, `LayerRef`, `Newtype`, `PartitionedSemaphore`, `Path`, `PlatformError`, `Stdio`, `Terminal`, `TxChunk`, `Version`. Stable modules also hold unstable exports (`Schema` has 132 unstable and 46 experimental ones; `Effect`, `Stream`, `Config`, `Logger` a few each). Server code that needs, for example, `FileSystem` adds an entry with a reason here.
9. **Suggestions do not fail tsc.** Effect suggestions such as `preferTypedSchemaDecoder` are printed but leave the exit code at 0 (`ignoreEffectSuggestionsInTscExitCode` defaults to true). Warnings fail it.
10. **Vendored source.** The npm metadata of `effect@4.0.5` names `https://github.com/Effect-TS/effect.git` (directory `packages/effect`) and has no `gitHead`. That repository's tag `effect@4.0.5` is commit `7f524e25cfb49a71ac39b0f44278d08d40dda5de`, whose `packages/effect/package.json` is 4.0.5 (`Effect-TS/effect-smol` only has 4.0 betas). Its tree hash is `208c4ac5b9d8c68a7656cd93b430a3bbede6b41f`. It is vendored at `repos/effect` as a squashed subtree (a squash commit with `git-subtree-dir: repos/effect` and `git-subtree-split: <commit>` trailers, merged into the branch) and recorded in `repos/effect-version.json` (repository, tag, commit, tree). It was first vendored at `vendor/effect`; workstream 0A-foldkit moved it next to `repos/foldkit` (`docs/decisions/0010-foldkit-tooling.md`) by re-vendoring the same tag, which reproduced the same tree hash. `tooling/check-vendor.ts` checks the source, not just labels, with no network and without the upstream commit: the record's tag must be `effect@<lockfile version>` and its repository the one above; `git rev-parse HEAD:repos/effect` must equal the recorded tree, so a single changed vendored file fails; `repos/effect` must have no uncommitted or untracked changes; the latest vendoring commit's `git-subtree-split` must be the recorded commit (CI checks out the full history for this); and the vendored `packages/effect/package.json` must have the lockfile version. The first import fetched the tag with `--depth 1` into this repository, which marked the shared repository shallow; that was undone, and `tooling/vendor.ts` now imports without touching the repository's history or shallow state (see the upgrade procedure). **Residual risk:** the check trusts the record. A change that edits vendored files and also rewrites the recorded tree hash (and the subtree trailer) consistently passes it; the guard against that is review of any diff to `repos/effect-version.json`, which only an Effect upgrade PR should touch.
11. **Oxlint and `repos/`.** `ignorePatterns` alone does not stop Oxlint from loading `repos/effect/.oxlintrc.json` (and failing on its plugins); the root `.eslintignore` keeps Oxlint out of `repos/`. Oxfmt ignores it through `oxfmt.config.ts`, TypeScript and Vitest never include it, and it is not a workspace package.
12. **Lint and `@effect/vitest`.** `sonarjs/no-empty-test-file` does not count `it.effect` as a test, and `vitest/no-standalone-expect` flags `expect` inside an `it.effect` body. Use `assert` from `@effect/vitest` inside `it.effect`, and keep tests in a `describe`.

## Upgrade procedure

**Effect runtime packages: one PR upgrades them all.**

1. Set `effect`, `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` and `@effect/vitest` to the same new version in the catalog, then `pnpm install`.
2. Re-vendor at the matching tag with `pnpm exec node tooling/vendor.ts effect <version>` (index clean first). It clones the tag with `--depth 1` into a temporary directory, makes a parentless commit there that holds only the tag's tree and fetches that one commit (no upstream history and no shallow boundary reach this repository). Here it writes a signed-off squash commit of that tree with the `git-subtree-dir` and `git-subtree-split` trailers, starts a merge of it, replaces `repos/effect` with the tree (`git read-tree --prefix=repos/effect/ -u`) and rewrites `repos/effect-version.json` (version, tag, commit, tree). Review and finish the merge with `git commit -s`. The history is what `git subtree add --squash` produces, so `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash` also works, but it fetches upstream history and leaves the record to be rewritten by hand; prefer the script. Never fetch upstream into this repository with `--depth`; it makes the shared repository shallow.
3. Read the changelogs and API reference of every allowed unstable module (`repos/effect/packages/effect/src/{sql,http,http-api,observability}`, `repos/effect/packages/{sql/pg,platform/node,opentelemetry,vitest}`); fix breakages; remove allow-list entries for modules promoted to stable, here and in `tooling/lib/profiles.ts`, then update every package tsconfig and template.
4. `pnpm ci:local` must pass. Record engineer-hours and breakages per allowed module in `docs/effect-log.md`.

**`@effect/tsgo`: its own PR.** Bump the catalog entry and the `minimumReleaseAgeExclude` entries for `@effect/tsgo` and its platform packages, check that `typescript` is in its supported table, `pnpm install` (the `prepare` script re-patches), run `pnpm test:canaries` (it covers the patch and every diagnostic above), and record the PR in the log.

## Measured review

Tracked from Stage 0 in `docs/effect-log.md` and reviewed at every stage gate. A completed feature is a workstream whose guarantee test passes on main. The thresholds are proposals for Martin [judgment]:

| Measure | How it is counted | Review threshold |
| --- | --- | --- |
| Upgrade effort | Engineer-hours per Effect upgrade PR, plus breakages inside allowed unstable modules | More than 8 hours for a patch or minor upgrade |
| Effect-attributable defects | Defects whose root cause is Effect behavior or an Effect API change, per completed workstream | More than 1 per completed workstream on average, over two consecutive gates |
| Agent rework rate | Share of agent PRs sent back for Effect 3 idioms or Effect misuse | More than 30% over a stage |

Crossing a threshold triggers a decision by Martin at that gate, not an automatic switch: containment (fewer allowed unstable modules, thin wrappers) or a planned migration.

## Contract changes in this PR

Contracts 9: stability levels (fact 7); per-package plugin entries instead of the shared base, because `extends` replaces `plugins` (fact 3); `tsc -p` per package instead of `tsc -b`; the confirmed entry strings and test glob (facts 1 and 3); the patch result (fact 6); the plain-import list; the vendoring source (fact 10).
