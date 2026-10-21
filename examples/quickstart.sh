#!/usr/bin/env bash
# STD quickstart: the Step 1 runnable result (docs/plan.md).
#
# Against a running `std serve`, through its HTTP API only, it:
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
#
# Every password here is a disposable demo credential. Never reuse them.
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true # bash 4.4 and later

STD_URL=${STD_URL:-http://127.0.0.1:8080}
STD_ADMIN_LOGIN=${STD_ADMIN_LOGIN:-administrator}
STD_ADMIN_PASSWORD=${STD_ADMIN_PASSWORD:-quickstart-admin-password}
STD_DOCTOR_COMMAND=${STD_DOCTOR_COMMAND:-docker compose exec -T server pnpm --silent std doctor}
RUN=${QUICKSTART_RUN:-$(date -u +%Y%m%d-%H%M%S)}

ALICE_PASSWORD=alice-quickstart-password
BOB_PASSWORD=bob-quickstart-password

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

API="$STD_URL/api/v1"
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

# --- HTTP helpers -----------------------------------------------------------

# request METHOD PATH [BODY]: sends one request as $TOKEN (if set), with
# If-Match: "$IF_MATCH" (if set). Sets STATUS and BODY; never fails on an
# HTTP error, so the caller can show an expected refusal.
request() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method")

  if [[ -n ${TOKEN:-} ]]; then
    args+=(-H "authorization: Bearer $TOKEN")
  fi

  if [[ -n ${IF_MATCH:-} ]]; then
    args+=(-H "if-match: \"$IF_MATCH\"")
  fi

  if [[ -n $body ]]; then
    # The body goes through stdin, so passwords stay out of process listings.
    args+=(-H 'content-type: application/json' --data-binary @-)
  fi

  STATUS=$(printf '%s' "$body" | curl "${args[@]}" "$API$path")
  BODY=$(cat "$BODY_FILE")
}

# ok METHOD PATH [BODY]: like request, but prints the body and stops the
# script on anything but 2xx.
ok() {
  request "$@"

  if [[ $STATUS != 2?? ]]; then
    echo "FAILED: $1 $2 -> $STATUS $BODY" >&2
    exit 1
  fi

  printf '%s\n' "$BODY"
}

# outcome: the status and error tag of the last request, e.g. "404 NotFound".
outcome() {
  printf '%s %s' "$STATUS" "$(jq -r '._tag // empty' <<<"$BODY" 2>/dev/null || true)"
}

# exists TABLE ID: whether the record is there (as the current user).
exists() {
  request GET "/tables/$1/records/$2"

  case $STATUS in
    200) return 0 ;;
    404) return 1 ;;
    *)
      echo "FAILED: GET $1/$2 -> $STATUS $BODY" >&2
      exit 1
      ;;
  esac
}

# uri TEXT: TEXT percent-encoded for a query parameter.
uri() {
  jq -rn --arg text "$1" '$text | @uri'
}

