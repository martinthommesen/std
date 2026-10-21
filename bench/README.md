# @std/bench: the inheritance benchmark

Stage 0 workstream 0E (plan: "Stage 0", Contracts 2.6). It measures class-table storage against one table per hierarchy (and, when the decision rule asks for it, the LIST-partitioned and per-concrete-class models) and applies the decision rule.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm bench` | The Stage 0 run: class-table at 1M and 10M, one table per hierarchy at 10M, the decision rule; then the `class_id` index mitigations and the other two models if the rule asks for them. Writes `bench/results/<yyyy-mm-dd>-stage0.md` and `.json`. About 80 minutes on the reference machine. |
| `pnpm bench --scale 1m --model class-table` | A custom run. `--scale` takes `50k`, `1m`, `10m` (or a comma list), `--model` takes `class-table`, `single-table`, `partitioned`, `concrete-table`, `all` (or a comma list). `--mitigations` adds the `class_id`-led indexes to class-table. Writes `results/<date>-custom-...`. |
| `pnpm bench --rewrites` | Q6 and Q7 in the read compiler's branch form (row rule OR split into UNION ALL branches) on class-table at 10M, against the plain form, after an equivalence check on 200 requests each; also Q7 with custom plans, serial execution and a covering index. Writes `results/<date>-rewrites.md` and `.json`. About 10 minutes. |
| `pnpm bench --smoke` | All four models at 50k records in one fresh database, a cross-model equivalence check (every model returns the same IDs in the same order for every request, and the branch form returns the same rows as the plain form), and a short measurement. Writes to `results/raw/` (ignored by git). |
| `pnpm --filter @std/bench test` | Runs the smoke mode end to end in a fresh database (`bench-smoke`), the branch-form equivalence cases in all four models, and the decision rule's validity check. |

Other options: `--seed`, `--warmup`, `--runs`, `--write-seconds`, `--clients`, `--out <dir>`, `--database <name>` (smoke mode), `--no-writes`, `--keep` (do not drop the benchmark databases), `--reuse` (reuse an already generated database; development only, since writes change the data).

## The bench database

The benchmark never uses the test database on 54329. `bench/docker-compose.yml` runs a dedicated Postgres 18 (`std-bench-postgres`, volume `std-bench-pg`, `127.0.0.1:54330`, user, password and database `bench`) limited to the reference machine (8 CPUs, 32 GB) and tuned for it. `pnpm bench` starts it if it does not answer. `STD_BENCH_DATABASE_URL` (read through Effect `Config`) points the harness at another server; GitHub CI points it at the CI Postgres service, where the smoke test creates and drops its own small database. Every run creates its own database (`bench_<model>_<scale>`) and drops it afterwards; the test and smoke mode use a fresh `bench_smoke_*` database.

## Layout

| File | Contents |
| --- | --- |
| `src/hierarchy.ts` | The nine classes, their fields (types, generators, null shares) and the record distribution |
| `src/models/` | One module per storage model: DDL, bulk load, the relation queries compile against, the write statements; `common.ts` has `core.user`, the staging tables and `bench.ticket` |
| `src/generate.ts` | Set-based generation: staging tables (UUIDv7 IDs from `uuidv7()`), parallel `INSERT ... SELECT` per model, keys, foreign keys, indexes, triggers, `VACUUM (ANALYZE)` |
| `src/access.ts`, `src/compile.ts`, `src/keyset.ts` | The callers' rules and a hand-written stand-in for STD's read compiler: visibility in `WHERE`, `CASE WHEN` masks, guarded reference joins, the null-aware keyset cursor |
| `src/workload.ts`, `src/measure.ts`, `src/writes.ts` | Q1 to Q7 and their parameters, the read measurement, W1 to W3 with 16 clients |
| `src/decision.ts`, `src/pipeline.ts`, `src/report.ts` | The decision rule, the run orchestration and the results files |

## Method notes

- Data values are pure functions of the record number (per-field salts through `hashint8extended`), so the data is the same in every run; record IDs come from `uuidv7()`, and the same seed picks the same logical records as parameters in every database.
- Keys, foreign keys and indexes are added after the bulk load; the final schema is the same as creating them up front (Contracts 2.1).
- Class IDs are inlined as literals (they are definition constants, like identifiers); every other value is a bound parameter with a cast.
- Reads run one at a time, each in its own READ COMMITTED transaction; latencies are measured at the client. Each read's statements are prepared once with SQL `PREPARE` on one reserved connection and run with `EXECUTE`, so Postgres's plan cache behaves as it will for STD's prepared statements. The reported plan is `EXPLAIN (ANALYZE, BUFFERS) EXECUTE` of the same prepared statement, on the same connection, with the median run's parameters.
- W3 deletes disposable laptops created for it before the phase (not timed), enough for the full 60 s.
- The decision rule is applied only to complete measurements, for every run it uses (including the two fallback models): every decisive read present and measured, W1 to W3 present for both callers, every write phase error-free and run for at least 99% of its time. A missing read or phase counts as a failure, so `--no-writes` runs are never judged. Otherwise the outcome is `invalid-measurement`, with each failure listed.
- Stage 0 SQL is hand-written; Step 4 reruns the same requests through the record service.
