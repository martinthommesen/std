#!/usr/bin/env bash
# The Step 2 runnable result (docs/plan.md), checked over HTTP: after
# `docker compose up`, the web app is served at `/` and the helpdesk's demo
# users `admin` and `agent` (README.md, "Helpdesk") sign in and list
# incidents. Against a running `std serve` that loaded and seeded the
# helpdesk (`std upgrade --set examples/helpdesk/v2`, `pnpm helpdesk:seed`),
# it:
#   1. fetches `/` as a browser does and checks that the built web app is
#      served: 200, text/html, its root element and its module script, and
#      that script itself (200, JavaScript);
#   2. signs in as `admin` and as `agent` the way the web app does
#      (`POST /api/v1/auth/cookie-sign-in` with `STD-Client: web`; decision
#      0018) and checks the HTTP-only session cookie;
#   3. lists `helpdesk.incident` as each of them with that cookie and checks
#      that both get 200 with the same incidents, that the admin's carry the
#      key `internal_cost` with at least one value, and that the agent's
#      carry neither the key (anywhere in the response) nor any of those
#      values.
#
# `.github/workflows/quickstart-compose.yml` runs it after `docker compose
# up`. It needs bash, curl and jq. It only reads; rerunning it is safe.
#
# Settings (environment variables, with defaults):
#   STD_URL                   the server          http://127.0.0.1:8080
#   HELPDESK_ADMIN_PASSWORD   admin's password    helpdesk-admin-demo-password
#   HELPDESK_AGENT_PASSWORD   agent's password    helpdesk-agent-demo-password
#
# The defaults are the disposable demo credentials docker-compose.yml seeds;
# set the same variables as for `docker compose up` if you changed them.
#
# Any unexpected answer stops it with FAILED and exit 1.
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true # bash 4.4 and later

