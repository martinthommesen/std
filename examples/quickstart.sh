#!/usr/bin/env bash
# STD quickstart: the Step 1 runnable result (docs/plan.md).
#
# Against a running `std serve`, through its HTTP API only (the TMF630 API,
# Contracts 10), it:
#   1. creates the tables acme.asset and acme.laptop in one change set,
#   2. creates two roles and their access rules in a second change set,
#   3. creates the users Alice (asset manager) and Bob (employee),
#   4. adds laptops,
#   5. renames a field and retires another,
#   6. signs in as Alice and as Bob and shows what each sees,
#   7. prints a record's history as each of them,
#   8. runs `std doctor` and exits with its status.
#
# Run it after `docker compose up` (see README.md, "Quickstart"). It needs
# bash, curl and jq.
#
# Rerunning it against the same database is safe. Definitions, roles, rules
# and users converge: each is created only when missing (fixed IDs below),
# and the rename and the retire happen once. Records do not converge: every
# run adds its own laptops, named with the run's tag (QUICKSTART_RUN), and
# shows and changes only those.
#
# Settings (environment variables, with defaults):
#   STD_URL              the server               http://127.0.0.1:8080
#   STD_ADMIN_LOGIN      the first administrator  administrator
#   STD_ADMIN_PASSWORD   its password             quickstart-admin-password
#   STD_DOCTOR_COMMAND   how to run `std doctor`  docker compose exec -T server pnpm --silent std doctor
#   QUICKSTART_RUN       tag for this run's data  the current UTC time
#   QUICKSTART_ALICE_PASSWORD, QUICKSTART_BOB_PASSWORD
#                        the demo users' passwords alice-quickstart-password, bob-quickstart-password
#
# Every password here is a disposable demo credential. Never reuse them.
#
# Every refusal it shows is checked (status and error tag), and so are the
# facts it prints (what each user sees, who sees cost, the versions in the
# history): anything unexpected stops it with FAILED and exit 1.
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true # bash 4.4 and later

