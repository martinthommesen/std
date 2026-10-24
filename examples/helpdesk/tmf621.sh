#!/usr/bin/env bash
# STD helpdesk over TMF621: the Step 3 runnable result (docs/plan.md).
#
# Against a running `std serve` with the helpdesk set v3 installed
# (`std upgrade --set examples/helpdesk/v3`), through the TM Forum Trouble
# Ticket API v5 (TMF621, `/tmf-api/troubleTicket/v5`) only, it:
#   1. signs in,
#   2. opens an incident (severity Major) and reads it back,
#   3. updates it: urgency 1 (so the priority becomes High), status
#      inProgress and a first note,
#   4. adds a second note, keeping the first (a merge patch replaces the
#      whole note array, strict RFC 7396),
#   5. resolves it with If-Match set to the ticket's current ETag,
#   6. shows that a stale If-Match answers 409 VersionConflict.
#
# It needs bash, curl and jq.
#
# Rerunning it against the same database is safe: every run opens its own
# incident, named with the run's tag (TMF621_RUN), and changes only that one.
#
# Settings (environment variables, with defaults):
#   STD_URL           the server                 http://127.0.0.1:8080
#   TMF621_LOGIN      the user who signs in      admin
#   TMF621_PASSWORD   its password               helpdesk-admin-demo-password
#   TMF621_RUN        tag for this run's ticket  the current UTC time
#   TMF621_LISTENER   local listener origin      http://127.0.0.1:8081
#
# Start `pnpm --filter @std/example-listener start` first. Both `std serve`
# and `std worker` need STD_HUB_ALLOW_PRIVATE_ADDRESSES=true for loopback
# callbacks. See examples/listener/README.md. The script registers its own
# hub, checks callback receipts, replays one notification and unregisters.
#
# The default credential is the helpdesk demo administrator's, a disposable
# demo credential. Never reuse it.
#
# Every answer it shows is checked (status code, `status`, `priority`, the
# notes, `resolutionDate`, `statusChangeHistory`): anything unexpected stops
# it with FAILED and exit 1.
set -euo pipefail

