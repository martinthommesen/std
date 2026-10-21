# 0013. Outbox producer: subscriptions, delivery rows, claims at SQL level

Status: accepted, 2026-10-21 (workstream 1E, the outbox producer side). Builds on decisions 0002 (after-commit actions, `makeWorkerWakeup`), 0006 (the subscription definition kind), 0007 (probe 6: in-transaction NOTIFY) and 0009 (the `SaveHooks.deliveries` seam, change entries). Code: `packages/definitions/src/{dependencies,validate}.ts`, `packages/server/src/platform/migrations/0007-outbox.ts`, `packages/server/src/records/outbox-producer.ts`, `packages/server/src/outbox/{delivery-claims,lease-lost}.ts`, `packages/server/src/http/app.ts`.

## Decision

Every save writes, in its own transaction and right after its change entry, one `core.delivery` row per matching subscription (Contracts 4.1 step 9, 4.6). After commit it registers the debounced worker wake-up (step 11); nothing is notified inside the transaction. The worker-facing statements (claim, fenced `done` and failure, backoff) exist now as an internal module, proven at SQL level; the worker loop, its effects, the admin view and operator actions are Step 3 (3B).

## Modules

| Module | What it provides |
| --- | --- |
| `@std/definitions/dependencies` | the `subscription_on` dependency kind (a subscription to its class, Contracts 1.7), next to the existing `condition_reads` |
| `@std/definitions/validate` | a subscription on a platform table is `invalidSubscription` (its rows never pass the save pipeline, so it could never fire) |
| `platform/migrations/0007-outbox` | `core.delivery` (below) |
| `records/outbox-producer` | `matchingSubscriptions(snapshot, { kind, classId, image }, { now, timeZone })` (pure), `writeDeliveries(input)` (`Effect.fn`, needs `SqlClient`, `CurrentTransaction`, `WorkerWakeup`, `InstanceSettings`), `OutboxSaveHooks` (a `SaveHooks` layer: `deliveries` = `writeDeliveries`, no before-write or after-write hooks) |
| `records/save-hooks` | `SaveHooksApi.deliveries` may also require `CurrentTransaction` (to register the after-commit wake-up) |
| `outbox/delivery-claims` | `claimDeliveries`, `markDone`, `markFailed`, `retryDelay`, `claimStatement`, `ClaimInput`, `ClaimedDelivery`, `DeliveryLease`, `FailureInput`, `FailureOutcome`, `DeliveryStatusSchema`, `DeadLetterPolicy`, `RETRY_BASE`, `RETRY_CAP`, `RETRY_JITTER`, `LAST_ERROR_MAX_LENGTH` |
| `outbox/lease-lost` | `LeaseLost` (`deliveryId`), the typed failure of a fenced update that changed no row |
| `http/app` | the write routes use `OutboxSaveHooks`; `HttpAppLayer` now also needs `WorkerWakeup` (part of the SQL layer) |

## Subscriptions

Subscriptions were already modelled by the schema engine (decision 0006): `core.subscription` (migration 0002, described by the core set), the `subscription` definition kind with `classId`, `operations`, `condition` (checked in the subscription profile, 5.10), `identityId`, `maxAttempts` (set files default 10), `deadLetter` (`block` default, or `skip`), `enabled` and the owner layer of every definition. They are written through change sets (`createSubscription`, updates by ID, set files), never through the save pipeline, so changing a subscription produces no delivery. This workstream added the `subscription_on` dependency and the platform-table refusal.

The producer reads the subscriptions of the request's config snapshot. A subscription matches a change when it is `active` (not retired) and `enabled`, its class is in the lineage of the record's concrete class (so a subscription on `acme.asset` covers laptops and monitors, and one on `acme.laptop` covers neither assets nor monitors), it lists the change's kind, and its condition holds. The condition is checked against the snapshot (`purpose: "evaluate"`, so a retired field still reads), resolved with `now` and the instance time zone, and evaluated in TypeScript on the version's own image: `after` for create and update, `before` for delete (4.5). A condition that no longer checks or resolves is a defect that fails the save: the definition checks refuse such a subscription, so the snapshot is inconsistent, and failing is better than dropping a delivery silently.