STD_URL=${STD_URL:-http://127.0.0.1:8080}
STD_ADMIN_LOGIN=${STD_ADMIN_LOGIN:-administrator}
STD_ADMIN_PASSWORD=${STD_ADMIN_PASSWORD:-quickstart-admin-password}
STD_DOCTOR_COMMAND=${STD_DOCTOR_COMMAND:-docker compose exec -T server pnpm --silent std doctor}
RUN=${QUICKSTART_RUN:-$(date -u +%Y%m%d-%H%M%S)}

ALICE_PASSWORD=${QUICKSTART_ALICE_PASSWORD:-alice-quickstart-password}
BOB_PASSWORD=${QUICKSTART_BOB_PASSWORD:-bob-quickstart-password}

# Stable IDs of everything the quickstart defines, as a definition set would
# fix them (Contracts 1.1). Rules and conditions refer to fields by ID.
NS_ACME=97697c8a-34d9-4e06-96ec-96347b838d0b
ASSET=79ef61ca-2e3b-462d-a209-5f8a7fb72ef9
ASSET_NAME=6e1da7da-ef0c-4529-bf3e-43d292740d53
ASSET_OWNER=9c9add00-bcb7-44b7-9dbe-bf7a624b73bf
ASSET_STATUS=da27b8a2-4888-47ec-9b89-e5983fc89e00
ASSET_COST=50f84f10-9573-4017-af44-66f96ef7e394
ASSET_PURCHASED_ON=bb0da4c0-bb90-4393-b2f8-15aef6135cfc
ASSET_NOTES=6e56e690-1ceb-4891-899b-8d341783302b
LAPTOP=8f5a249d-b039-4ea0-a297-b1330e7f1cf8
LAPTOP_SERIAL=e0f10990-8b76-4a99-81ce-ceed8a7d3e97
LAPTOP_MEMORY=a89e9192-d018-430d-9b91-bd727bee20f2
ROLE_ASSET_MANAGER=eee38982-3db4-4e07-9bd6-2005b492ff28
ROLE_EMPLOYEE=ae7f5486-db6e-4bfe-b55f-fc5910d7c763
RULE_MANAGER_RECORDS=dfee3ab2-e9b7-4e72-ac71-ad5e468ea95b
RULE_MANAGER_ASSET_FIELDS=b5390200-b4f5-4408-bc26-e25cdd0034a2
RULE_MANAGER_LAPTOP_FIELDS=c8eeea4f-1b44-4afe-b458-587f7a82f854
RULE_EMPLOYEE_OWN_RECORDS=fb4e32b3-3184-4dfd-a0a7-07ba07fbb02a
RULE_EMPLOYEE_ASSET_FIELDS=ebfc4925-726f-4ede-a585-28f3fc4cc90e
RULE_EMPLOYEE_NO_COST=ab5370f4-7391-48f6-aae4-da6fa88d0644
RULE_EMPLOYEE_LAPTOP_FIELDS=a604e17b-5660-4c08-baf2-42676f9635a4
RULE_EMPLOYEE_RENAME=7447db88-1f6e-4c7c-affc-e3a45f9f826c
# `core.user`, from the core definition set.
CORE_USER=da385db7-b2b7-4a1d-a1a9-42e8e0bb7992

API="$STD_URL/api/v2"
BODY_FILE=$(mktemp)
HEADER_FILE=$(mktemp)
RESPONSE_HEADERS=$(mktemp)
trap 'rm -f "$BODY_FILE" "$HEADER_FILE" "$RESPONSE_HEADERS"' EXIT

# --- HTTP helpers -----------------------------------------------------------
#
# Credentials never go into a command's arguments, where any local user can
# read them (`ps`, /proc/<pid>/cmdline): request bodies reach curl on stdin,
# the session token reaches it through a header file, and passwords reach jq
# on stdin (`jq -R`). Builtins such as `printf` start no process.

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

# request METHOD PATH [BODY]: sends one request as $TOKEN (if set), with
# If-Match: "$IF_MATCH" (if set); a PATCH body is a merge patch. Sets STATUS
# and BODY (the response headers go to $RESPONSE_HEADERS); never fails on an
# HTTP error, so the caller can check an expected refusal.
request() {
  local method=$1 path=$2 body=${3:-}
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
    args+=(-H "if-match: \"$IF_MATCH\"")
  fi

  if [[ -n $body ]]; then
    args+=(-H "content-type: $type" --data-binary @-)
  fi

  STATUS=$(printf '%s' "$body" | curl "${args[@]}" "$API$path")
  BODY=$(cat "$BODY_FILE")
}

# ok METHOD PATH [BODY]: like request, but prints the body and stops the
# script on anything but 2xx.
ok() {
  request "$@"

  if [[ $STATUS != 2?? ]]; then
    fail "$1 $2 -> $STATUS $BODY"
  fi

  printf '%s\n' "$BODY"
}

# outcome: the status and error code of the last request (a TMF Error's
# `code`), e.g. "404 NotFound".
outcome() {
  printf '%s %s' "$STATUS" "$(jq -r '.code // empty' <<<"$BODY" 2>/dev/null || true)"
}

# total: the X-Total-Count of the last list.
total() {
  sed -n 's/^x-total-count: *\([0-9]*\).*/\1/Ip' "$RESPONSE_HEADERS" | tr -d '\r'
}

# api_name NAME: a definition name as the API names it (`purchased_on` is
# `purchasedOn`; Contracts 10.2).
api_name() {
  jq -rn --arg name "$1" '$name | split("_") | map(select(. != ""))
    | [.[0]] + (.[1:] | map((.[0:1] | ascii_upcase) + .[1:])) | join("")'
}

# refused STATUS TAG METHOD PATH [BODY]: a request that must be refused with
# exactly this status and error tag; anything else stops the script.
refused() {
  local status=$1 tag=$2
  shift 2
  request "$@"

  if [[ $(outcome) != "$status $tag" ]]; then
    fail "$1 $2: expected $status $tag, got $STATUS $BODY"
  fi
}

# expect JSON FILTER WHAT: stops the script unless the jq FILTER is true.
expect() {
  jq -e "$2" >/dev/null <<<"$1" || fail "expected $3; got $1"
}

# exists COLLECTION ID: whether the record is there (as the current user).
exists() {
  request GET "/$1/$2"

  case $STATUS in
    200) return 0 ;;
    404) return 1 ;;
    *) fail "GET $1/$2 -> $STATUS $BODY" ;;
  esac
}