sign_in() {
  local token
  token=$(TOKEN='' ok POST /auth/sign-in "$(jq -nc --arg login "$1" --arg password "$2" \
    '{login: $login, password: $password}')" | jq -r .token)
  printf '%s' "$token"
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
if exists core.class "$LAPTOP"; then
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
  ok POST /schema/change-sets "$operations" | jq -r '"change set \(.changeSet.id): \(.changeSet.state) at revision \(.changeSet.revision), \(.changeSet.operations | length) operations (namespace, 2 tables, 8 fields, display field)"'
fi

# --- 2. Roles and access rules ----------------------------------------------

heading "Create roles asset_manager and employee with their access rules (one change set)"
if exists core.access_rule "$RULE_EMPLOYEE_RENAME"; then
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
  ok POST /schema/change-sets "$operations" | jq -r '"change set \(.changeSet.id): \(.changeSet.state) at revision \(.changeSet.revision), \(.changeSet.operations | length) operations (2 roles, 8 access rules)"'
fi

# --- 3. Users ----------------------------------------------------------------

heading "Create users Alice (asset_manager) and Bob (employee)"
# user LOGIN NAME PASSWORD ROLE: creates the user and its role assignment
# unless the login exists; prints the user's ID.
user() {
  local id
  id=$(ok GET "/tables/core.user/records?filter=$(uri "login = \"$1\"")" | jq -r '.records[0].id // empty')

  if [[ -n $id ]]; then
    echo "$1 already exists" >&2
  else
    id=$(ok POST /tables/core.user/records "$(jq -nc --arg login "$1" --arg name "$2" \
      --arg password "$3" '{login: $login, name: $name, password: $password, active: true}')" |
      jq -r .record.id)
    ok POST /tables/core.user_role/records "$(jq -nc --arg user "$id" --arg role "$4" \
      '{user: $user, role: $role}')" >/dev/null
    echo "created $1 with role $5" >&2
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
SERIAL=$(ok GET "/tables/core.field/records/$LAPTOP_SERIAL" | jq -r .record.values.name)
NOTES_STATE=$(ok GET "/tables/core.field/records/$ASSET_NOTES" | jq -r .record.values.state)

heading "Alice adds two laptops and a plain asset (run $RUN)"
TOKEN=$ALICE
# add TABLE JSON: creates a record as Alice and prints its ID.
add() {
  local body=$2
  if [[ $NOTES_STATE != active ]]; then
    body=$(jq -c 'del(.notes)' <<<"$body")
  fi
  ok POST "/tables/$1/records" "$body" | jq -r '.record | "  created \(.values.name) (\(.class) v\(.version))" , .id' |
    { IFS= read -r line; echo "$line" >&2; read -r id; printf '%s' "$id"; }
}
BOB_LAPTOP=$(add acme.laptop "$(jq -nc --arg run "$RUN" --arg owner "$BOB_ID" --arg serial "$SERIAL" \
  '{name: "Bob laptop \($run)", owner: $owner, status: "in_use", cost: "1200.00",
    purchased_on: "2026-01-15", ($serial): "SN-B-\($run)", memory_gb: 16, notes: "dock at desk 4"}')")
ALICE_LAPTOP=$(add acme.laptop "$(jq -nc --arg run "$RUN" --arg owner "$ALICE_ID" --arg serial "$SERIAL" \
  '{name: "Alice laptop \($run)", owner: $owner, status: "in_use", cost: "1800.00",
    purchased_on: "2026-03-01", ($serial): "SN-A-\($run)", memory_gb: 32, notes: "spare charger"}')")
add acme.asset "$(jq -nc --arg run "$RUN" --arg owner "$BOB_ID" \
  '{name: "Bob monitor \($run)", owner: $owner, status: "in_use", cost: "300.00",
    purchased_on: "2025-06-01"}')" >/dev/null

heading "Two updates for the history: Alice changes the cost, Bob renames his laptop"
IF_MATCH=1 ok PATCH "/tables/acme.asset/records/$BOB_LAPTOP" '{"cost": "1150.00", "status": "repair"}' |
  jq -r '"  alice PATCH /acme.asset {cost, status} -> version \(.record.version)"'
TOKEN=$BOB
IF_MATCH=2 ok PATCH "/tables/acme.laptop/records/$BOB_LAPTOP" "$(jq -nc --arg run "$RUN" '{name: "Bob travel laptop \($run)"}')" |
  jq -r '"  bob PATCH /acme.laptop {name} -> version \(.record.version)"'

# --- 5. Rename and retire -----------------------------------------------------

TOKEN=$ADMIN
heading "Rename the field acme.laptop.serial to serial_number (a change set)"
if [[ $SERIAL == serial_number ]]; then
  echo "already renamed by an earlier run"
else
  version=$(ok GET "/tables/core.field/records/$LAPTOP_SERIAL" | jq -r .record.version)
  ok POST /schema/change-sets "$(jq -nc --arg id "$LAPTOP_SERIAL" --argjson version "$version" \
    '{operations: [{op: "rename", id: $id, version: $version, name: "serial_number"}]}')" |
    jq -r '"change set \(.changeSet.id): \(.changeSet.state) at revision \(.changeSet.revision)"'
fi
request GET "/tables/acme.laptop/records/$BOB_LAPTOP?fields=serial"
echo "  the old name: GET ?fields=serial -> $(outcome) (no aliases)"
ok GET "/tables/acme.laptop/records/$BOB_LAPTOP?fields=serial_number" |
  jq -r '"  the new name: GET ?fields=serial_number -> serial_number=\(.record.values.serial_number)"'

heading "Retire the field acme.asset.notes (a change set; the data stays)"
if [[ $NOTES_STATE != active ]]; then
  echo "already retired by an earlier run"
else
  version=$(ok GET "/tables/core.field/records/$ASSET_NOTES" | jq -r .record.version)
  ok POST /schema/change-sets "$(jq -nc --arg id "$ASSET_NOTES" --argjson version "$version" \
    '{operations: [{op: "retire", id: $id, version: $version}]}')" |
    jq -r '"change set \(.changeSet.id): \(.changeSet.state) at revision \(.changeSet.revision)"'
fi
ok GET "/tables/acme.laptop/records/$ALICE_LAPTOP" |
  jq -r '"  default selection: \(.record.values | keys | map(select(test("^(created|updated)_") | not)) | join(", "))"'
ok GET "/tables/acme.laptop/records/$ALICE_LAPTOP?fields=name,notes" |
  jq -r '"  selected explicitly: notes=\(.record.values.notes)"'
IF_MATCH=1 request PATCH "/tables/acme.laptop/records/$ALICE_LAPTOP" '{"notes": "new note"}'
echo "  writing it: PATCH {notes} -> $(outcome) ($(jq -r '[.errors[]? | "\(.field): \(._tag)"] | join(", ")' <<<"$BODY"))"

# --- 6. What each user sees ---------------------------------------------------

# show NAME TOKEN TABLE: this run's records of TABLE as one user sees them.
show() {
  TOKEN=$2 ok GET "/tables/$3/records?labels=true&count=true&sort=name&filter=$(uri "name contains \"$RUN\"")" |
    jq -r --arg who "$1" --arg table "$3" '
      "  \($who) via /\($table): records from this run: \(.count)",
      (.records[] | . as $r |
        "    \(.values.name) (\(.class) v\(.version)): " +
        ([.values | to_entries[]
          | select(.key != "name" and (.key | test("^(created|updated)_") | not))
          | "\(.key)=\(if .key == "owner" then ($r.labels.owner // .value) else .value end)"]
          | join(", ")) +
        (if (.withheld // []) == [] then "" else " [withheld: \(.withheld | join(", "))]" end))'
}

heading "What Alice (asset_manager) and Bob (employee) see"
for who in alice bob; do
  if [[ $who == alice ]]; then token=$ALICE; else token=$BOB; fi
  for table in acme.asset acme.laptop; do
    show "$who" "$token" "$table"
  done
done

heading "What Bob is refused"
TOKEN=$BOB request GET "/tables/acme.laptop/records/$ALICE_LAPTOP"
echo "  bob GET /acme.laptop/{Alice's laptop} -> $(outcome) (the same as an unknown ID)"
TOKEN=$BOB request GET "/tables/acme.asset/records?filter=$(uri 'cost > 0')"
echo "  bob filter \"cost > 0\" -> $(outcome) (cost is never readable for him)"

# --- 7. History ---------------------------------------------------------------

heading "History of Bob's laptop, as each user sees it (fields under their current names)"
for who in alice bob; do
  if [[ $who == alice ]]; then token=$ALICE; else token=$BOB; fi
  TOKEN=$token ok GET "/tables/acme.asset/records/$BOB_LAPTOP/history" |
    jq -r --arg who "$who" --arg alice "$ALICE_ID" --arg bob "$BOB_ID" '
      def person: if . == $alice then "alice" elif . == $bob then "bob" else . end;
      def shown: if . == null then "null" elif (type == "string") then (person) else tojson end;
      "  as \($who), via /acme.asset:",
      (.entries[] | . as $entry |
        "    v\(.version) \(.kind) by \(.actor | person): " +
        ([.changes | to_entries[] | select(.key | test("^(created|updated)_") | not)
          | if $entry.kind == "create" then "\(.key)=\(.value.after | shown)"
            else "\(.key) \(.value.before | shown) -> \(.value.after | shown)" end]
          | join(", ")))'
done

# --- 8. doctor ----------------------------------------------------------------

heading "std doctor"
status=0
sh -c "$STD_DOCTOR_COMMAND" || status=$?
echo "std doctor exited $status"
exit "$status"