## `core.delivery` (migration 0007)

| Column | Meaning |
| --- | --- |
| `id` | `bigint GENERATED ALWAYS AS IDENTITY`, primary key; orders claims, never a cursor |
| `subscription_id` | FK to `core.subscription`, `NO ACTION` (`delivery_subscription`) |
| `change_id` | FK to `core."change"`, `NO ACTION` (`delivery_change`); the idempotency key of every effect |
| `record_id`, `record_version` | the change entry's record and version (a delete's is the current version + 1); no FK, deliveries outlive records |
| `status` | `pending`, `in_flight`, `done`, `dead` |
| `attempts` | how many times the row was claimed |
| `next_attempt_at` | when a `pending` row is due; the save's transaction time on insert |
| `lease_until`, `lease_token` | set exactly while `in_flight` (CHECK `delivery_lease`) |
| `last_error` | the last failure's text, at most 2,000 characters |

`UNIQUE (subscription_id, change_id)` (`delivery_subscription_change`) and the partial index `delivery_order ON (subscription_id, record_id, record_version) WHERE status <> 'done'`. The table holds IDs only, so no field value and no secret is ever copied into it (4.3); payloads are built from the change entry when the delivery runs. It is a platform table without a root-class layout (its key is a bigint), so the core set does not describe it and the generic API does not reach it; the Step 3 admin view reads it directly.

Migration ids: 0005 belongs to `ws/1b-config-layers` and 0006 to `ws/1a-schema-lifecycle`. `migrations.ts` lists them in `RESERVED_IDS`, and `validateMigrations(migrations, reserved)` (the same change as on `ws/1b-config-layers`) accepts the gap. To renumber at merge: rename `0007-outbox.ts` and its export, change its `id`, and update `RESERVED_IDS` and the id lists in `platform-migrations.test.ts` and `test-database.test.ts`. The checksum covers only the kind and the statements, so the id can change freely before release.

## Producer (step 9 and step 11)

`writeDeliveries` runs in `recordChange`, after `writeChangeEntry` and before the after-write hooks, inside the save's request transaction (joined when nested). It inserts every matching subscription's row with one statement (`INSERT ... SELECT ... FROM unnest($4::uuid[]) WITH ORDINALITY`), status `pending`, `attempts` 0, `next_attempt_at` the transaction's millisecond timestamp. If it inserted anything, it registers `WorkerWakeup.wake` with `CurrentTransaction.afterCommit`: the action runs after the outermost commit and never on rollback, and `WorkerWakeup` sends at most one `SELECT pg_notify('std_worker', '')` per process per 250 ms on a pooled connection. A save that matches nothing writes no row and requests no wake-up. A no-op save never reaches step 9.

## Claims and fencing (for the Step 3 worker)

