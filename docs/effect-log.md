# Effect measurement log

The measured review of the plan's "Effect" section. Every Effect upgrade PR, every defect whose root cause may be Effect, and every agent PR sent back for Effect reasons adds a row here in the same PR. The thresholds and the upgrade procedure are in `docs/decisions/0001-effect.md`; they are reviewed at every stage gate.

## Upgrades

One row per Effect upgrade PR (runtime packages together, or `@effect/tsgo` alone).

| Date | PR | Packages | From | To | Kind (patch, minor, major) | Engineer-hours | Breakages per allowed module | Allow-list entries removed | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-20 | ws/0a-toolchain | effect and `@effect/*` runtime | none | 4.0.5 | initial | n/a | none | none | Baseline pins; vendored `effect@4.0.5` (7f524e2) |
| 2026-10-20 | ws/0a-toolchain | `@effect/tsgo` | none | 0.54.1 | initial | n/a | none | n/a | Baseline pin with TypeScript 7.0.2 |

No upgrade PR since the baseline. On 2026-10-21 the catalog in `pnpm-workspace.yaml` and the lockfile still pin `effect` and the `@effect/*` runtime packages at 4.0.5 and `@effect/tsgo` at 0.54.1. The catalog's only later change, in `ws/1c-authz-complete`, added `oxc-parser`.

## Defects

One row per defect with a possible Effect cause. "Effect root cause" is yes only when the cause is Effect behavior or an Effect API change.

| Date | Issue or PR | Workstream | Completed workstream? | Effect root cause | Module | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-21 | ws/0a-sql-layer, review r3 (fix 9618572) | 0A | yes | no | `effect` (fibers) | A fiber that existed before the request transaction, holding a leaked transaction handle, was enrolled in the transaction, and the sweep before the commit decision could deadlock waiting for it. STD's fiber binding was at fault; it now refuses fibers created before the transaction's own fiber. The fix relies on Effect 4.0.5 allocating fiber IDs from a monotonic counter, which review r4 checked. The r3 result text is not in the review log; reconstructed from the fix commit and r4 |
| 2026-10-21 | ws/0a-sql-layer, review r6 finding 1 (fix d91d58c) | 0A | yes | no | `effect` (`Exit`, `Cause`) | Once an attempt had seen a lock timeout, the config-commit retry turned any failed exit into a retryable lock timeout, so a defect from an error handler or a dying scope finalizer was lost behind `SchemaLockTimeout`. STD's cause handling was at fault; an attempt is now retried only when its cause holds nothing but lock timeouts (55P03) |
| 2026-10-21 | ws/1b-config-layers | 1B | yes | yes (type level) | `effect` (`Effect.fn`) | `Effect.fn` with a whole-function transform (`Effect.scoped`) inferred a call signature without parameters for a generator whose parameter has a default: that overload infers the arguments from the transform as well as from the body. `tsc` caught it, so nothing shipped wrong; an explicit function type on the constant fixes it, as `runPlatformMigrations` already did. Found by the writing agent, not by review |

| 2026-10-22 | ws/3b-outbox-worker | 3B | no | no | `effect` (`Effect.forEach`, `Effect.forkChild`) | The soak test forked its 8 worker loops with `Effect.forkChild` inside `Effect.forEach(..., { concurrency: "unbounded" })`: each element runs in its own fiber, which ended at once and took its child with it, so no worker ever ran. Documented fiber supervision, misused by the test; the workers are now forked from the test's own fiber. Found by the writing agent, not by review |

## Agent rework

One row per agent PR. "Sent back" is yes when review returned it for Effect 3 idioms or Effect misuse.

Sources: the GPT-6.1-Sol code review results of each branch, in time order, and the branches' fix commits. For some early rounds the log of review results holds only a completion notice, without findings: `ws/1d-values` r1 and r2, `ws/0a-toolchain` r1 to r3, `ws/0a-sql-layer` r1 to r3, `ws/1d-conditions` r1 to r3 and `ws/0f-probes` r1 and r2. For those rounds the notes rely on the fix commits, which cite the round and finding they answer. Rows are in merge order on `main`. `ws/1a-schema-lifecycle` is not merged and has no row yet; its reviews so far (A, B, item 9 and rounds 2 to 5) raised no Effect findings.

