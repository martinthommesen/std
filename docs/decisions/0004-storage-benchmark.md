# 0004: Stage 0 storage benchmark

Status: measured 2026-10-20 and 2026-10-21. **The decision rule is formally not met. Provisional decision: keep class-table storage, pending Martin's confirmation.** Every storage model misses the Q6 and Q7 budgets, and the baseline is never more than 2x faster than class-table, so storage does not cause those misses. The read compiler's branch form meets the Q6 budget. Q7 still misses by a small margin (see "Compiler rewrites"). In the committed run, class-table also misses Q2, Q3 and Q4. That run had heavy concurrent load from other work on the machine, and a quieter run met all three (see "Run variance").

Workstream 0E (plan: "Stage 0", gate item on the benchmark; Contracts 2.6).

- Full results, plans, sizes, settings and load: `bench/results/2026-10-21-stage0.md` (and `.json`). Reproduce with `pnpm bench`.
- The compiler-rewrite follow-up: `bench/results/2026-10-21-rewrites.md` (and `.json`). Reproduce with `pnpm bench --rewrites`.
- Both files are from commit `bf70bfa`. They replace the earlier run's files, which are kept in git history at `ad3bbf8` (Stage 0) and `6a8903c` (rewrites).

## What was measured

- **Data.** The hierarchy of Contracts 2.6: four levels, nine classes, 12/8/8/6 own fields with mixed types, and the stated record distribution. There are 50,000 users, referenced from `item.owner`, and `bench.ticket` holds tickets for 20% of the records. Data is generated set-based and deterministically. Record IDs come from `uuidv7()`.
- **Models.** Class-table storage exactly as Contracts 2.1 lays it out, at 1M and 10M records. One table per hierarchy (the baseline) at 10M. Because the rule was not met, three more models at 10M: class-table with `class_id`-led indexes, the LIST-partitioned single table, and one table per concrete class.
- **Requests.** Q1 to Q7 and W1 to W3 as Contracts 2.6 defines them, for the admin caller and the restricted caller. The restricted caller has the row rule `owner = me OR status = "shared"`, a conditional deny on `item.location` compiled as `CASE WHEN` masks, and a `bench.laptop` record rule that reads `classification`.
- **Reads.** 10 warm-up and 200 measured runs with seeded parameters, with p50 and p95 measured at the client. Each read's statements are prepared once with SQL `PREPARE` on one reserved connection and run with `EXECUTE`, so all runs share one prepared statement and its plan cache. Postgres chooses custom or generic plans as it does for STD's prepared statements. The reported plan is `EXPLAIN (ANALYZE, BUFFERS) EXECUTE` of the same prepared statement, on the same connection, with the median run's parameters, after the measured runs.
- **Writes.** 16 clients for 60 s each, through the save pipeline's statement sequence: lock the root alone, read the existing state, write the level row, bump the root version with a version check. Deletes go through the root. W3 deletes disposable laptops that are created for it before the phase starts and are not timed: 480,000 per caller, more than 60 s at the observed rates can use. Every W3 phase ran the full 60 s.
- **Validity check.** The decision is computed only from complete measurements. Every decisive read must be measured, and every write phase must run at least 99% of its 60 s with zero unexpected errors. Rule refusals of restricted writes are expected and reported separately. Otherwise the outcome is `invalid-measurement` and the results file lists each failure. In the committed run, every phase passed: zero errors, and every phase ran 60.0 s.
- **Smoke mode** loads all four models from the same staging tables into one database. It checks that every model returns the same IDs in the same order, and the same counts, for every request. It also checks that the branch form returns the same rows as the plain form in every model. It runs in CI (`bench-smoke`) against the CI Postgres service through `STD_BENCH_DATABASE_URL`.

## Results at 10M (p50 / p95, ms)

From `bench/results/2026-10-21-stage0.md` (commit `bf70bfa`, seed 20261020, 79 min). **Bold** marks a miss. Budgets: Q5 5 ms, Q2 250 ms, the other reads 50 ms, writes 20 ms.

