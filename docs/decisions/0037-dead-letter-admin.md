# 0037. Outbox dead-letter administration

Status: accepted, 2026-10-23 (workstream `ws/3b-dead-letter-admin`). Contracts 3.8, 4.6, 4.7 and 10; decisions 0023 (worker), 0025 (TMF630), 0031 (web API) and 0032 (hubs).

## Stored operator actions

Martin chose, on 2026-10-23: "Stored task record (Recommended): Each retry or discard becomes a stored record: who did it, when, which delivery and the outcome. It gets STD's normal change history, events and access rules. The API answers 201 with a link to it, as TM Forum's API rules allow for tasks. Costs one more platform table."

The protected core set version 4 defines `core.dead_delivery_action`, created by additive platform migration **0029** (`expand`). Its fields are `delivery_id` (int8), `subscription_id` (UUID), `action` (`retry` or `discard`), `state` (`completed`) and `occurred_at`. `createdBy` and change history already expose the acting user, so no duplicate actor field is stored. [judgment] Delivery and subscription identities are values, not foreign keys: the action must survive delivery retention and subscription deletion. The record service owns validation, ordinary read access, history and outbox events. The action is append-only: only the dead-letter module can create it, through the narrow internal capability described below. It is an exception to the subscription restriction, allowing its committed creates to produce events; it is not an exception to the generic platform write guard.

The module locks the dead delivery, checks retry eligibility, applies the transition and creates the action through the record service in one request transaction. Exactly one concurrent retry/discard wins; the loser gets `404`. Any refusal or rollback leaves both the delivery and action records unchanged. Worker wake-up and gauge refresh are registered on the outermost transaction's post-commit hook, dropped on rollback and rerun only after a successful transaction retry. The stored record replaces operator process logs.

## Audit integrity (review B1)

