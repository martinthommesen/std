# 0004: Stage 0 storage benchmark

Status: measured 2026-10-20. **Decision rule not met; the storage decision is reopened and Stage 0 stops for Martin's decision.**

Workstream 0E (plan: "Stage 0", gate item on the benchmark; Contracts 2.6). Full results, plans, sizes, settings and load: `bench/results/2026-10-20-stage0.md` (and `.json`). Reproduce with `pnpm bench`.

## What was measured

- The hierarchy of Contracts 2.6 (four levels, nine classes, 12/8/8/6 own fields with mixed types, the stated record distribution), 50,000 users referenced from `item.owner`, and `bench.ticket` at 20% of the records. Data is generated set-based and deterministically; record IDs come from `uuidv7()`.
- Class-table storage exactly as Contracts 2.1 lays it out, at 1M and 10M records; one table per hierarchy (the baseline) at 10M; then, because the rule was not met, class-table with `class_id`-led indexes, the LIST-partitioned single table and one table per concrete class, all at 10M.
- Q1 to Q7 and W1 to W3 as Contracts 2.6 defines them, for the admin and the restricted caller (row rule `owner = me OR status = "shared"`, a conditional deny on `item.location` compiled as `CASE WHEN` masks, a `bench.laptop` record rule reading `classification`). Reads: 10 warm-up and 200 measured runs with seeded parameters, p50 and p95 at the client, `EXPLAIN (ANALYZE, BUFFERS)` of the median run. Writes: 16 clients for 60 s each, through the save pipeline's statement sequence (lock the root alone, read the existing state, write the level row, bump the root version with a version check; delete through the root).
- A smoke mode loads all four models from the same staging tables into one database and checks that every model returns the same IDs in the same order (and the same counts) for every request; it runs in CI (`bench-smoke`).

## Results at 10M (p95, ms)

p50 / p95 in milliseconds, from `bench/results/2026-10-20-stage0.md` (commit `2c04d17`, seed 20261020, 70 min). **Bold** marks a miss. Budgets: Q5 5 ms, Q2 250 ms, the other reads 50 ms, writes 20 ms.

| Request | Budget | class-table 1M | class-table 10M | one table per hierarchy 10M | class-table + `class_id` indexes 10M | partitioned 10M | per concrete class 10M |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 L1, two filters (0.5%), sort | 50 | 0.48 / 0.95 | 0.49 / 0.98 | 0.46 / 1.03 | 0.46 / 1.20 | 0.55 / 1.08 | 0.59 / 1.26 |
| Q2 L1, 30%, depth 10,000, count | 250 | 28.7 / 30.2 | 237 / 244 | 367 / **380** | 236 / 244 | 440 / **453** | 344 / **358** |
| Q3 L4 + L1 filter, sort by L2 | 50 | 6.5 / 12.9 | 47.4 / 48.8 | 29.5 / 31.0 | 70.8 / **78.5** | 25.2 / 27.0 | 20.3 / 22.1 |
| Q4 L3 filter, sort by L1 | 50 | 7.2 / 8.4 | 47.1 / 48.3 | 26.1 / 27.4 | 48.9 / **50.8** | 21.6 / 23.0 | 19.4 / 21.4 |
| Q5 get by id, L1 | 5 | 0.08 / 0.11 | 0.07 / 0.12 | 0.10 / 0.14 | 0.07 / 0.09 | 0.11 / 0.23 | 0.12 / 0.14 |
| Q5 get by id, L4 (all levels) | 5 | 0.10 / 0.14 | 0.09 / 0.13 | 0.08 / 0.12 | 0.10 / 0.25 | 0.08 / 0.10 | 0.08 / 0.08 |
| Q6 Q1 restricted | 50 | 0.34 / 40.0 | 232 / **266** | 306 / **353** | 232 / **267** | 628 / **646** | 485 / **500** |
| Q7 ticket via reference, restricted | 50 | 58.2 / **67.4** | 145 / **158** | 135 / **152** | 152 / **166** | 154 / **171** | 336 / **387** |
| W1 insert laptop (admin) | 20 | 5.4 | 5.1 | 3.8 | 4.7 | 4.1 | 4.0 |
| W2 update L4 field (admin) | 20 | 4.7 | 4.8 | 4.6 | 4.6 | 4.9 | 4.7 |
| W3 delete via root (admin) | 20 | 4.1 | 4.5 | 3.9 | 4.4 | 4.1 | 5.0 |
| Table plus index size |  | 841 MiB | 8,391 MiB | 5,899 MiB | 9,716 MiB | 5,659 MiB | 5,206 MiB |