| Request | Budget | class-table 1M | class-table 10M | one table per hierarchy 10M | class-table + `class_id` indexes 10M | partitioned 10M | per concrete class 10M |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 L1, two filters (0.5%), sort | 50 | 1.54 / 2.20 | 0.51 / 0.85 | 0.48 / 0.85 | 0.47 / 0.77 | 0.64 / 1.29 | 0.89 / 1.59 |
| Q2 L1, 30%, depth 10,000, count | 250 | 34.1 / 53.1 | 265 / **384** | 375 / **403** | 244 / **288** | 451 / **504** | 381 / **500** |
| Q3 L4 + L1 filter, sort by L2 | 50 | 7.8 / 9.2 | 50.5 / **57.6** | 33.6 / 40.0 | 74.2 / **92.6** | 27.7 / 30.7 | 28.3 / 47.6 |
| Q4 L3 filter, sort by L1 | 50 | 9.7 / 14.4 | 52.0 / **57.5** | 28.8 / 35.1 | 55.5 / **76.2** | 24.4 / 27.3 | 23.5 / 30.6 |
| Q5 get by id, L1 | 5 | 0.08 / 0.16 | 0.07 / 0.10 | 0.07 / 0.09 | 0.26 / 0.61 | 0.15 / 0.19 | 0.15 / 0.18 |
| Q5 get by id, L4 (all levels) | 5 | 0.12 / 0.22 | 0.12 / 0.13 | 0.10 / 0.11 | 0.26 / 0.38 | 0.11 / 0.15 | 0.09 / 0.26 |
| Q6 Q1 restricted | 50 | 0.45 / 47.5 | 273 / **341** | 309 / **399** | 257 / **350** | 737 / **859** | 641 / **968** |
| Q7 ticket via reference, restricted | 50 | 59.7 / **94.0** | 160 / **178** | 150 / **216** | 155 / **230** | 155 / **173** | 389 / **477** |
| W1 insert laptop (admin), p95 | 20 | 6.2 | 5.4 | 6.8 | 6.4 | 5.9 | 9.6 |
| W2 update L4 field (admin), p95 | 20 | 6.8 | 4.5 | 5.9 | 7.8 | 8.6 | 7.6 |
| W3 delete via root (admin), p95 | 20 | 8.2 | 4.2 | 4.4 | 13.2 | 7.1 | 10.7 |
| Table plus index size |  | 842 MiB | 8,391 MiB | 5,900 MiB | 9,717 MiB | 5,660 MiB | 5,207 MiB |

Every write phase ran 60 s with 16 clients and no errors. Admin writes ran at 2,460 to 5,420 operations per second. The restricted writes (W1 to W3 with existing-state and proposed-state checks) and the restricted variants of Q2 to Q5 are in the results file. They are not decisive, but three are over budget at 10M for class-table: the restricted Q2 count (6.2 s p95, and 6 to 9 s in every model), the restricted Q3 (53.4 ms) and the restricted Q4 (59.0 ms).

## Decision rule

Contracts 2.6: keep class-table if it meets every budget at 10M and one table per hierarchy is not more than 2x faster at p95 on more than one read query. Otherwise, apply the `class_id` index mitigations, then benchmark the other two models and send the decision to Martin.

1. **Class-table at 10M against the baseline:** it misses **Q2** (384 ms), **Q3** (57.6 ms), **Q4** (57.5 ms), **Q6** (341 ms) and **Q7** (178 ms). The baseline is not more than 2x faster on any read query. The ratios are Q1 1.00, Q2 0.95, Q3 1.44, Q4 1.64, Q5 1.19, Q6 0.86 and Q7 0.82. The 2x half of the rule holds and the budget half does not. **Not met.**
2. **With the `class_id` mitigations:** the indexes `item (class_id, updated_at)`, `item (class_id, status, updated_at)`, `item (class_id, cost)`, `device (class_id, warranty_until)` and `computer (class_id, os)`, plus the endpoint's `class_id IN subtree(E)` repeated on every joined level row. It still misses Q2, Q3, Q4, Q6 and Q7. Q3 and Q4 get worse (92.6 and 76.2 ms), and the baseline is more than 2x faster on Q3 (2.31x), Q4 (2.17x) and Q5 (5.6x, at 0.61 against 0.11 ms, both far under budget). The planner walks `device (class_id, warranty_until)` in sort order and probes the laptop level, which is slower here than the `cpu_model` index. **Not met.**
3. The partitioned and per-concrete-class models were benchmarked as the rule requires. Both also miss Q2, Q6 and Q7.