TMF630 v5.0.0 Part 1 §9.1 p.139 identifies a persisted task by its task result, and §9.2 p.140 requires `201`, `Location` and the persisted representation for a successful short-running task. STD therefore creates an action only by executing retry/discard; subsequent generic writes cannot forge the execution or alter its result. A refused retry returns an error, creates no task and leaves the delivery unchanged: failures are error responses, not stored failed tasks (§9.1 failure response codes, pp.138–139). [judgment on STD's immutable completed-task model]

Append-only audit practice requires restricting the writer and protecting stored evidence against modification and deletion. This implements [OWASP Logging Cheat Sheet, “Where to record event data” and “Protection”](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#protection) (checked 2026-10-23): give the audit writer narrowly scoped authority and preserve the origin and integrity of its records. No TM Forum or ITIL member text is copied here.

`makeDeadDeliveryActionWriter` in the save pipeline issues the internal capability, held only as the dead-letter module's unexported `appendDeadDeliveryAction`. The writer is fixed to action creation, and the private pipeline's authority is a call argument, never a request field or ambient service. It skips the platform guard and caller create decision only for that one create; validation, actor attribution, history, events and read projection remain. The generic record interface exposes no authority argument, and no update/delete capability exists. Record rules and change-set field additions remain refused on this platform class. A protected core deny on create/update/delete additionally makes its ordinary access decisions refuse writes. Admin allow rules cannot defeat a deny or the platform guard, app/local rules cannot apply to platform classes, and protection prevents an override or change set from weakening the deny. Decision 0014 records the capability alongside the intact generic guard.

The module constructs `action`, `delivery_id`, `subscription_id`, `state` and `occurred_at` from the authorized task, locked delivery and server clock. The task schema contains only `deliveryId`: as with other Schema structs, extra client members are ignored, never forwarded to the writer. Metadata reports `creatable: false` and every field's create/update state as `no`; there are no separate table-level updatable/deletable members in STD's metadata, and the core record deny also refuses update/delete access decisions. Generic POST and both PATCH formats return `403 NotAllowed`, DELETE does likewise after normal visibility/version checks, and unsupported PUT retains `405 MethodNotAllowed`.

## Resources and queries

All paths below are relative to `/api/v1`; `@std/api/dead-letters` declares the fixed endpoints for the typed client and OpenAPI document.

| Route | Success | Meaning |
| --- | --- | --- |
| `GET /deadDelivery[/{id}]` | `200` | Dead-delivery collection and one currently dead delivery; GET includes HEAD |
| `POST /retryDeadDelivery` | `201` | `{deliveryId}`: reset attempts, queue the delivery and return its stored action |
| `POST /discardDeadDelivery` | `201` | `{deliveryId}`: mark done without running the effect and return its stored action |
| `GET /coreDeadDeliveryAction[/{id}[/history[/{changeId}]]]` | `200` | The one task collection, records and history, through ordinary record routes; GET includes HEAD |

Both POSTs return `Location` and an absolute `href` for the stored action in the single canonical collection. [judgment] Using that ordinary collection keeps one representation and the same access and history machinery, rather than separate task lookup aliases. A completed action confirms the operator transition committed; it does not mean a retried effect has completed. Persisted tasks follow TMF630 v5.0.0 Part 1 §9.1 p.139 and §9.2 p.140 as modeled in Contracts 10.1 and decision 0025. The fixed names `deadDelivery`, `retryDeadDelivery` and `discardDeadDelivery` are reserved; definition validation refuses collisions with `apiNameClash`.

The collection is dead-only. [judgment] It follows Contracts 10.3 and 10.4: comma/semicolon/repeated OR filters, comparison suffixes, `condition`, `sort`, `fields`, counts, offset paging and forward/backward/range cursors. The shared parser and compiler own the grammar and validation, including `UnknownField`; `filter` retains the standard `501` refusal. Its int8 identity uses the shared cursor implementation's int8 identity option. `allowedFor` follows the normal reference-target check: no definition can reference an internal delivery, so no such target can match this collection and a supplied value is `InvalidRequest`.

The resource has `@type: DeadDelivery`, decimal string `id`, absolute `href`, `subscriptionId`, `changeId`, `attempts`, sanitized `lastError`, `finishedAt`, `status`, `deadLetterPolicy` and `subscriptionState`. `recordId` and `recordVersion` appear only when the caller may read that record; selected restricted attributes are listed in `withheld`. The ordinary read predicates authorize record identities in a batch per concrete class, before projection, filtering, counts, sorting or cursor construction. No record values, subscription identity, payload or error cause are read. Empty attributes are omitted. Invalid persisted timestamps fail decoding; no instant is invented.

Unconditional `core.subscription` read controls dead-delivery visibility; POST also requires its unconditional update decision. No role name is checked; denies still apply. Unauthorized, absent and non-dead deliveries are identical `404 NotFound`, before parsing an unauthorized caller's body. Stored action reads, list, HEAD, history and events follow their class's ordinary access rules and masks; generic writes are refused for everyone. Unsupported methods retain shape-based `405`/Allow and `OPTIONS` behavior.

## Retry eligibility

Retry uses the worker's shared served-subscription resolution: only active, enabled subscriptions with a configured handler are served. Unavailable subscriptions answer the new shared **409 `SubscriptionNotServed`**, naming the subscription UUID, state and remedy. [judgment] `InvalidTransition` is reserved for a record rule's 422 refusal, so reusing it would misstate this worker-configuration conflict. States are `served`, `disabled`, `retired`, `purged`, `deleted` (absent) and `noHandler`. Deleted hubs are stored as purged subscription tombstones by 0032 and therefore report `purged`. Subscription lifecycle commands permit deletion, not retirement or purge; historical retired/purged persisted states are still refused, matching the worker. Discard remains allowed in every state.

## Operator page

The minimal administration navigation entry remains **Dead letters**, at `/administration/dead-letters`. The self-contained Foldkit page uses a Schema Model, pure update, typed-client Commands and a Foldkit UI Dialog. It displays time of death and subscription state, marks unreadable identities Restricted, and disables retry when the subscription is not served. The retry dialog names its subscription and state. Discard stays available. The redundant single-choice status filter is removed.

Confirmation explains `block` (retry holds later versions until completion; discard releases them) and `skip` (later versions may already have run). No optimistic row removal: success rereads the first page because another operator may have changed the queue. [judgment] The page handles only relevant read/task error codes, preserves the server's request-parameter and attribute detail, and includes the code in a generic fallback; session expiry has dedicated Command Messages and the parent's session OutMessage. Page identities and request generations reject replies to abandoned pages or sessions. No credentials enter browser state.

## Evidence

- `packages/server/test/dead-letter-api.test.ts`: exact resource attributes; standard queries and bidirectional paging; typed client and HEAD; read-only operator authority; retry/discard race; block/skip retry ordering; unavailable and deleted-hub subscriptions; restricted record identities; stored action, history, refusal and rollback.
- `packages/server/test/outbox-worker.test.ts`: existing worker block/skip, fencing and operator coverage.
- `packages/server/test/platform-tables.test.ts` and `contracts3.test.ts`: admin generic creates remain refused on every platform data class; genuine task records resist merge patch, JSON Patch, PUT, DELETE and change-set field additions, with unchanged records/history and read-only metadata. `builtins.test.ts` protects the core deny; `dead-letter-api.test.ts` verifies client fields cannot set the action, outcome, subscription, actor or time.
- `packages/server/test/api-contract.test.ts`: success/error responses checked against the shared endpoint schemas, including hubs preserved by the main merge.
- `apps/web/test/dead-letter-command.test.ts` and `apps/web/src/page/dead-letters/{story,scene,app-story,app-scene}.test.ts`: specific errors, state and time rendering, restriction, confirmation, cancellation, session expiry and stale replies.
- `apps/web/test/browser/dead-letters.test.ts`: built-app retry and discard through real HTTP and persisted states.

No new dependency. The doctor platform catalog is regenerated from the migrated database.