Write rows give p95 only; every write ran at about 5,100 to 5,600 operations per second with 16 clients and no errors. The restricted writes (W1 to W3 with existing-state and proposed-state checks) and the restricted variants of Q2 to Q5 are in the results file. They are not decisive, but three are over budget at 10M for class-table: the restricted Q2 count (6 s p95, and 5 to 7 s in every model), the restricted Q3 (52.9 ms) and the restricted Q4 (56.8 ms).

## Decision rule

Contracts 2.6: keep class-table if it meets every budget at 10M and one table per hierarchy is not more than 2x faster at p95 on more than one read query. Otherwise, after the `class_id` index mitigations, benchmark the other two models and send the decision to Martin.

1. **Class-table at 10M against the baseline:** it misses **Q6** (266 ms) and **Q7** (158 ms). The baseline is not more than 2x faster on any read query: the ratios are Q1 0.95, Q2 0.64, Q3 1.58, Q4 1.76, Q5 0.98, Q6 0.75 and Q7 1.04. The 2x half of the rule holds and the budget half does not. **Not met.**
2. **With the `class_id` mitigations** (indexes `item (class_id, updated_at)`, `item (class_id, status, updated_at)`, `item (class_id, cost)`, `device (class_id, warranty_until)`, `computer (class_id, os)`, and the endpoint's `class_id IN subtree(E)` repeated on every joined level row): it still misses Q6 and Q7, and now also **Q3** (78.5 ms, 2.5x the baseline) and **Q4** (50.8 ms). The planner walks `device (class_id, warranty_until)` in sort order and probes the laptop level, which is slower here than the `cpu_model` index. **Not met.**
3. The partitioned and per-concrete-class models were benchmarked as the rule requires. Both also miss Q2, Q6 and Q7.

**Outcome: reopen.** Under the rule as written, class-table is not kept automatically, and **Stage 0 stops here for Martin's decision.** The numbers point one way, though. No storage model meets the budgets: every model misses Q6 and Q7, and the three single-table variants also miss Q2. Class-table is never more than 2x slower than the baseline. It is the fastest model on Q2 and Q6, within 4% of the baseline on Q7, and its misses are the misses every model has. Q3 and Q4 are where the joins cost (1.6x and 1.8x the baseline), and both stay under budget.

## Why the misses happen

- **Q6** (the restricted Q1) is a plan problem in every model. The median plan walks `item (status, updated_at)` for the requested status: about 1M index entries at 10M records, estimated at 416 rows, actual 2. The rule's `owner = me OR status = "shared"` is opaque to the planner's estimates, so it does not drive from the 200-row `owner` index. When the requested status is `shared` itself, the rule and the filter overlap. A compiler that simplifies the rule against the filter, or a plan that drives from `owner`, would fix it for any storage model.
- **Q7** costs about 37k nested-loop probes into `item` for 50 tickets. The guard admits about 10% of items and the masked `location` filter 5%, so about 0.5% of tickets qualify, scanned in `updated_at` order. The cost does not depend on the scale (Q7 is 67 ms at 1M), and the same plan appears in every model.
- **Q2** is dominated by the count: a parallel sequential scan that filters 30% of 10M rows. Class-table is the fastest model on Q2 (244 ms, just under budget) because its root table is narrower than the single table's. Any model with wider rows misses.
- **Q3 and Q4** are the cost of class-table joins: 20,000 to 25,000 level rows joined by primary key before the top-N sort. That is 48 to 49 ms against 27 to 31 ms for the single table: under budget, with little headroom.
- **Writes** are bound by commit latency (WAL flush on the RAID 1 NVMe pair). Every model runs at about 5,000 operations per second with p95 near 5 ms, so the extra level rows of class-table do not show.
- **Size:** class-table stores 10M records in 8.4 GB, against 5.9 GB for the single table. The difference comes from the per-level `PRIMARY KEY (id)` and `UNIQUE (id, class_id)` indexes (3.1 GB of indexes against 1.7 GB) and the per-level row headers.

## Caveats

- **Shared machine.** The host (AMD Ryzen 7 9700X, 8 cores and 16 threads, 62 GiB, two NVMe drives in RAID 1) also runs other containers and other agents' test runs. The bench container is limited to 8 CPUs by CFS quota (not pinned) and 32 GB; it was never throttled. The results file records, per phase, host CPU use split into the bench container, the harness and everything else ("other" was 0.05 to 0.4 cores). Absolute numbers would be somewhat better on an idle machine; the comparisons between models ran under similar conditions.
- **Stage 0 SQL is hand-written** (`bench/src/compile.ts`), mirroring what STD's compiler is specified to generate. Two compiler choices matter: class IDs are inlined as literals (definition constants), and the keyset cursor carries a redundant bound `k <= $k` on a descending first key next to the expanded null-aware predicate, so an index can start at the cursor. Statements are prepared, as STD's will be; Postgres may switch to generic plans after five executions, and the reported plans are `EXPLAIN ANALYZE` runs with the median run's parameters.
- **Selectivities are judgment.** Contracts 2.6 fixes them only for Q1 (0.5%) and Q2 (30%). Q3 and Q4 filter 0.5% of the endpoint's records; Q7 filters tickets by the item's `location` (5%), masked for the restricted caller, behind a guard that admits about 10% of items. They were chosen before the 10M runs and not changed afterwards.
- **Supplementary reads** (the restricted variants of Q2 to Q5 and the admin Q7) get 5 warm-up and 30 measured runs, because the restricted Q2 count takes seconds; they are reported, not decisive.
- **W3 deletes the laptops W1 created** (no ticket references them), so several W3 phases end before 60 s when those run out; throughput and latency are over the time they ran.
- **Step 4 reruns** the benchmark at 10M with Q1 to Q7 and W1 to W3 issued through the record service (STD-generated SQL, both callers) and must meet the same budgets (plan, Step 4 gate).

## Open questions for Martin

1. **Storage.** Keep class-table storage? The benchmark found no storage-driven reason to leave it: no 2x losses, and the budget misses are shared by every model. The rule as written still says "reopen", so this needs your call.
2. **Budgets for restricted lists (Q6, Q7).** Should these budgets hold for the restricted caller in Stage 0, or move to Step 1 and Step 4 as compiler work? The fixes are in query compilation, not storage: simplify rule predicates against the request's filters, check the plans STD gets for rule-shaped `OR` predicates (custom versus generic plans), and consider indexes that serve the rule, such as `(owner, updated_at)`.
3. **Q2 count.** Exact counts of 3M rows cost about 240 to 450 ms in every model. Keep exact counts on request (Contracts 3.5) with this cost, or allow an estimate above a threshold? The restricted count takes 5 to 7 s in every model.
4. **Run variance.** A first full run on the same machine with more concurrent load (up to 2 other cores busy) measured class-table Q2 at 290 ms and Q4 at 61 ms, over budget, against 244 and 48 ms in the committed run. Q2, Q3 and Q4 sit within about 5% of their budgets, so a dedicated reference machine is needed before any of them is treated as passed or failed with confidence.