# uri TEXT: TEXT percent-encoded for a query parameter.
uri() {
  jq -rn --arg text "$1" '$text | @uri'
}

# sign_in LOGIN PASSWORD: prints a session token (delivered in the body).
sign_in() {
  local body
  body=$(printf '%s' "$2" | jq -Rsc --arg login "$1" '{login: $login, password: ., tokenDelivery: "body"}')
  TOKEN='' ok POST /session "$body" | jq -r .token
}

# applied: one line about the change set an applyChangeSet answered.
applied() {
  jq -r '"change set \(.id): \(.state) at revision \(.revision)" + (if (.operations | length) > 0 then ", \(.operations | length) operations" else "" end)'
}

heading() {
  printf '\n== %s ==\n' "$1"
}

# A local definition draft: the properties every created definition has.
LOCAL='{"owner": {"layer": "local"}, "protected": false}'

# --- 1. Tables ---------------------------------------------------------------

echo "STD quickstart against $STD_URL (run $RUN)"

heading "Sign in as the administrator ($STD_ADMIN_LOGIN)"
TOKEN=$(sign_in "$STD_ADMIN_LOGIN" "$STD_ADMIN_PASSWORD")
ADMIN=$TOKEN
echo "signed in"

heading "Create acme.asset and acme.laptop (one change set)"
if exists coreClass "$LAPTOP"; then
  echo "already there: an earlier run created them"
else
  # field ID CLASS NAME TYPE [REQUIRED]: an addField operation.
  field() {
    jq -nc --argjson local "$LOCAL" --arg id "$1" --arg class "$2" --arg name "$3" \
      --argjson type "$4" --argjson required "${5:-false}" \
      '{op: "addField", definition: ($local + {kind: "field", id: $id, classId: $class,
        name: $name, label: ($name | gsub("_"; " ") | ascii_upcase[0:1] + .[1:]),
        helpText: null, type: $type, required: $required, readOnly: false, default: null})}'
  }

  # class ID NAME LABEL PARENT DISPLAY_FIELD: a createClass operation.
  class() {
    jq -nc --argjson local "$LOCAL" --arg id "$1" --arg name "$2" --arg label "$3" \
      --arg ns "$NS_ACME" --arg parent "$4" --arg display "$5" \
      '{op: "createClass", definition: ($local + {kind: "class", id: $id, name: $name,
        label: $label, helpText: null, namespaceId: $ns,
        parentId: (if $parent == "" then null else $parent end),
        displayFieldId: (if $display == "" then null else $display end),
        extensible: false, storage: "standard"})}'
  }

  operations=$(jq -sc '{operations: .}' <<EOF
$(jq -nc --argjson local "$LOCAL" --arg id "$NS_ACME" \
  '{op: "createNamespace", definition: ($local + {kind: "namespace", id: $id, name: "acme",
    label: "Acme", helpText: null, extensible: false, storage: "standard"})}')
