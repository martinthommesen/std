# Runbook: upgrade and recovery

This runbook covers `std upgrade` (Contracts 8.5), backup and restore (8.6), and recovery from an interrupted schema change (8.7). Every command is exact. Step 4 runs each scenario in CI against a scratch database (Contracts 8.7: "CI runs every runbook command"), so keep each block runnable on its own with only the variables below set.

## Conventions

- Run commands from the repository root. `pnpm std` runs the `std` command with the pinned Node; `pnpm --silent std` keeps pnpm's own header out of output that is parsed (`--json`).
- Every command reads the database from `STD_DATABASE_URL`. `psql`, `pg_dump` and `pg_restore` read the same URL.
- `doctor` exits 0 when clean, 1 on any error and 2 for warnings only. `std upgrade` exits 0 on success, 1 on a refusal or failure, 2 on a usage error.
- Each shell block is meant to run with `set -euo pipefail`. A block that expects a non-zero exit code says so and tests it explicitly.
- Values an operator reads from a previous step (a change set ID, a PID) go into environment variables, which each block validates before use (`: "${CHANGE_SET_ID:?set CHANGE_SET_ID}"`). SQL receives them as psql variables (`:'id'`), never by pasting them into the text; psql interpolates variables only in input it reads, not in `-c` commands, so those queries are passed on standard input.

```bash
set -euo pipefail
export STD_DATABASE_URL="postgres://std:std@127.0.0.1:54329/std"
# The app sets this install loads after core, in any order (std upgrade sorts them by `requires`).
export STD_SETS="--set examples/acme"
```

`STD_SETS` is word-split on purpose: one `--set <dir>` pair per app set.

## Upgrade an install

Use this for every STD release and every new version of an app set.

1. Plan with the servers still running. The plan changes nothing; it lists pending platform migrations, change sets to resume, each set's changes, conflicts, converged overrides, removals, refusals and the security changes, and prints the plan hash on its first line.

   ```bash
   pnpm std upgrade --plan $STD_SETS
   pnpm --silent std upgrade --plan --json $STD_SETS > upgrade-plan.json
   export STD_PLAN_HASH="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("upgrade-plan.json", "utf-8")).hash)')"
   ```

   If the last line says `Result: refused`, fix each refusal first (see "Refusals" below) and plan again. Review the "Security changes" section with whoever owns access control.

2. Stop every STD server. `std upgrade` refuses while any session with `application_name = 'std-server'` is connected:

   ```bash
   psql "$STD_DATABASE_URL" -Atc "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'std-server'"
   ```

   The query must print nothing.

3. Take a backup (see "Back up"). There are no down migrations; rollback is restoring this backup.

4. Apply exactly the reviewed plan:

   ```bash
   pnpm std upgrade --expect "$STD_PLAN_HASH" --report upgrade-report.json $STD_SETS
   ```

   If it fails with "The database changed since the plan", someone changed configuration after step 1: go back to step 1.

5. Check the database and start the servers:

   ```bash
   pnpm std doctor
   ```

   Exit 0 or 2 is fine to start (2 means warnings, such as orphan columns); fix errors first. Open conflicts are informational: the local value stays effective until an admin resolves them as `keep_local`, `take_shipped` or `replace`.

### Refusals

| Code | Cause | Fix |
| --- | --- | --- |
| `downgrade` | a set's version is lower than the installed one | install the newer set, or restore the backup taken before the newer version |
| `nameClash` | the new version adds a name a local definition uses; the refusal names it | rename the local definition, then plan again |
| `typeChanged` | the new version changes a field's type | the set's author adds a new field and retires the old one |
| `roleInUse` | the new version removes a role an active access rule still names; the refusal names the rules | change or deactivate those rules, then plan again |
| `dataViolation` | existing rows violate a tightened definition; the refusal gives the count and up to 20 IDs | fix the data, then plan again |
| `renameUnsupported`, `removalUnsupported`, `reactivationUnsupported` | the change needs schema lifecycle operations this STD lacks | upgrade STD first |
| `setCycle` | sets require each other | fix the sets' `requires` |
| `invalid` | the set's definitions do not validate | fix the set files |

## Recovery from an interrupted schema change (Contracts 8.7)

Find open change sets first:

```bash
psql "$STD_DATABASE_URL" -Atc "SELECT id, state, first_revision FROM core.schema_change WHERE state IN ('applying', 'needs_attention') ORDER BY first_revision"
```

### Interrupted during the main transaction

State: the main transaction rolled back; no journal rows. Recovery: none. Confirm:

```bash
pnpm std doctor
```

### Interrupted during a follow-up step

State: change set `applying`, a step `running`. Recovery: resume by probe. `std upgrade` resumes every `applying` change set before it loads sets (a server start does the same once `std serve` exists); with nothing else pending it changes nothing else:

```bash
pnpm std upgrade $STD_SETS
pnpm std doctor
```

### Index build waiting on another session

State: step `running`; the watchdog reports the PIDs the build waits for. Recovery: end the blocking session, or abandon the change set. Find the sessions the build waits for:

