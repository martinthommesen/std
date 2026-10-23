# 0037. Outbox dead-letter administration

Status: accepted, 2026-10-23 (workstream `ws/3b-dead-letter-admin`). Contracts 3.8, 4.6, 4.7 and 10. Builds on decisions 0023 (worker and operator actions), 0025 (TMF630 and API consolidation), and 0031 (the web app on that API).

## API

All paths below are relative to `/api/v1` and are declared in `@std/api/dead-letters`, included in the shared typed client and generated OpenAPI document.

| Route | Success | Meaning |
| --- | --- | --- |
| `GET /deadDelivery` | `200` | The dead deliveries, ordered by numeric delivery ID, with `X-Total-Count`, `X-Result-Count` and paging `Link` headers |
| `GET /deadDelivery/{id}` | `200` | One currently dead delivery; its list entry's absolute `href` |
| `POST /retryDeadDelivery` | `200` | `{ "deliveryId": "…" }`: reset attempts, queue for another attempt, and wake the worker after commit |
| `POST /discardDeadDelivery` | `200` | The same body: mark done without running the effect, and wake the worker after commit |

The collection is **dead-only** [judgment]. This keeps the operator's work queue focused; pending/in-flight monitoring is outside this change. `status=dead` is its default; other valid delivery statuses match no rows. `subscriptionId=<uuid>` filters by equality. `offset` defaults to 0 and `limit` to 100, bounded to 1–1,000 as in Contracts 10.3; `Link` emits `self`, `first`, `prev`, `next` and `last` as applicable and preserves the filters and selection. `fields` supports inclusion, `!` exclusion and `none`, retaining `id`, `href` and `@type`. Unsupported or repeated query parameters are refused rather than silently widening the query. General condition syntax, sorting and cursors are not offered by this fixed operator collection [judgment]; ascending delivery ID and offset paging are sufficient for this view. Reads have READ COMMITTED request semantics; worker activity can change the collection between pages.

Each resource has `@type: DeadDelivery`, a decimal string ID (Postgres int8, never a JavaScript number), and `href`. Its attributes are `subscriptionId`, `recordId`, `recordVersion`, `changeId`, `attempts`, sanitized `lastError`, `finishedAt` (UTC date-time), `status: dead`, and the current live subscription's `deadLetterPolicy`. Empty attributes are omitted. The policy is omitted when the subscription is no longer live. No record values, subscription identity, payload, or error cause are loaded for the view. The existing outbox module's unconditional `core.subscription` read decision controls visibility; tasks also need its unconditional update decision. An admin deny still applies. No role name is checked.

**Task resources** [judgment]: use verb-named POST collections, as `applyChangeSet` does, rather than action subpaths or a patch of the delivery's internal status. Unlike `applyChangeSet`, these tasks have no persisted task journal, so they synchronously return `200` with `@type: RetryDeadDelivery | DiscardDeadDelivery`, `deliveryId` and `state: completed`, without a task ID or Location. The existing module owns the transition, attempt reset, audit log, metric and post-commit wake-up; the HTTP adapter only validates and maps its result. A task response confirms that transition committed, not that a retried effect has run.

Errors use the TMF Error shape: `400 InvalidRequest` for malformed inputs, `400 UnknownField` for an unknown projection, `401 Unauthenticated`, `404 NotFound` for missing, non-dead or unauthorized resources, and `409 FieldsConflict` for conflicting projection, and `409 SchemaChanged` for an impossible stated revision. The shared error sets declare the other normal API refusals. The `dead` predicate on the atomic UPDATE fences stale/concurrent tasks: exactly one can win; another gets the same `404`. The HTTP adapter maps the module's `NotAllowed` to `NotFound` before returning it, including before parsing an unauthorized caller's body. GET has HEAD; unsupported methods retain the API's shape-based `405`/Allow and `204 OPTIONS` convention.

## Operator page

The administration navigation offers **Dead letters** when the caller's table metadata includes `core.subscription`. Its route is `/administration/dead-letters` [judgment]; existing administration uses generic definition-table pages rather than a separate administration router. Visibility remains the API's responsibility.

The Foldkit page owns a Schema Model, a pure update, typed-client Commands, and a Foldkit UI Dialog Submodel. Subscription/status filters and page-size controls use the shared Foldkit UI helpers. Retry and discard both require confirmation. The dialog explains the current policy: under `block`, retry continues to hold later deliveries until completion, whereas discard releases them without running this effect; under `skip`, later deliveries may already have run and retry may arrive out of order. If no live policy can be read, it explains both possibilities.

No optimistic row removal: while a task runs the row remains, and success causes a fresh server read from the first page [judgment: another operator can change the queue, and removing its last row could otherwise strand a page]. Failure explains that the outcome is unconfirmed and asks for a refresh. Page identities reject replies for a page/session the user has left; read generations reject stale reads. Session expiry returns to the parent's sign-in flow. No credentials enter the page Model or Messages. Development DevTools retain their existing Development-only configuration.

## Evidence

- `packages/server/test/dead-letter-api.test.ts`: list, equality filters, paging/counts, projection, HEAD, addressable resources, typed client, int8 bounds, malformed inputs, non-admin indistinguishability, concurrent/stale retry and discard under `block` releasing the next claim.
- `packages/server/test/api-contract.test.ts`: every new endpoint succeeds and fails through the shared response-schema check; OpenAPI is generated from that same declaration.
- `apps/web/src/page/dead-letters/{story,scene}.test.ts`: confirmation, cancel, duplicate confirmation, server reread, filtering, page size, stale reads, emptied nonzero-offset pages and session expiry. Root integration stories/scenes cover sign-in return and abandoned page/session replies.
- `apps/web/test/browser/dead-letters.test.ts`: real fixture deliveries through the built app; retry one, cancel discard, then discard another, and check persisted states.

No new dependency or platform migration.