**Outcome: the rule is formally not met.** Under the rule as written, class-table is not kept automatically.

**Provisional decision (2026-10-21): keep class-table storage, pending Martin's confirmation.** Martin was not available, and the instruction was to keep going. The numbers support the provisional decision:

- No storage model meets the budgets. Every model misses Q6 and Q7, and the single-table variants miss Q2 in both runs.
- Class-table is never more than 2x slower than the baseline. It is faster than the baseline on Q2, Q6 and Q7.
- Q3 and Q4 are the cost of class-table joins: 1.4x to 1.8x the baseline across the two runs. They met the budget in the quieter run (48.8 and 48.3 ms) and missed it under load in this run (57.6 and 57.5 ms). Their p50 is near 50 ms in both runs, so they have no headroom.
- The read compiler's branch form brings Q6 to 1.1 ms p95. Q7 reaches 53.2 ms p95 at best, with serial execution and a covering index, and still misses by 3.2 ms (next section).

Consequences:

- **The Q6 form becomes a read-compiler requirement** for ws/0c-reads and the Step 4 rerun: for a restricted list, split the row rule's OR into disjoint branches, within the limits described below.
- **Q7 does not meet its budget** with any form the compiler can generate mechanically from the contract's indexes. The section below lists what it would need. Until one of those options is decided, Q7 stays a known miss and a plan risk ("Known risks").
- **Q3 and Q4 must be rerun on a quiet machine** in Step 4 before they count as passed. If they miss there, the class-table decision needs another look.

## Compiler rewrites for Q6 and Q7 (2026-10-21)

Question: can STD's read compiler, rather than the storage model, meet the Q6 and Q7 budgets on class-table storage? The test generated rewrites that the compiler can produce mechanically from the rule and the request (`compileBranchedList` in `bench/src/compile.ts`). They were measured on class-table at 10M records with the same method as Stage 0: 10 warm-up and 200 measured runs on one prepared statement, then `EXPLAIN (ANALYZE, BUFFERS) EXECUTE` of the median run. All variants of a query use the same parameters. Results: `bench/results/2026-10-21-rewrites.md` (commit `bf70bfa`, seed 20261020, run right after the Stage 0 run, under the same kind of load).

**The branch form.** The compiler splits the row rule's OR into disjoint branches. Branch _k_ is disjunct _k_ AND the negation of the earlier disjuncts, in negation normal form: `owner = me`, then `status = "shared" AND (owner <> me OR owner IS NULL)`. Each branch applies:

- the per-class guard, with the shared rule factored out: `class_id IN (others) OR (class_id = laptop AND NOT denied)`;
- the request's filters, with the same masks;
- the request's sort, keeping its first page (`LIMIT 50`).

The `UNION ALL` of the branches is sorted again and joined back to the endpoint for the selection, masks and labels.

**When the branch form applies.** On the rule's own endpoint (Q6, the restricted Q3 and Q4), always. On a referencing endpoint, the branches run over the reference target: the ticket list's branches run over the ticket's item, one rule disjunct each. That is equivalent only when a filter on the target already excludes every ticket whose item is hidden or empty (NULL). The reason is that the plain form keeps such tickets: the item's rule masks the reference but does not hide the ticket. So the compiler uses the branch form for a referencing list only when the request filters on a target field, and the plain form otherwise (`branchFormApplies`). Q7 filters on `item.location` through the reference, so the branch form applies, and the Q7 numbers below stand.

Checks:

- A deterministic test (`bench/test/branch-form.test.ts`) builds records and tickets in all four storage models: a record matching both rule branches, a hidden laptop that is shared, a record with a NULL owner, a hidden record, and the caller's own non-shared record. It compares the plain and branched rows for Q6 with each status, and for ticket lists with and without a target filter. Hidden targets, NULL references and rows matching both branches come out the same. Removing the `branchFormApplies` guard makes the test fail.
- At 10M, the branch form returned the same rows in the same order as the plain form on 200 requests each of Q6, Q7, and the restricted Q3 and Q4.
- In smoke mode, it does so in all four storage models.