| Date | PR | Workstream | Sent back | Reason (Effect 3 idiom, misuse, other) | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-20 | ws/1d-values (merge b0638ce) | 1D (values) | no | other | r1, r2: results not in the log; the one fix commit between them (05232bd) encodes by field kind and separates transport and field JSON depth. Plain package, Schema only |
| 2026-10-20 | ws/0a-toolchain (merge 81f6035) | 0A | no | other | r1 to r3: results not in the log; fix commits cite r1 findings 1 to 6 (import resolution in plain `src/`, vendored tree hash, authenticated Postgres check, patch canary), r2 (simpler plain-import rules) and r3 (`constructor` reads). Tooling; no Effect code under review |
| 2026-10-20 | ws/1d-conditions (merge 535081b) | 0D, 1D (conditions) | no | other | r1 to r3: results not in the log; fix commits for r1 and r2 cover write-only states, null-aware simplification, checker validation and depth limits. Plain package, Schema only |
| 2026-10-21 | ws/0a-foldkit-tooling (merge fc201da) | 0A (web toolchain) | no | none | r1: approve, no findings |
| 2026-10-21 | ws/0a-sql-layer (merge 1f19457) | 0A (driver), 1A/1B groundwork | yes | misuse | Effect skill review r1: `catchCause` turned defects and interruption into logged success (`wake-up.ts`, test-database janitor); `Effect.callback` spawned the migration CLI without interruption cleanup (`platform-migrations.test.ts`); missing `Effect.fn` boundaries on `request`, `maintenance`, `configCommit`, dedicated-connection and migration operations; hand-rolled retry with `Effect.sleep` instead of `Effect.retry` and a `Schedule` (`config-commit.ts`); `process.env` instead of `Config`; sleeps instead of `TestClock`, `Deferred` or `Latch` in tests. r6 finding 1: defects and interruption lost after a lock timeout (see Defects). Other rounds: `readOnly` and the statement lexer (r4 to r7); approve at r8. Ambiguous: r1 to r3, whose text is missing, also led to fiber and scope fixes in the transaction code (63b19b7, 52af843, 9618572); counted as transaction design, not Effect misuse |
| 2026-10-21 | ws/0f-probes (merge 853b851) | 0F | yes | misuse | r4 finding 3: reusable functions, including `capUnbudgetedWaits`, still wrapped `Effect.gen` instead of `Effect.fn` or `Effect.fnUntraced`, and `index-build-child.ts` read `STD_DATABASE_URL` directly instead of through `Config`. Other rounds: lock budget and lock inventory (r1 to r4); approve at r5. The r3 fix (95225c9) also replaced hand-rolled polling sleeps with a bounded `Schedule` "per the effect skill", which the recorded r3 findings did not ask for |
| 2026-10-21 | ws/0a-sql-read-tuning (merge 40dfefb) | 0A follow-up | no | other | r1: failed nested units could change the outer transaction's timeouts through exempted `SET LOCAL`; r2: approve |
| 2026-10-21 | ws/0b-schema-core (merge 12abdaf) | 0B, 1A (core) | yes | misuse | Effect skill review r1: `Effect.exit` treated defects as retryable step failures, and a manual attempt loop stood in for `Effect.retryOrElse` with `Schedule.recurs` (`coordinator.ts`); catalog reload recovery caught every cause, defects included (`catalog.ts`); hand-rolled bounded cache instead of `Cache.makeWith`; missing `Effect.fn` boundaries (`change-set.ts` and helpers); sleeps instead of `Queue` or `Deferred` in tests; raw object instead of `Catalog.of`; synchronous decode at the YAML boundary instead of `Schema.decodeUnknownEffect`. r2 finding 4 (P3): exported layers instead of the service convention's static `layer` members. Other findings: definition validation, DDL planning and the unique preflight (r1 A and B, r2, r3); approve at r4 |
| 2026-10-21 | ws/0c-reads (merge 33b8aa1) | 0C | no | other | r1 A: sessions, stale checks, untagged 400 on a malformed sign-in body; r1 B: hash leak through labels, invalid SQL, password nulls, and "no additional findings in ... Effect usage"; r2: deactivation race, stale scope; r3: approve. The untagged 400 involved `HttpApi` payload decoding but was a contract finding (Contracts 3.8) |
| 2026-10-21 | ws/0c-writes (merge 418fecd) | 0B, 0C, 1E (history) | no | other | Phase 1 r1 to r3: validation after hooks, existing-state checks, operation IDs (including a race on the per-transaction `WeakMap`), projection. Phase 2 A and B r1, r2: hidden fields in errors, history snapshot, stale creates, JSON shaped like secret states. Approve at phase 2 r3 |
| 2026-10-21 | ws/1d-differential-coverage (merge 931a5d3) | 1D (coverage gate), 0D follow-up | no | other | r1: a first case cut off by fast-check's time limit could hide a disagreement; r2: the regression test depended on timing; r3: approve. fast-check, not Effect. Not listed in `docs/workstreams.md` |
| 2026-10-21 | ws/1e-outbox-producer (merge 95d5f21) | 1E | no | other | r1: the version invariant property test did not guarantee delete coverage; r2: approve |
| 2026-10-21 | ws/0e-bench (merge ac3c404) | 0E | yes | misuse | r1 finding 5 (P3): `measureRead` and the generation, pipeline and write helpers returned `Effect.gen` instead of named `Effect.fn` boundaries (`Effect.fnUntraced` on hot paths). Findings 1 to 4 (branch-form semantics, plan capture, decision validity, W3 duration) and r2 (measurement inventory, fallback validation, decision note) are other; r3: approve. Ambiguous: the only Effect finding was a P3 beside four P2s, and the branch had already applied the Effect skill once before r1 (a004c04) |
| 2026-10-21 | ws/1b-config-layers (merge e8cebcb) | 1B | no | other | Reviewed four times: r1 A (`--json` changed the database, failed follow-ups reported success, conflict values, self-dependencies, migration list) and r1 B (doctor locks and transaction, override, platform-table and constraint checks, runbook); r2 and r3: doctor drift detection; r4: approve. No Effect findings. The `Effect.fn` inference issue is under Defects |
| 2026-10-21 | ws/0a-lock-holder-sampling (merge b3b4a37) | 0A follow-up | no | other | r1: fallback lock holders not filtered by `pg_locks.database`; r2: approve |
| 2026-10-21 | ws/0a-test-isolation (merge 9b60892) | 0A follow-up | no | other | r1: the janitor did not recheck a template's expiry under its lock; r2: approve |
| 2026-10-21 | ws/1c-authz-complete (merge 623cbad) | 1C | no | other | r1 A: fuzz oracle, coverage gate, wildcard contract, no-bypass scanner; r1 B: OpenAPI revision check, history stale scope; r2: approve; r3 to r5 (after merging main): no-bypass scanner exemptions and route coverage; r6: approve |