STD_URL=${STD_URL:-http://127.0.0.1:8080}
ADMIN_PASSWORD=${HELPDESK_ADMIN_PASSWORD:-helpdesk-admin-demo-password}
AGENT_PASSWORD=${HELPDESK_AGENT_PASSWORD:-helpdesk-agent-demo-password}

API="$STD_URL/api/v1"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

# get URL [CURL ARGS...]: a GET; sets STATUS, TYPE and BODY (the headers go
# to $WORK/headers). Never fails on an HTTP error, so the caller checks.
get() {
  local url=$1
  shift
  local meta
  meta=$(curl -sS -o "$WORK/body" -D "$WORK/headers" -w '%{http_code} %{content_type}' "$@" "$url") ||
    fail "GET $url: no answer from the server"
  STATUS=${meta%% *}
  TYPE=${meta#* }
  BODY=$(cat "$WORK/body")
}

# expect JSON FILTER WHAT: stops unless the jq FILTER is true for JSON.
expect() {
  jq -e "$2" >/dev/null <<<"$1" || fail "expected $3; got $1"
}

heading() {
  printf '\n== %s ==\n' "$1"
}

echo "STD Step 2 runnable result against $STD_URL"

# --- 1. The web app ------------------------------------------------------------

heading "The web app at /"
get "$STD_URL/" -H 'accept: text/html'
[[ $STATUS == 200 ]] || fail "GET / -> $STATUS, expected 200 (is apps/web built into the image?): $BODY"
[[ $TYPE == text/html* ]] || fail "GET / -> content type '$TYPE', expected text/html"
grep -q '<div id="root"></div>' <<<"$BODY" ||
  fail "GET / is HTML but not the web app: no <div id=\"root\"></div> in: $BODY"
script=$(grep -o '<script type="module"[^>]* src="/assets/[^"]*\.js"' <<<"$BODY" | sed 's/.* src="\([^"]*\)"/\1/' | head -n 1 || true)
[[ -n $script ]] || fail "GET / has no built module script (src=\"/assets/....js\"), so it is not the built app: $BODY"
echo "  GET / -> 200 $TYPE: the root element and the module script $script"
get "$STD_URL$script"
[[ $STATUS == 200 ]] || fail "GET $script -> $STATUS, expected 200"
[[ $TYPE == text/javascript* ]] || fail "GET $script -> content type '$TYPE', expected text/javascript"
echo "  GET $script -> 200 $TYPE"

# --- 2. Sign in ------------------------------------------------------------------

# sign_in LOGIN PASSWORD JAR: a cookie sign-in, as the web app does it. The
# password reaches jq and curl on stdin, never in a command's arguments.
sign_in() {
  local login=$1 password=$2 jar=$3 status
  status=$(printf '%s' "$password" | jq -Rsc --arg login "$login" '{login: $login, password: .}' |
    curl -sS -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' -c "$jar" -X POST \
      -H 'content-type: application/json' -H 'std-client: web' --data-binary @- \
      "$API/auth/cookie-sign-in") || fail "sign-in as $login: no answer from the server"
  [[ $status == 200 ]] || fail "POST /api/v1/auth/cookie-sign-in as $login -> $status $(cat "$WORK/body")"
  grep -qi '^set-cookie: std_session=[^;]*;.*HttpOnly' "$WORK/headers" ||
    fail "sign-in as $login set no HTTP-only std_session cookie: $(grep -i '^set-cookie' "$WORK/headers" | sed 's/=[^;]*/=<redacted>/' || true)"
  expect "$(cat "$WORK/body")" '(.userId | type) == "string" and (has("token") | not)' "a cookie sign-in for $login: a userId and no token in the body"
  echo "  $login signed in (std_session cookie, HttpOnly)"
}

heading "Sign in as admin and as agent (cookie sign-in, as the web app)"
sign_in admin "$ADMIN_PASSWORD" "$WORK/admin.jar"
sign_in agent "$AGENT_PASSWORD" "$WORK/agent.jar"

# --- 3. Incidents ------------------------------------------------------------------

# incidents LOGIN JAR: lists helpdesk.incident with LOGIN's cookie; prints
# the body. Stops unless 200 with at least one record.
incidents() {
  get "$API/tables/helpdesk.incident/records?sort=number" -b "$2"
  [[ $STATUS == 200 ]] || fail "GET /api/v1/tables/helpdesk.incident/records as $1 -> $STATUS $BODY"
  expect "$BODY" '(.records | length) > 0' "incidents for $1 (did pnpm helpdesk:seed run?)"
  printf '%s' "$BODY"
}

heading "Incidents as admin and as agent"
ADMIN_LIST=$(incidents admin "$WORK/admin.jar")
AGENT_LIST=$(incidents agent "$WORK/agent.jar")
jq -r '"  admin: \(.records | length) incidents: " + ([.records[] | "\(.values.number) internal_cost=\(.values.internal_cost)"] | join(", "))' <<<"$ADMIN_LIST"
jq -r '"  agent: \(.records | length) incidents: " + ([.records[] | .values.number] | join(", "))' <<<"$AGENT_LIST"

expect "$ADMIN_LIST" 'all(.records[]; .values | has("internal_cost"))' "the key internal_cost on every incident the admin lists"
expect "$ADMIN_LIST" 'any(.records[]; .values.internal_cost != null)' "an internal_cost value in the admin's list (the seed sets them)"
[[ $(jq -c '[.records[].id]' <<<"$ADMIN_LIST") == "$(jq -c '[.records[].id]' <<<"$AGENT_LIST")" ]] ||
  fail "the agent to list the same incidents as the admin (README.md: every ticket); admin: $(jq -c '[.records[].values.number]' <<<"$ADMIN_LIST"), agent: $(jq -c '[.records[].values.number]' <<<"$AGENT_LIST")"

if grep -q internal_cost <<<"$AGENT_LIST"; then
  fail "the agent's incidents mention internal_cost: $AGENT_LIST"
fi
# The admin's internal_cost values, by record ID: none may appear among the
# values of the agent's copy of that record.
leaked=$(jq -c --argjson admin "$ADMIN_LIST" '
  ($admin.records | map(select(.values.internal_cost != null) | {key: .id, value: .values.internal_cost}) | from_entries) as $cost
  | [.records[] | select($cost[.id] != null) | . as $r
     | select(any(.values[]; . == $cost[$r.id])) | {number: .values.number, internal_cost: $cost[$r.id]}]' <<<"$AGENT_LIST")
[[ $leaked == '[]' ]] || fail "the agent's incidents carry internal_cost values: $leaked"
echo "  admin sees internal_cost; agent sees neither the key nor its values"

echo
echo "OK: the web app is served, and admin and agent sign in and list incidents"