Only the indexes Contracts 2.6 lists were used, except in the two variants marked "covering index".

| Variant | p50 ms | p95 ms | Budget |
| --- | --- | --- | --- |
| Q6, plain form (as in the Stage 0 run) | 255 | 300 | 50 |
| **Q6, branch form** | **0.57** | **1.08** | 50, met |
| Q7, plain form (as in the Stage 0 run) | 162 | 203 | 50 |
| Q7, branch form | 346 | 477 | 50 |
| Q7, branch form, serial (`SET LOCAL max_parallel_workers_per_gather = 0`) | 56.1 | 75.1 | 50 |
| Q7, branch form, serial, custom plans (`SET LOCAL plan_cache_mode = force_custom_plan`) | 59.8 | 81.4 | 50 |
| Q7, branch form, serial, plus the covering index | 42.7 | **53.2** | 50, missed by 3.2 ms |
| Q7, branch form, serial, custom plans, plus the covering index | 46.9 | 59.5 | 50 |

The covering index is `item_rule_probe_idx ON bench.item (id) INCLUDE (status, owner, location, priority, class_id)`. Contracts 2.6 does not list it, and it is not a natural index: it exists only so the item probe becomes index-only.

**Q6 meets its budget.** Each branch uses its own index. The `owner = me` branch reads the user's 200 items through `item (owner)`. The `shared` branch walks `item (status, updated_at)` and stops after 50 rows. When the requested status is not `shared`, Postgres proves the second branch empty (`status = 'ordered' AND status = 'shared'` becomes `One-Time Filter: false`). The plain form's median plan walks about 1M entries of `item (status, updated_at)` with four parallel workers and returns 1 row (1.0M buffer hits, 241 ms).

**Q7 does not meet its budget.** The branch form fixes the `owner = me` branch: about 5 items through `item (owner)`, then tickets through `ticket(item)`, in 0.2 ms. The `shared` branch cannot be resolved first. Shared items with the requested location are about 40,000 items at 10M, and the contract has no index on `location`. Resolving them first took 341 ms (materialized CTE), and 192 ms with an extra `item (status, location)` index (single prototype runs). So the shared branch walks tickets in `updated_at` order and probes the item for each, about 14,500 probes for 50 rows. Median run of the best variant (serial, covering index; the plan Postgres chose is generic), abridged:

```text
Limit (actual time=45.693..45.702 rows=50.00 loops=1)
  Buffers: shared hit=87585
  ->  Sort -> Nested Loop Left Join -> Nested Loop Left Join -> Nested Loop
        ->  Append (actual time=0.189..44.994 rows=51.00 loops=1)
              ->  Subquery Scan on "*SELECT* 1" (actual time=0.189..0.192 rows=1.00 loops=1)
                    ->  … Index Scan using item_owner_idx on item ti_1 (rows=5.00)
                          ->  Index Scan using ticket_item_idx on ticket t_1 (rows=0.20 loops=5)
              ->  Subquery Scan on "*SELECT* 2" (actual time=30.306..44.798 rows=50.00 loops=1)
                    ->  Limit -> Incremental Sort (Presorted Key: t_2.updated_at)
                          ->  Nested Loop Left Join (actual time=1.537..44.777 rows=51.00 loops=1)
                                ->  Nested Loop
                                      ->  Index Scan Backward using ticket_updated_at_idx on ticket t_2 (actual time=0.005..11.970 rows=14518.00 loops=1)
                                            Filter: ((confidential = $4) OR (opened_by = $1))
                                      ->  Memoize (Hits: 7  Misses: 14511)
                                            ->  Index Only Scan using item_rule_probe_idx on item ti_2 (actual time=0.002..0.002 rows=0.00 loops=14511)
                                                  Filter: (((owner <> $1) OR (owner IS NULL)) AND (status = $2) AND (CASE WHEN … THEN location … END = $6) AND …)
                                                  Heap Fetches: 0
                                                  Buffers: shared hit=71130
                                ->  Index Scan using laptop_pkey on laptop ti_laptop_2 (loops=53)
        ->  Index Scan using ticket_id_class on ticket t (loops=51)
Planning Time: 0.009 ms
Execution Time: 45.761 ms
```