STD_URL=${STD_URL:-http://127.0.0.1:8080}
TMF621_LOGIN=${TMF621_LOGIN:-admin}
TMF621_PASSWORD=${TMF621_PASSWORD:-helpdesk-admin-demo-password}
RUN=${TMF621_RUN:-$(date -u +%Y%m%d-%H%M%S)}
LISTENER=${TMF621_LISTENER:-http://127.0.0.1:8081}
CALLBACK="$LISTENER/listener?source=tmf621"
HUBS="$STD_URL/tmf-api/troubleTicket/v5/hub"

SESSION_API="$STD_URL/api/v1"
TICKETS="/tmf-api/troubleTicket/v5/troubleTicket"
BODY_FILE=$(mktemp)
HEADER_FILE=$(mktemp)
RESPONSE_HEADERS=$(mktemp)

cleanup() {
  local result=$?
  if [[ -n ${HUB_ID:-} ]]; then
    if request DELETE "$HUBS/$HUB_ID" && [[ $STATUS == 204 ]]; then
      echo "  unregistered this run's hub"
    else
      echo "FAILED: unregister hub $HUB_ID (HTTP ${STATUS:-unavailable})" >&2
      result=1
    fi
  fi
  rm -f "$BODY_FILE" "$HEADER_FILE" "$RESPONSE_HEADERS"
  exit "$result"
}
trap cleanup EXIT

# --- HTTP helpers -----------------------------------------------------------
#
# Credentials never go into a command's arguments, where any local user can
# read them (`ps`, /proc/<pid>/cmdline): request bodies reach curl on stdin,
# the session token reaches it through a header file, and the password
# reaches jq on stdin (`jq -R`). Builtins such as `printf` start no process.

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

# request METHOD URL [BODY]: sends one request as $TOKEN (if set), with
# If-Match: $IF_MATCH (if set, sent as is); a PATCH body is a merge patch.
# Sets STATUS and BODY (the response headers go to $RESPONSE_HEADERS); never
# fails on an HTTP error, so the caller can check an expected refusal.
request() {
  local method=$1 url=$2 body=${3:-}
  local args=(-sS -o "$BODY_FILE" -D "$RESPONSE_HEADERS" -w '%{http_code}' -X "$method")
  local type=application/json

  if [[ $method == PATCH ]]; then
    type=application/merge-patch+json
  fi

  if [[ -n ${TOKEN:-} ]]; then
    printf 'authorization: Bearer %s\n' "$TOKEN" >"$HEADER_FILE"
    args+=(-H "@$HEADER_FILE")
  fi

  if [[ -n ${IF_MATCH:-} ]]; then
    args+=(-H "if-match: $IF_MATCH")
  fi

  if [[ -n $body ]]; then
    args+=(-H "content-type: $type" --data-binary @-)
  fi

  STATUS=$(printf '%s' "$body" | curl "${args[@]}" "$url") || return
  BODY=$(cat "$BODY_FILE")
}

# ok EXPECTED_STATUS METHOD URL [BODY]: like request, but stops the script
# unless the answer has exactly that status.
ok() {
  local expected=$1
  shift
  request "$@"

  if [[ $STATUS != "$expected" ]]; then
    fail "$1 $2 -> $STATUS (expected $expected) $BODY"
  fi
}

# etag: the ETag header of the last response, as sent (quotes included).
etag() {
  sed -n 's/^etag: *\(.*[^[:space:]]\)[[:space:]]*$/\1/Ip' "$RESPONSE_HEADERS" | head -n 1
}

# expect JSON FILTER WHAT: stops the script unless the jq FILTER is true.
expect() {
  jq -e "$2" >/dev/null <<<"$1" || fail "expected $3; got $1"
}

# show JSON: the key fields of a TroubleTicket.
show() {
  jq -r '"  id \(.id)  status \(.status)  priority \(.priority)  severity \(.severity)  notes \((.note // []) | length)"' <<<"$1"
}

heading() {
  printf '\n== %s ==\n' "$1"
}

# sign_in LOGIN PASSWORD: prints a session token (delivered in the body).
sign_in() {
  local body
  body=$(printf '%s' "$2" | jq -Rsc --arg login "$1" '{login: $login, password: ., tokenDelivery: "body"}')
  TOKEN='' request POST "$SESSION_API/session" "$body"

  if [[ $STATUS != 2?? ]]; then
    fail "POST /api/v1/session -> $STATUS $BODY"
  fi

  jq -r .token <<<"$BODY"
}

# --- The walk-through -------------------------------------------------------

heading "Sign in as $TMF621_LOGIN"
TOKEN=$(sign_in "$TMF621_LOGIN" "$TMF621_PASSWORD")
[[ -n $TOKEN && $TOKEN != null ]] || fail "sign-in answered no token"
echo "  signed in"

heading "Register the local listener through TMF621's hub"
TOKEN='' ok 200 GET "$LISTENER/receipts"
ok 201 POST "$HUBS" "$(jq -nc --arg callback "$CALLBACK" \
  '{"@type": "Hub", callback: $callback, query: "eventType=TroubleTicketCreateEvent,TroubleTicketAttributeValueChangeEvent,TroubleTicketStatusChangeEvent,TroubleTicketResolvedEvent"}')"
HUB_ID=$(jq -er .id <<<"$BODY")
expect "$BODY" ".callback == \"$CALLBACK\"" "the registered callback, including its query string"
echo "  hub $HUB_ID registered"

heading "Open an incident (POST $TICKETS)"
ok 201 POST "$STD_URL$TICKETS" "$(jq -nc --arg name "Laptop does not boot [$RUN]" \
  '{"@type": "TroubleTicket", name: $name, description: "The laptop shows a black screen after the logo.", severity: "Major", ticketType: "incident"}')"
TICKET=$BODY
ID=$(jq -r .id <<<"$TICKET")
show "$TICKET"
expect "$TICKET" '.["@type"] == "TroubleTicket" and .status == "acknowledged" and .severity == "Major" and (.id | type == "string") and (.href | type == "string")' "an acknowledged Major TroubleTicket with id and href"
URL="$STD_URL$TICKETS/$ID"

heading "Read it back (GET)"
ok 200 GET "$URL"
show "$BODY"
expect "$BODY" ".id == \"$ID\" and .status == \"acknowledged\"" "the same acknowledged ticket"

heading "Update it: urgency 1, status inProgress, first note (PATCH)"
# The characteristics array replaces the old one (strict RFC 7396), so the
# update sends them as read with urgency changed.
ok 200 PATCH "$URL" "$(jq -c '{status: "inProgress", troubleTicketCharacteristic: [.troubleTicketCharacteristic[] | if .name == "urgency" then .value = 1 else . end], note: [{text: "Looking at it now."}]}' <<<"$BODY")"
STALE=$(etag)
show "$BODY"
expect "$BODY" '.status == "inProgress" and .priority == "High" and (.note | length) == 1' "inProgress, priority High (Major x urgency 1) and one note"
[[ -n $STALE ]] || fail "the PATCH answer carried no ETag"

heading "Add a second note, keeping the first (PATCH, strict RFC 7396)"
ok 200 PATCH "$URL" "$(jq -c '{note: (.note + [{text: "Replacement battery ordered."}])}' <<<"$BODY")"
show "$BODY"
expect "$BODY" '(.note | length) == 2 and .note[0].text == "Looking at it now." and .note[1].text == "Replacement battery ordered."' "both notes, the first kept"

heading "Resolve it (PATCH status resolved, If-Match: current ETag)"
ok 200 GET "$URL"
CURRENT=$(etag)
[[ -n $CURRENT ]] || fail "the GET answer carried no ETag"
IF_MATCH=$CURRENT ok 200 PATCH "$URL" "$(jq -nc '{status: "resolved"}')"
show "$BODY"
jq -r '"  resolutionDate \(.resolutionDate)  history " + ([.statusChangeHistory[].status] | join(" > "))' <<<"$BODY"
expect "$BODY" '.status == "resolved" and .priority == "High" and (.note | length) == 2 and (.resolutionDate | type == "string")' "resolved, priority High, two notes, a resolutionDate"
expect "$BODY" '[.statusChangeHistory[].status] as $seen | ["acknowledged", "inProgress", "resolved"] | all(. as $wanted | $seen | index($wanted) != null)' "a statusChangeHistory with acknowledged, inProgress and resolved"

heading "A stale If-Match is refused (PATCH with the ETag from before the later updates)"
IF_MATCH=$STALE request PATCH "$URL" "$(jq -nc '{status: "closed"}')"
echo "  $STATUS $(jq -r '.code // empty' <<<"$BODY")"
[[ $STATUS == 409 ]] || fail "expected 409, got $STATUS $BODY"
expect "$BODY" '.code == "VersionConflict"' "the error code VersionConflict"

heading "Committed callback receipts (waiting for std worker)"
# Hang tripwire: pnpm tmf621-example:ci on 2026-10-24 received all callbacks
# within one second of resolution in both runs (listener README receipt).
# A minute leaves ample headroom for this disposable example, not a worker SLA.
LISTENER_WAIT_SECONDS=60
WAIT_STARTED=$SECONDS
# Eight notifications: create; update (attribute + status and a separate
# aggregate attribute event for the first note); second note (attribute);
# resolve (attribute + status + resolved). Tmf.resource saves own fields and
# finalizes changed parts as distinct versions in the same operation.
# A stale write produces none (Contracts 12.1, decision 0035).
while true; do
  TOKEN='' ok 200 GET "$LISTENER/receipts"
  RECEIPTS=$(jq -c --arg id "$ID" '[.[] | select(.notification.event.troubleTicket.id == $id)]' <<<"$BODY")
  COUNT=$(jq length <<<"$RECEIPTS")
  [[ $COUNT -le 8 ]] || fail "expected 8 committed notifications, received $COUNT"
  [[ $COUNT -lt 8 ]] || break
  if (( SECONDS - WAIT_STARTED >= LISTENER_WAIT_SECONDS )); then
    fail "listener_wait_seconds=$LISTENER_WAIT_SECONDS exceeded; received $COUNT of 8 notifications for $ID. Check std worker and STD_HUB_ALLOW_PRIVATE_ADDRESSES=true."
  fi
  sleep 0.2
done
expect "$RECEIPTS" '[.[].notification.eventType] == ["TroubleTicketCreateEvent", "TroubleTicketAttributeValueChangeEvent", "TroubleTicketStatusChangeEvent", "TroubleTicketAttributeValueChangeEvent", "TroubleTicketAttributeValueChangeEvent", "TroubleTicketAttributeValueChangeEvent", "TroubleTicketStatusChangeEvent", "TroubleTicketResolvedEvent"]' "the eight committed notifications in version order"
expect "$RECEIPTS" 'all(.[]; .idempotencyKey == .notification.eventId) and ([.[].notification.eventId] | unique | length) == 8' "eight distinct event IDs, each its own Idempotency-Key"
expect "$RECEIPTS" '.[0].notification.event.troubleTicket.status == "acknowledged" and .[2].notification.event.troubleTicket.status == "inProgress" and .[7].notification.event.troubleTicket.status == "resolved" and (.[3].notification.event.troubleTicket.note | length) == 1 and (.[4].notification.event.troubleTicket.note | length) == 2 and .[1].notification.correlationId == .[3].notification.correlationId' "committed create, update, whole note arrays and resolution payloads"
jq -r '.[] | "  \(.notification.eventType)  eventId \(.notification.eventId)"' <<<"$RECEIPTS"

heading "Replay a received event: deduplicate by eventId"
REPLAY=$(jq -c '.[0].notification' <<<"$RECEIPTS")
EVENT_ID=$(jq -r .eventId <<<"$REPLAY")
DUPLICATES=$(jq '.[0].duplicates' <<<"$RECEIPTS")
# This is a public notification ID, never a bearer credential.
printf 'idempotency-key: %s\n' "$EVENT_ID" >"$HEADER_FILE"
STATUS=$(printf '%s' "$REPLAY" | curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -H "@$HEADER_FILE" -H 'content-type: application/json' --data-binary @- "$CALLBACK")
[[ $STATUS == 202 ]] || fail "duplicate callback -> $STATUS (expected 202)"
expect "$(cat "$BODY_FILE")" ".duplicate == true and .eventId == \"$EVENT_ID\"" "the same event ID acknowledged as a duplicate"
TOKEN='' ok 200 GET "$LISTENER/receipts"
expect "$BODY" "[.[] | select(.notification.event.troubleTicket.id == \"$ID\")] | length == 8" "still eight unique notifications after replay"
expect "$BODY" ".[] | select(.notification.eventId == \"$EVENT_ID\") | .duplicates > $DUPLICATES" "a recorded duplicate"
echo "  duplicate $EVENT_ID acknowledged; still 8 unique notifications"

heading "Done"
echo "  incident $ID opened, updated and resolved; the stale write changed nothing"
