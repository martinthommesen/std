# TMF621 listener

This local listener receives STD's committed ticket notifications and deduplicates them by `eventId`. Run the complete example on a disposable database:

```sh
pnpm tmf621-example:ci
```

It starts `std serve`, a production `std worker` and this listener on OS-selected loopback ports, runs `examples/helpdesk/tmf621.sh` twice, and cleans up its processes and database. Each run registers its own TMF621 hub, opens an incident, updates its urgency/status/notes, resolves it, checks a stale write is refused, verifies eight unique callback receipts, replays one received notification, verifies its duplicate receipt, and unregisters its hub. The execve trace checks that passwords and bearer tokens never enter command arguments. Linux, Postgres 18, bash, curl, jq and strace are prerequisites; use `pnpm db:up` for the repository's development Postgres.

To run each part yourself against a local development database, first install helpdesk v3 and create its disposable demo users:

```sh
pnpm std upgrade --set examples/helpdesk/v3
pnpm helpdesk:seed
```

Then keep each of these commands running in its own terminal, with the same `STD_DATABASE_URL` for the server and worker:

```sh
STD_HTTP_HOST=127.0.0.1 STD_HUB_ALLOW_PRIVATE_ADDRESSES=true pnpm std serve
STD_HUB_ALLOW_PRIVATE_ADDRESSES=true pnpm std worker
pnpm --filter @std/example-listener start
```

In another terminal:

```sh
bash examples/helpdesk/tmf621.sh
```

The script uses the disposable helpdesk `admin` credential by default. For a different account, read its password privately rather than putting it in history or arguments:

```sh
read -r -p 'Login: ' TMF621_LOGIN
read -r -s -p 'Password: ' TMF621_PASSWORD; printf '\n'
export TMF621_LOGIN TMF621_PASSWORD
bash examples/helpdesk/tmf621.sh
unset TMF621_PASSWORD
```

`STD_URL` selects the server (default `http://127.0.0.1:8080`). `STD_LISTENER_PORT` selects the listener port (default `8081`; `0` chooses a free port, printed on startup). Set `TMF621_LISTENER` to its origin if you change it. This is a host-local example: a worker inside Docker has a different loopback network and cannot reach a listener on the host via `127.0.0.1`. Run the processes as above, or use the disposable CI command.

The script sends `POST /tmf-api/troubleTicket/v5/hub` with:

```json
{
  "@type": "Hub",
  "callback": "http://127.0.0.1:8081/listener?source=tmf621",
  "query": "eventType=TroubleTicketCreateEvent,TroubleTicketAttributeValueChangeEvent,TroubleTicketStatusChangeEvent,TroubleTicketResolvedEvent"
}
```

STD posts every event to that exact callback path and query. This keeps the existing callback policy: private destinations require the explicit opt-in on both server and worker; plaintext is permitted only on loopback; redirects are not followed. The example changes no transport defaults (Contracts 12.2, decision 0032). The registering user needs `events.subscribe` and read access to the ticket and event trigger fields. The shipped administrator has these rights.

## Event and receipt rules

The listener's HTTP interface is:

- `POST /listener`: requires a TMF621 ticket event, a UUIDv5 `eventId`, a ticket UUID and `Idempotency-Key` equal to `eventId`. `@type` must equal `eventType`. Accepts the six ticket event types, including InformationRequired and Delete. Returns `204 No Content` with no body for both the first receipt and repeats. Inspect `GET /receipts` to distinguish them. Bad JSON or consumed fields return `400` without inserting a receipt. Other paths/methods return `404`.
- `GET /receipts`: returns first notification bodies and their `idempotencyKey` and `duplicates` counts in first-receipt order. It includes merge-patch nulls, whole arrays and unconsumed extension attributes unchanged.

The atomic receipt update precedes acknowledgment. TMF630 v5.0.0 Part 1 §11.5 p.195 requires `201 Created` or `204 No Content` on successful event delivery; this listener uses `204` because it finishes receipt processing before returning and has no response representation. Concurrent attempts with the same `eventId` retain one first body, even if `eventTime` changes. It validates the fields it consumes, rather than claiming to validate the entire TMF621 schema. Logs contain the event ID/type, ticket ID, status and duplicate flag, never request headers, sign-in bodies or full ticket payloads. Receipt bodies are available only on loopback and may contain ticket data: use disposable data.

Receipts are in memory for the process lifetime, without eviction or a TTL. Restarting clears deduplication. This is an inspectable local consumer example; a consumer with durable business effects must commit its receipt and effects in one durable transaction before acknowledging. This example has no business effects.

One committed change may give several notifications with distinct `eventId`s. STD derives each ID from the change ID and event type, stable across retries and hubs, and sends it as `Idempotency-Key`; never deduplicate by ticket ID, `correlationId` or `eventTime`. Status and Resolved payloads carry the status fields, while AttributeValueChange carries changed attributes and whole changed arrays. Sources: [Contracts 12](../../docs/contracts.md#12-events-hubs-listeners-and-tmf688-step-3), [decision 0035](../../docs/decisions/0035-tmf621.md#notifications-3hs-n1-option-a), the [pinned TMF621 event schemas](../../packages/tmf/specs/TMF621-Trouble_Ticket-v5.0.1.oas.yaml), and the [mapping's event rules](../../packages/tmf/src/tmf621.ts).

The walkthrough expects eight distinct notifications: Create; AttributeValueChange and StatusChange for the status/urgency update; another AttributeValueChange for its first note; AttributeValueChange for the second note; then AttributeValueChange, StatusChange and Resolved. The own-field save and aggregate finalization have distinct change entries in one operation (`http/tmf/resource.ts`), hence the extra first-note event. A refused stale write adds none.

The wait tripwire is 60 seconds after the final write. Receipt: on 2026-10-24, `pnpm tmf621-example:ci` received the final callback within one second of resolution in both runs (first: resolution `05:33:04.251Z`, callback `05:33:04.330Z`; second: resolution `05:33:04.916Z`, final callback before replay at `05:33:05.211Z`). This leaves headroom for local scheduling; it does not set the worker's delivery budget. Failure names `listener_wait_seconds`, its value, and received versus expected notifications. The worker's existing retry/dead-letter policy is unchanged.

## Checks

```sh
pnpm --filter @std/example-listener test
pnpm tmf621-example:ci
pnpm ci:local
```

The HTTP tests check an empty `204` for every supported ticket event type and concurrent duplicates with changed `eventTime`, distinct event types on the same ticket, raw merge-patch bodies, malformed input, wrong keys and restart semantics. The TMF621 CI step checks the real callback and replay demonstration, including the replay's empty `204` and preserved first receipt. This is STD's only owned subscriber endpoint; production STD subscribes to nothing (Contracts 12.2), and TMF688's client-topic event creation is a separate `201` resource operation (Contracts 12.3). The publisher still accepts any 2xx callback response. These checks cover this example's acknowledgment row; they do not close the remaining Step 3 conformance gate.