Three things decide the cost:

1. **Parallel overshoot.** With parallel workers, the shared branch scans ahead about 229,000 tickets to return 50 (477 ms p95). An ordered `LIMIT` probe like this one must run serially. Serial execution alone brings it to 75 ms p95.
2. **Probe cost.** Each item probe is a primary-key lookup plus a heap fetch. A covering index that makes the probe index-only saves about 25%.
3. **Plan caching.** In the earlier run, through the driver's prepared statements, the generic plan of the serial branch form was about 5x slower than custom plans (341 against 68 ms p95). In this run, with SQL `PREPARE` on one connection, Postgres kept custom plans for the serial variant and chose a generic plan for the covering-index variant. That generic plan was as fast as the custom one, and forcing custom plans gained nothing (81 and 60 ms p95). The generic-plan penalty depends on how the statement is prepared and on the parameter values. ws/0c-reads must measure it on STD's own statements.

What Q7 would need to meet 50 ms reliably (one is enough):

- **A ticket-side access path for the item rule.** For example, keep the reference target's rule inputs on the referencing row: a denormalized `item_status` and `item_location` on `ticket`, kept up to date by the record service, with an index on `(item_status, updated_at)`. This is a design change (Contracts 3.6), not compiler work.
- **A relaxed budget** for list requests whose rule and reference filter together select under 1% of rows in sort order. For example, 100 ms p95 at 10M.
- **A narrower Q7 definition.** Q7 here combines a 10% visibility guard with a 5% masked reference filter, so about 0.4% of tickets qualify. At about 2% density, the same plan runs in about 10 ms.

Both Q7 forms are storage-independent. The same ordered ticket scan with item probes is the plan in every storage model.

## Why the misses happen

