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

SESSION_API="$STD_URL/api/v1"
TICKETS="/tmf-api/troubleTicket/v5/troubleTicket"
BODY_FILE=$(mktemp)
HEADER_FILE=$(mktemp)
RESPONSE_HEADERS=$(mktemp)
trap 'rm -f "$BODY_FILE" "$HEADER_FILE" "$RESPONSE_HEADERS"' EXIT

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

  STATUS=$(printf '%s' "$body" | curl "${args[@]}" "$url")
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

# TODO(3H): examples/listener prints the events (TroubleTicketCreateEvent,
# TroubleTicketStatusChangeEvent, ...) the steps below cause: register its
# hub here, with POST /tmf-api/troubleTicket/v5/hub, once workstream 3H serves
# hubs.

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
ok 200 PATCH "$URL" "$(jq -nc '{status: "inProgress", troubleTicketCharacteristic: [{name: "urgency", value: 1, "@type": "IntegerCharacteristic"}], note: [{text: "Looking at it now."}]}')"
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

heading "Done"
echo "  incident $ID opened, updated and resolved; the stale write changed nothing"