$(class "$ASSET" asset Asset "" "")
$(field "$ASSET_NAME" "$ASSET" name '{"kind": "text", "maxLength": 120}' true)
$(field "$ASSET_OWNER" "$ASSET" owner "{\"kind\": \"reference\", \"targetClassId\": \"$CORE_USER\"}")
$(field "$ASSET_STATUS" "$ASSET" status '{"kind": "text", "maxLength": 32}')
$(field "$ASSET_COST" "$ASSET" cost '{"kind": "decimal", "precision": 12, "scale": 2}')
$(field "$ASSET_PURCHASED_ON" "$ASSET" purchased_on '{"kind": "date"}')
$(field "$ASSET_NOTES" "$ASSET" notes '{"kind": "longText"}')
$(class "$LAPTOP" laptop Laptop "$ASSET" "")
$(field "$LAPTOP_SERIAL" "$LAPTOP" serial '{"kind": "text", "maxLength": 64}')
$(field "$LAPTOP_MEMORY" "$LAPTOP" memory_gb '{"kind": "integer", "min": 1}')
$(jq -nc --arg id "$ASSET" --arg display "$ASSET_NAME" \
  '{op: "update", id: $id, version: 1, changes: {displayFieldId: $display}}')
EOF
)
  ok POST /applyChangeSet "$operations" | applied
fi

# --- 2. Roles and access rules ----------------------------------------------

heading "Create roles asset_manager and employee with their access rules (one change set)"
if exists coreAccessRule "$RULE_EMPLOYEE_RENAME"; then
  echo "already there: an earlier run created them"
else
  role() {
    jq -nc --argjson local "$LOCAL" --arg id "$1" --arg name "$2" --arg label "$3" \
      '{op: "createRole", definition: ($local + {kind: "role", id: $id, name: $name,
        label: $label, helpText: null})}'
  }

  # rule ID EFFECT ROLE CLASS TARGET ACTIONS CONDITION DESCRIPTION
  rule() {
    jq -nc --argjson local "$LOCAL" --arg id "$1" --arg effect "$2" --arg role "$3" \
      --arg class "$4" --argjson target "$5" --argjson actions "$6" --argjson condition "$7" \
      --arg description "$8" \
      '{op: "createAccessRule", definition: ($local + {kind: "accessRule", id: $id,
        name: null, description: $description, effect: $effect, roleIds: [$role],
        classId: $class, target: $target, actions: $actions, condition: $condition,
        active: true})}'
  }

  RECORDS='{"kind": "records"}'
  ALL_FIELDS='{"kind": "fields", "fields": "*"}'
  OWNER_IS_ME="{\"op\": \"eq\", \"left\": {\"path\": [\"$ASSET_OWNER\"]}, \"right\": {\"ctx\": \"me\"}}"

  operations=$(jq -sc '{operations: .}' <<EOF
$(role "$ROLE_ASSET_MANAGER" asset_manager "Asset manager")
$(role "$ROLE_EMPLOYEE" employee Employee)
$(rule "$RULE_MANAGER_RECORDS" allow "$ROLE_ASSET_MANAGER" "$ASSET" "$RECORDS" '["read", "create", "update", "delete"]' null "asset managers may do everything with assets")
$(rule "$RULE_MANAGER_ASSET_FIELDS" allow "$ROLE_ASSET_MANAGER" "$ASSET" "$ALL_FIELDS" '["read", "create", "update"]' null "asset managers read and write every asset field")
$(rule "$RULE_MANAGER_LAPTOP_FIELDS" allow "$ROLE_ASSET_MANAGER" "$LAPTOP" "$ALL_FIELDS" '["read", "create", "update"]' null "asset managers read and write every laptop field")
$(rule "$RULE_EMPLOYEE_OWN_RECORDS" allow "$ROLE_EMPLOYEE" "$ASSET" "$RECORDS" '["read", "update"]' "$OWNER_IS_ME" "employees read and update their own assets")
$(rule "$RULE_EMPLOYEE_ASSET_FIELDS" allow "$ROLE_EMPLOYEE" "$ASSET" "$ALL_FIELDS" '["read"]' null "employees read every asset field")
$(rule "$RULE_EMPLOYEE_NO_COST" deny "$ROLE_EMPLOYEE" "$ASSET" "{\"kind\": \"fields\", \"fields\": [\"$ASSET_COST\"]}" '["read"]' null "employees never read cost")
$(rule "$RULE_EMPLOYEE_LAPTOP_FIELDS" allow "$ROLE_EMPLOYEE" "$LAPTOP" "$ALL_FIELDS" '["read"]' null "employees read every laptop field")
$(rule "$RULE_EMPLOYEE_RENAME" allow "$ROLE_EMPLOYEE" "$ASSET" "{\"kind\": \"fields\", \"fields\": [\"$ASSET_NAME\"]}" '["update"]' null "employees may rename their assets")
EOF
)
  ok POST /applyChangeSet "$operations" | applied