- **Q6** (the restricted Q1) is a plan problem in every model. The median plan walks `item (status, updated_at)` for the requested status: about 1M index entries at 10M records, for 1 row. The rule's `owner = me OR status = "shared"` is opaque to the planner's estimates, so it does not drive from the 200-row `owner` index. The branch form fixes it (1.1 ms p95).
- **Q7** costs tens of thousands of nested-loop probes into `item` for 50 tickets (about 72,000 in the plain form's median plan, parallel workers included). The guard admits about 10% of items and the masked `location` filter 5%, so about 0.4% of tickets qualify, scanned in `updated_at` order. The cost does not depend much on the scale (Q7 is 94 ms p95 at 1M), and the same plan appears in every model. The branch form with serial execution and a covering index gets it to 53.2 ms p95.
- **Q2** is dominated by the count: a parallel sequential scan that filters 30% of 10M rows. Class-table is faster than the single-table models on Q2 because its root table is narrower. It was just under budget in the quieter run (244 ms). Under load, its p95 rose to 384 ms while its p50 rose only to 265 ms: the parallel scan competes for CPU.
- **Q3 and Q4** are the cost of class-table joins: 20,000 to 25,000 level rows joined by primary key before the top-N sort. Class-table needs 48 to 58 ms for them, against 27 to 40 ms for the single table.
- **Writes** are bound by commit latency: WAL flushes on the RAID 1 NVMe pair, shared with every other container on the host. Admin p95 ranged from 4.2 to 13.2 ms. The slowest phases (the mitigated, partitioned and per-concrete-class runs) coincide with the most disk writes from other work. The extra level rows of class-table do not show: class-table at 10M had the lowest write p95 of all models in this run.
- **Size:** class-table stores 10M records in 8.4 GB, against 5.9 GB for the single table. The difference comes from the per-level `PRIMARY KEY (id)` and `UNIQUE (id, class_id)` indexes (3.1 GB of indexes against 1.7 GB) and the per-level row headers.

## Run variance

The machine is shared. The host has an AMD Ryzen 7 9700X (8 cores and 16 threads), 62 GiB of memory and two NVMe drives in RAID 1. It also runs other containers and other agents' test runs, including a Postgres test container whose probes issue many fsyncs. The bench container is limited to 8 CPUs by CFS quota (not pinned) and to 32 GB. It was never throttled.

Per phase, the results file records:

- host CPU use, split into the bench container, the harness and everything else ("other");
- write I/Os per second on the host's md devices, with the bench container's share and the rest.

During write phases, the container's counter can exceed the host's, because the two counters do not count merged I/Os the same way. So "other" disk writes in write phases are a lower bound.

| Run | Other CPU, read phases | Other disk writes, read phases | class-table 10M Q2 / Q3 / Q4 p95 | Baseline Q2 / Q3 / Q4 p95 |
| --- | --- | --- | --- | --- |
| Earlier run (`ad3bbf8`) | 0.05 to 0.4 cores | not recorded | 244 / 48.8 / 48.3 | 380 / 31.0 / 27.4 |
| Committed run (`bf70bfa`) | 1.2 to 3.8 cores | 340 to 1,800 IOs/s | 384 / 57.6 / 57.5 | 403 / 40.0 / 35.1 |

The comparisons between models hold in both runs. Class-table is never more than 2x slower than the baseline, and the same requests miss in every model. The absolute numbers moved by up to about 60% at p95. Q2, Q3 and Q4 sit close to their budgets for class-table, so a quiet or dedicated machine is needed before any of them is treated as passed or failed. The committed run is the one that meets the review's method requirements: plans from the measured prepared statements, W3 running the full 60 s, and the validity check.

## Caveats

- **Stage 0 SQL is hand-written** (`bench/src/compile.ts`), mirroring what STD's compiler is specified to generate. Two compiler choices matter. Class IDs are inlined as literals, because they are definition constants. The keyset cursor carries a redundant bound `k <= $k` on a descending first key next to the expanded null-aware predicate, so an index can start at the cursor.
- **Plans are `EXPLAIN ANALYZE` runs.** They execute the median run's statement once more after the measurement, with instrumentation overhead, so their execution time can differ from the median latency.
- **Selectivities are judgment.** Contracts 2.6 fixes them only for Q1 (0.5%) and Q2 (30%). Q3 and Q4 filter 0.5% of the endpoint's records. Q7 filters tickets by the item's `location` (5%), masked for the restricted caller, behind a guard that admits about 10% of items. They were chosen before the 10M runs and not changed afterwards.
- **Supplementary reads** (the restricted variants of Q2 to Q5 and the admin Q7) get 5 warm-up and 30 measured runs, because the restricted Q2 count takes seconds. They are reported, not decisive.
- **Step 4 reruns** the benchmark at 10M with Q1 to Q7 and W1 to W3 issued through the record service (STD-generated SQL, both callers). It must meet the same budgets (plan, Step 4 gate).

## Open questions for Martin

1. **Storage.** Confirm the provisional decision to keep class-table storage. The benchmark found no storage-driven reason to leave it: no 2x losses, and the Q6 and Q7 misses are shared by every model. Formally, the rule as written says "reopen". The class-table-specific risk is Q3 and Q4: about 50 ms p50, which is under budget on a quiet machine and over it under load.
2. **Q7.** Pick one of the options above: denormalized reference rule inputs, a relaxed budget for low-density rule-plus-reference lists, or a narrower Q7. The read compiler alone gets Q7 to 53.2 ms p95, and only with a non-natural covering index.
3. **Compiler requirements.** The branch form for rule-OR lists (on a referencing endpoint only with a target filter) and serial execution for ordered rule-branch queries become ws/0c-reads requirements, provisionally, per this note. Confirm that the record service may set `max_parallel_workers_per_gather` (and, if ws/0c-reads finds generic plans slow, `plan_cache_mode`) per statement.
4. **Q2 count.** Exact counts of 3M rows cost about 240 to 500 ms in every model. Keep exact counts on request (Contracts 3.5) at this cost, or allow an estimate above a threshold? The restricted count takes 6 to 9 s in every model.
5. **Reference machine.** Q2, Q3 and Q4 move across the budget with the load on this shared host. Should Step 4 run on a dedicated machine, or with a recorded load limit?