## Gate reviews

Filled in at each stage gate from the tables above.

| Gate | Date | Upgrade hours (max per patch or minor PR) | Effect defects per completed workstream | Agent rework rate | Threshold crossed | Decision by Martin |
| --- | --- | --- | --- | --- | --- | --- |
| Stage 0 | 2026-10-21 | n/a (no upgrade PR) | 0 (no defect with an Effect root cause; 6 completed workstreams, 0A to 0F) | 33% (4 of 12: `ws/0a-sql-layer`, `ws/0f-probes`, `ws/0b-schema-core`, `ws/0e-bench`) | Yes: the agent rework rate, 33%, is above the 30% threshold. Upgrade effort and Effect-attributable defects are below theirs |  | 2026-10-22: keep Effect as is (misuse concentrated in Stage 0; Step 1 and Step 2 at 0%); measure again at the next gate. |
| Step 1 (provisional, 1A not yet merged) | 2026-10-21 | n/a (no upgrade PR) | 0.25 (1 defect with an Effect root cause, the type-level `Effect.fn` inference in 1B; 4 completed workstreams, 1B to 1E) | 0% (0 of 5) | No, so far |  |

A branch counts for Stage 0 when `docs/workstreams.md` lists a Stage 0 workstream (0A to 0F) for it, follow-ups included, and for Step 1 otherwise:

- Stage 0 (12 branches): `ws/0a-toolchain`, `ws/1d-conditions` (0D and 1D), `ws/0a-foldkit-tooling`, `ws/0a-sql-layer`, `ws/0f-probes`, `ws/0a-sql-read-tuning`, `ws/0b-schema-core`, `ws/0c-reads`, `ws/0c-writes`, `ws/0e-bench`, `ws/0a-lock-holder-sampling` and `ws/0a-test-isolation`. The last two are 0A follow-ups merged during Step 1 work.
- Step 1 (5 branches): `ws/1d-values`, `ws/1d-differential-coverage` (not in the tracker; it delivers 1D's coverage gate), `ws/1b-config-layers`, `ws/1e-outbox-producer` and `ws/1c-authz-complete`.

The Stage 0 result depends on this split and on one judgment:

- `ws/1d-values` also carries 0D's exhaustive fold-table test, and `ws/1d-differential-coverage` hardens 0D's differential test. Counting one of them for Stage 0 gives 4 of 13 (31%), still above the threshold. Counting both gives 4 of 14 (29%), below it.
- Not counting `ws/0e-bench`, whose only Effect finding was a P3, gives 3 of 12 (25%).

Every send-back was for Effect misuse: error-channel handling, missing `Effect.fn` boundaries, hand-rolled retry, polling and caching instead of `Schedule` and `Cache`, and `process.env` instead of `Config`. None was for an Effect 3 API, which `tsc` already refuses (`outdatedApi`, or TS2339 for `Context.Tag`). All four send-backs date from 2026-10-21, after the Effect agent skills and the rule to use them were added (0fc3ad6) and reviews began to check against them; the three branches merged on 2026-10-20 were reviewed before that.

Completed workstreams are those whose guarantee test passes on `main`, taken from the passing `pnpm ci:local` runs in each branch's final review; CI was not rerun for this log. In Stage 0, 0B's two-user write scenario comes from `ws/0c-writes`, and 0D's tests come from `ws/1d-conditions` and `ws/1d-values`.