fi

# --- 3. Users ----------------------------------------------------------------

heading "Create users Alice (asset_manager) and Bob (employee)"
# user LOGIN NAME PASSWORD ROLE_ID ROLE_NAME: makes sure the user exists and
# holds the role, each checked on its own, so a run that stopped between the
# two is completed. An existing user's password is never changed. Prints the
# user's ID.
user() {
  local id body count
  id=$(ok GET "/coreUser?login=$(uri "$1")" | jq -r '.[0].id // empty')

  if [[ -n $id ]]; then
    echo "  $1 exists (password left alone)" >&2
  else
    body=$(printf '%s' "$3" | jq -Rsc --arg login "$1" --arg name "$2" \
      '{login: $login, name: $name, password: ., active: true}')
    id=$(ok POST /coreUser "$body" | jq -r .id)
    echo "  created $1" >&2
  fi

  count=$(ok GET "/coreUserRole?user=$id&role=$4" | jq length)

  if [[ $count == 0 ]]; then
    ok POST /coreUserRole "$(jq -nc --arg user "$id" --arg role "$4" \
      '{user: $user, role: $role}')" >/dev/null
    echo "  assigned $5 to $1" >&2
  else
    echo "  $1 holds $5" >&2
  fi

  printf '%s' "$id"
}
ALICE_ID=$(user alice Alice "$ALICE_PASSWORD" "$ROLE_ASSET_MANAGER" asset_manager)
BOB_ID=$(user bob Bob "$BOB_PASSWORD" "$ROLE_EMPLOYEE" employee)

ALICE=$(sign_in alice "$ALICE_PASSWORD")
BOB=$(sign_in bob "$BOB_PASSWORD")

# --- 4. Laptops ----------------------------------------------------------------

# The fields as they are named now: an earlier run may have renamed `serial`
# and retired `notes`.
SERIAL=$(api_name "$(ok GET "/coreField/$LAPTOP_SERIAL" | jq -r .name)")
NOTES_STATE=$(ok GET "/coreField/$ASSET_NOTES" | jq -r .state)

heading "Alice adds two laptops and a plain asset (run $RUN)"
TOKEN=$ALICE
# add COLLECTION JSON: creates a record as Alice and prints its ID.
add() {
  local body=$2 saved
  if [[ $NOTES_STATE != active ]]; then
    body=$(jq -c 'del(.notes)' <<<"$body")
  fi
  saved=$(ok POST "/$1" "$body")
  jq -r '"  created \(.name) (\(."@type") v\(.revision))"' <<<"$saved" >&2
  jq -r .id <<<"$saved"
}
BOB_LAPTOP=$(add acmeLaptop "$(jq -nc --arg run "$RUN" --arg owner "$BOB_ID" --arg serial "$SERIAL" \
  '{name: "Bob laptop \($run)", owner: {id: $owner}, status: "in_use", cost: "1200.00",
    purchasedOn: "2026-01-15", ($serial): "SN-B-\($run)", memoryGb: 16, notes: "dock at desk 4"}')")
ALICE_LAPTOP=$(add acmeLaptop "$(jq -nc --arg run "$RUN" --arg owner "$ALICE_ID" --arg serial "$SERIAL" \
  '{name: "Alice laptop \($run)", owner: {id: $owner}, status: "in_use", cost: "1800.00",
    purchasedOn: "2026-03-01", ($serial): "SN-A-\($run)", memoryGb: 32, notes: "spare charger"}')")
add acmeAsset "$(jq -nc --arg run "$RUN" --arg owner "$BOB_ID" \
  '{name: "Bob monitor \($run)", owner: {id: $owner}, status: "in_use", cost: "300.00",
    purchasedOn: "2025-06-01"}')" >/dev/null