```bash
psql "$STD_DATABASE_URL" -Atc "SELECT p.pid, a.pid AS blocking_pid, a.application_name, a.state FROM pg_stat_progress_create_index p JOIN LATERAL unnest(pg_blocking_pids(p.pid)) AS b(pid) ON true JOIN pg_stat_activity a ON a.pid = b.pid"
```

End a blocking session only after checking with its owner. Set `BLOCKING_PID` to a `blocking_pid` from the query above:

```bash
: "${BLOCKING_PID:?set BLOCKING_PID to the PID of the blocking session}"
[[ "$BLOCKING_PID" =~ ^[0-9]+$ ]] || { echo "BLOCKING_PID must be a number" >&2; exit 2; }
psql "$STD_DATABASE_URL" -At -v pid="$BLOCKING_PID" <<'SQL'
SELECT pg_terminate_backend(:'pid'::int);
SQL
```

Or abandon the change set. Set `CHANGE_SET_ID` to its ID from the open change sets (`std schema` comes with workstream 1A):

```bash
: "${CHANGE_SET_ID:?set CHANGE_SET_ID to the change set ID}"
[[ "$CHANGE_SET_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "CHANGE_SET_ID must be a UUID" >&2; exit 2; }
pnpm std schema abandon "$CHANGE_SET_ID"
pnpm std doctor
```

### Repeatedly failing step

State: change set `needs_attention`; `doctor` reports `changeSetNeedsAttention` and `std upgrade` refuses, both naming the change set. Recovery: fix the cause (the step's `last_error` names it), then resume, or abandon. Set `CHANGE_SET_ID` to the change set's ID:

```bash
: "${CHANGE_SET_ID:?set CHANGE_SET_ID to the change set ID}"
[[ "$CHANGE_SET_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "CHANGE_SET_ID must be a UUID" >&2; exit 2; }
psql "$STD_DATABASE_URL" -At -v id="$CHANGE_SET_ID" <<'SQL'
SELECT ordinal, kind, state, attempts, last_error FROM core.schema_change_step WHERE change_id = :'id'::uuid ORDER BY ordinal;
SQL
pnpm std schema resume "$CHANGE_SET_ID"
pnpm std doctor
```

`std schema resume` and `std schema abandon` come with workstream 1A.

### Interrupted `std upgrade`

State: stopped at a boundary; every platform migration and every set's change set commits on its own. Recovery: rerun the same command. Committed migrations and sets plan nothing; the rerun continues with the first one that did not commit:

```bash
pnpm std upgrade $STD_SETS
pnpm std doctor
```

## Back up

All STD state is in one Postgres database (Contracts 8.6). A `pg_dump` is one snapshot, so it can run while servers run; during a follow-up phase it restores as a change set in `applying`, which resume completes.

```bash
pg_dump --format=custom --file=std-backup.dump "$STD_DATABASE_URL"
```

While a dump runs, concurrent index builds wait for its snapshot (the watchdog reports it) and DDL change sets get `SchemaLockTimeout`.

## Restore (Contracts 8.6)

1. Stop every STD server (the query in "Upgrade an install", step 2, must print nothing).
2. Restore into an empty database. `STD_RESTORE_DB` names a database that does not exist yet on the same Postgres 18 server:

   ```bash
   : "${STD_RESTORE_DB:=std_restored}"
   [[ "$STD_RESTORE_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "STD_RESTORE_DB must be a plain database name" >&2; exit 2; }
   export STD_RESTORE_URL="${STD_DATABASE_URL%/*}/$STD_RESTORE_DB"
   psql "$STD_DATABASE_URL" -At -v db="$STD_RESTORE_DB" <<'SQL'
   CREATE DATABASE :"db" ENCODING 'UTF8' TEMPLATE template0;
   SQL
   pg_restore --exit-on-error --no-owner --dbname="$STD_RESTORE_URL" std-backup.dump
   ```

3. Upgrade and check the restored database. `std upgrade` applies migrations newer than the backup, resumes change sets the dump caught in `applying`, and reloads the sets:

   ```bash
   STD_DATABASE_URL="$STD_RESTORE_URL" pnpm std upgrade $STD_SETS
   STD_DATABASE_URL="$STD_RESTORE_URL" pnpm std doctor
   ```

4. Point the servers at the restored database and start them. A server left running reloads its caches, which are keyed by `(revision, change_set_id)`, so a restore to an earlier state is picked up.

## The upgrade fixture

`examples/upgrade-fixture/v1`, `v2` and `v3` are the Step 1 gate fixture (plan, Step 1): a set whose v2 changes a field label that has a local override (a conflict), sets another to its local value (converged), changes a third (applied), renames a shipped role, adds a role and changes an access rule. To rehearse an upgrade on a scratch database:

```bash
pnpm std upgrade --set examples/upgrade-fixture/v1
pnpm std upgrade --plan --set examples/upgrade-fixture/v2
pnpm std upgrade --set examples/upgrade-fixture/v2
pnpm std upgrade --set examples/upgrade-fixture/v2
pnpm std doctor
```

The second `v2` run changes nothing, the revision included.