- `claimDeliveries({ subscriptionId, deadLetter, limit, lease })` runs the 4.6 claim predicate exactly (the policy only decides whether `'dead'` is in the blocking status list, so both statement texts are constant), sets the claimed rows `in_flight`, `attempts + 1`, `lease_until = now() + lease`, `lease_token = gen_random_uuid()`, and commits, in its own request transaction. Called inside a transaction it dies with `TransactionRefused` (`nesting`): a claim must commit before the effect starts, or its rows stay locked and its lease invisible. Rows come back sorted by row ID.
- `markDone(lease)` and `markFailed(lease, { maxAttempts, error })` update `WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'` and fail with `LeaseLost` when no row changed. They join the caller's transaction when there is one and fail inside it, so in a delivery transaction that holds the effect's record writes the whole transaction rolls back (a caller that catches `LeaseLost` and returns success meets the SQL layer's poisoning rule). `done` and failure clear the lease.
- `markFailed` makes the row `dead` when it has been claimed `maxAttempts` times (the worker passes the subscription's `max_attempts` from its snapshot, so a local override of it applies), otherwise `pending` with `next_attempt_at = now() + retryDelay(attempts, jitter)`. `retryDelay` is 10 s after the first attempt, doubling per attempt, capped at 1 h, then shortened by up to 20 % (`jitter` from `Random.next`), so a retry is never later than the stated schedule and failures that happened together spread out.
- `attempts` counts claims, not reported failures, so a delivery whose worker dies before reporting still uses up attempts; a reclaimed expired lease becomes `dead` at its next reported failure once the count is reached. Retry and discard of dead rows are operator actions of Step 3.

## Evidence

| Test | What it shows |
| --- | --- |
| `outbox-claims`: claim order | Two updates of R in two transactions and one of Q: the first claim returns R@2 and Q@2, not R@3; after `markDone(R@2)` R@3 is claimable |
| `outbox-claims`: sequence-cursor regression | A creates a laptop (two matching subscriptions) and holds its transaction; B creates one and commits; a claim returns only B's row; A commits; A's two rows exist, have lower row IDs than B's, and are claimed by both subscriptions |
| `outbox-claims`: expired lease | After the lease passes, a claim returns the same row with a new token and `attempts` 2; the stale token's `done` and failure give `LeaseLost` and leave the row `in_flight` under the new token; `done` is final |
| `outbox-claims`: delivery transaction | A record write followed by `markDone` with a lost lease rolls back the write |
| `outbox-claims`: failures | `pending` with a delay of 8 to 10 s and the error text, not claimable while backing off; the second failure with `max_attempts` 2 is `dead`, its error cut to 2,000 characters |
| `outbox-claims`: dead letters | Under `block` a dead R@2 holds R@3 back while another record flows; under `skip` R@3 is claimable |
| `outbox-claims`: partial index | 4,000 `done` rows on two subscriptions and 20 `pending`, after `ANALYZE`: both the claimed rows (`p`) and the ordering check (`e`) use `Index Scan using delivery_order` (a merge anti join), for both policies, with no sequential scan of `core.delivery` |
| `outbox-producer` | descendant classes; disabled and retired subscriptions; operations; conditions on `after` and on `before` for a delete at version n+1; no row for a no-op save; no row after a rollback (rows visible inside the transaction first); a stored condition that no longer checks is a defect; the statement log shows no NOTIFY between the save's `BEGIN` and `COMMIT` and `pg_notify` after the `COMMIT` |
| `version-invariant` (HTTP) | 12 runs of up to 16 random creates, updates and deletes by Alice and Bob through `/acme.asset` and `/acme.laptop`, stale versions and refused saves included: every record's entries are exactly versions 1..n with a delete last; every delivery row belongs to one of the record's entries at its version, and every entry has exactly the rows of the subscriptions that match it (all assets; laptops in use; updates that leave an asset lost; a disabled one never). A deliberately wrong expectation is found with a two-step counterexample |
| `subscription-definitions` | `subscription_on` and `condition_reads` edges; conditions checked on the subscription's class in the subscription profile (`me` refused); operations named once; platform tables refused |

## Deviations and precisions

- The claim takes the dead-letter policy as an argument instead of joining `core.subscription`, so the worker's snapshot (overrides included) decides, like `max_attempts`.
- The wake-up is requested only when a save wrote a delivery row (Contracts 4.1 step 11 says "send a worker wake-up"; a save without deliveries has nothing to wake a worker for). Contract text updated.
- Jitter only shortens the delay (up to 20 %). Contract text updated.
- Subscriptions on platform tables are refused, and retired subscriptions produce nothing. Contract text updated.
- `core.delivery` has no index on `change_id` alone. Deleting change entries (retention, 4.8) would need one; it comes with retention.

## Open items

- Step 3 (3B): the worker loop (wake-ups and polling, the effect timeout below the lease), payloads filtered for the subscription's identity (4.5), the admin view, retry and discard of dead rows, the metric, deletion of `done` rows after 7 days, the soak and lease-fencing tests.
- The subscription's identity is a user ID that nothing checks yet; delivery must refuse an inactive or missing identity (a `doctor` check could report it).
- Saves that bypass the pipeline (table-owner fixtures, `seedRecord` with `SaveHooks.none`) write no deliveries. `saveBatch` (Step 3) must use the same producer.