heading "Two updates for the history: Alice changes the cost, Bob renames his laptop"
saved=$(IF_MATCH=1 ok PATCH "/acmeAsset/$BOB_LAPTOP" '{"cost": "1150.00", "status": "repair"}')
expect "$saved" '.revision == 2' "revision 2 after Alice's update"
echo "  alice PATCH /acmeAsset {cost, status} -> revision 2"
TOKEN=$BOB
saved=$(IF_MATCH=2 ok PATCH "/acmeLaptop/$BOB_LAPTOP" "$(jq -nc --arg run "$RUN" '{name: "Bob travel laptop \($run)"}')")
expect "$saved" '.revision == 3' "revision 3 after Bob's update"
echo "  bob PATCH /acmeLaptop {name} -> revision 3"

# --- 5. Rename and retire -----------------------------------------------------

TOKEN=$ADMIN
heading "Rename the field acme.laptop.serial to serial_number (a change set)"
if [[ $SERIAL == serialNumber ]]; then
  echo "already renamed by an earlier run"
else
  version=$(ok GET "/coreField/$LAPTOP_SERIAL" | jq -r .revision)
  ok POST /applyChangeSet "$(jq -nc --arg id "$LAPTOP_SERIAL" --argjson version "$version" \
    '{operations: [{op: "rename", id: $id, version: $version, name: "serial_number"}]}')" | applied
fi
refused 400 UnknownField GET "/acmeLaptop/$BOB_LAPTOP?fields=serial"
echo "  the old name: GET ?fields=serial -> $(outcome) (no aliases)"
read_back=$(ok GET "/acmeLaptop/$BOB_LAPTOP?fields=serialNumber")
expect "$read_back" ".serialNumber == \"SN-B-$RUN\"" "the serial under its new name"
echo "  the new name: GET ?fields=serialNumber -> serialNumber=SN-B-$RUN"

heading "Retire the field acme.asset.notes (a change set; the data stays)"
if [[ $NOTES_STATE != active ]]; then
  echo "already retired by an earlier run"
else
  version=$(ok GET "/coreField/$ASSET_NOTES" | jq -r .revision)
  ok POST /applyChangeSet "$(jq -nc --arg id "$ASSET_NOTES" --argjson version "$version" \
    '{operations: [{op: "retire", id: $id, version: $version}]}')" | applied
fi
read_back=$(ok GET "/acmeLaptop/$ALICE_LAPTOP")
expect "$read_back" 'has("notes") | not' "notes left out of the default selection"
jq -r '"  default selection: \(keys | map(select(IN("id", "href", "revision", "creationDate", "createdBy", "lastUpdate", "updatedBy") or startswith("@") | not)) | join(", "))"' <<<"$read_back"
read_back=$(ok GET "/acmeLaptop/$ALICE_LAPTOP?fields=name,notes")
# An empty attribute is left out (Contracts 10.2): only a laptop created
# while notes was active has one.
if [[ $NOTES_STATE == active ]]; then
  expect "$read_back" 'has("notes")' "notes returned when selected explicitly"
  jq -r '"  selected explicitly: notes=\(.notes)"' <<<"$read_back"
else
  expect "$read_back" 'has("notes") | not' "no notes on a laptop created after the retire"
  echo "  selected explicitly: notes is empty (this run created the laptop after the retire)"
fi
IF_MATCH=1 refused 422 ValidationFailed PATCH "/acmeLaptop/$ALICE_LAPTOP" '{"notes": "new note"}'
expect "$BODY" 'any(.fieldErrors[]; ._tag == "DefinitionRetired" and .field == "notes")' "DefinitionRetired on notes"
echo "  writing it: PATCH {notes} -> $(outcome) (notes: DefinitionRetired)"

# --- 6. What each user sees ---------------------------------------------------

# The attributes every resource has, left out of what show prints.
SYSTEM='["id", "href", "name", "revision", "creationDate", "createdBy", "lastUpdate", "updatedBy", "withheld"]'

# show NAME TOKEN COLLECTION COUNT: this run's records of COLLECTION as one
# user sees them; there must be COUNT.
show() {
  local list count
  list=$(TOKEN=$2 ok GET "/$3?sort=name&condition=$(uri "name contains \"$RUN\"")")
  count=$(total)
  expect "$list" "length == $4" "$1 to see $4 records of this run via /$3"
  [[ $count == "$4" ]] || fail "X-Total-Count $count, expected $4, for $1 via /$3"
  jq -r --arg who "$1" --arg collection "$3" --argjson system "$SYSTEM" '
    "  \($who) via /\($collection): records from this run: \(length)",
    (.[] |
      "    \(.name) (\(."@type") v\(.revision)): " +
      ([to_entries[]
        | select((.key | IN($system[])) or (.key | startswith("@")) | not)
        | "\(.key)=\(if (.value | type) == "object" then (.value.name // .value.id) else .value end)"]
        | join(", ")) +
      (if (.withheld // []) == [] then "" else " [withheld: \(.withheld | join(", "))]" end))' <<<"$list"
  LIST=$list
}

heading "What Alice (asset_manager) and Bob (employee) see"
show alice "$ALICE" acmeAsset 3
expect "$LIST" 'all(.[]; has("cost"))' "Alice to see every cost"
show alice "$ALICE" acmeLaptop 2
show bob "$BOB" acmeAsset 2
expect "$LIST" "all(.[]; .owner.id == \"$BOB_ID\" and (has(\"cost\") | not))" "Bob to see only his own assets, without cost"
show bob "$BOB" acmeLaptop 1
expect "$LIST" ".[0].id == \"$BOB_LAPTOP\" and (.[0] | has(\"cost\") | not)" "Bob to see only his laptop, without cost"

heading "What Bob is refused"
TOKEN=$BOB refused 404 NotFound GET "/acmeLaptop/$ALICE_LAPTOP"
echo "  bob GET /acmeLaptop/{Alice's laptop} -> $(outcome) (the same as an unknown ID)"
TOKEN=$BOB refused 400 UnknownField GET "/acmeAsset?condition=$(uri 'cost > 0')"
echo "  bob condition \"cost > 0\" -> $(outcome) (cost is never readable for him)"

# --- 7. History ---------------------------------------------------------------

heading "History of Bob's laptop, as each user sees it (fields under their current names)"
for who in alice bob; do
  if [[ $who == alice ]]; then token=$ALICE; else token=$BOB; fi
  history=$(TOKEN=$token ok GET "/acmeAsset/$BOB_LAPTOP/history")
  expect "$history" '[.[].revision] == [1, 2, 3]' "revisions 1, 2 and 3 in $who's history"

  if [[ $who == alice ]]; then
    expect "$history" '.[0].changes | has("cost")' "cost in Alice's history"
  else
    expect "$history" 'all(.[]; .changes | has("cost") | not)' "no cost in Bob's history"
  fi

  jq -r --arg who "$who" --arg alice "$ALICE_ID" --arg bob "$BOB_ID" '
    def person: if . == $alice then "alice" elif . == $bob then "bob" else . end;
    def shown: if . == null then "null" elif (type == "string") then (person) else tojson end;
    "  as \($who), via /acmeAsset:",
    (.[] | . as $entry |
      "    v\(.revision) \(.kind) by \(.actor.id | person): " +
      ([.changes | to_entries[] | select(.key | test("^(created|updated)_|^(creationDate|createdBy|lastUpdate|updatedBy)$") | not)
        | if $entry.kind == "create" then "\(.key)=\(.value.after | shown)"
          else "\(.key) \(.value.before | shown) -> \(.value.after | shown)" end]
        | join(", ")))' <<<"$history"
done

# --- 8. doctor ----------------------------------------------------------------

heading "std doctor"
status=0
sh -c "$STD_DOCTOR_COMMAND" || status=$?
echo "std doctor exited $status"
exit "$status"
