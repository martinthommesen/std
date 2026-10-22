# 0024. The party foundation and `data` migrations (Step 3, workstream 3P)

Status: proposed, 2026-10-22 (workstream `ws/3p-party-foundation`). Code: `packages/server/definitions/core/{parties,users,set}.yaml`, `packages/definitions/src/well-known.ts`, `packages/server/src/records/{party-rules,save-pipeline,change-entry}.ts`, `packages/server/src/platform/{migration,ledger,runner,data-migrations,migrations}.ts`, `packages/server/src/platform/migrations/{0011-ledger-state,0012-user-individuals}.ts`, `packages/server/src/config/upgrade.ts`, `packages/server/src/doctor/check-server.ts`, `packages/server/src/cli/{main,format}.ts`, `examples/quickstart/src/{release,release-compat,previous-release}.ts`. Contracts 1.9, 1.10, 3.1, 8.5, 11.3.

Plan Step 3, guarantee 3P: "Every user, old and new, has exactly one individual, so TMF621 names parties consistently; an interrupted backfill never goes unnoticed", proved by `party-foundation` (backfill from `v0.0.2`, rerun, kill and resume, concurrent user creation) and `data-migration-interrupted`. Decision 0021 item 29 accepted the `data` migration kind.

## The party classes

The core set goes to version 2 with `parties.yaml`:

| Class | Fields | Notes |
| --- | --- | --- |
| `core.party` (root) | `name` (display field), `status` (choice `initialized`, `validated`, `deceased`, `closed`; default `initialized`), json `contact_medium`, `external_reference`, `party_characteristic` |  |
| `core.individual` extends party | `given_name`, `family_name` (both required), `birth_date` (date), json `individual_identification` | override: `status` limited to `initialized`, `validated`, `deceased` |
| `core.organization` extends party | `trading_name`, `is_legal_entity`, `organization_type`, `exists_from`, `exists_until` (date-times), json `organization_identification` | overrides: `name` required; `status` limited to `initialized`, `validated`, `closed` |
| `core.user` | gains `individual`: reference to `core.individual`, read-only, unique index |  |

Sources for what Step 4's TMF632 mapping needs: TMF632 Party Management user guide v5.0.0, "Individual fields" and "Organization fields" (pp. 10 to 11 and 31 to 32), and the TMF632 conformance profile v5.0.0, "Individual Resource Mandatory Attributes" (p. 3): `givenName` and `familyName` mandatory for an individual, `name` for an organization.

- **[judgment] Contact media, external references and characteristics on the root.** Contracts 11.3 listed them on `core.individual` only, but TMF632 has all three on both resources, so they sit on `core.party`; an individual has exactly the fields the contract listed, and an organization gains them. Contracts 11.3 is updated.
- **[judgment] One status field.** `status` is one choice on the root, and each child narrows it to its TMF632 state type with a choice-subset override (Contracts 2.5), so a filter on `core.party.status` works across both.
- **[judgment] `core.party_role` and `core.party_role_specification` move to Step 4.** Contracts 11.3 named them in the Step 3 core set; the plan's Step 3 "Includes" and this workstream's brief name only party, individual, organization and `core.user.individual`. Nothing in Step 3 reads them, and adding them later is the same core-set version bump as adding them now, with their TMF669 adapter (4D). Contracts 11.3 says so.
- **No access rules for parties yet [judgment].** Admins read and write them through the built-in allow-all rules. What helpdesk agents may read of a party (for TMF621's `relatedParty` names) is decided by the workstreams that serve it (3I, 4D), not guessed here; granting `authenticated` the names of every individual, customers included, would be a disclosure no Step 3 gate asks for.

## Every new user gets one (the core rule)

Contracts 11.3 says the individual is "created with the user by a core hook". A before-write hook may not write records and an after-write hook may not change the user (it is on the save stack, `RecordInSave`), so the record service does it as a fixed step of a create, like history (Contracts 4.2: configuration cannot disable it):

1. A create of `core.user` or any descendant (a local child class included) whose snapshot has `core.user.individual` runs the pipeline as usual up to validation. The field is read-only, so a body that names it is refused for every caller (`ValidationFailed`, `ReadOnlyField`).
2. After validation, where auto-numbers are assigned, the service creates the individual through the pipeline in the same transaction, as the acting user (so a caller who may create users but not individuals is refused, and nothing is written), with the user's save's cause. Its names come from the user's `name` (below).
3. It assigns the individual's ID to `individual`, like an auto-number, and inserts the user. Both change entries share one operation.

Every path that creates users goes through it: the generic API (v1 and the coming v2), `std bootstrap-admin` and `ensureUser` (seeds, quickstart), imports and JIT provisioning later. The unique index makes two users naming one individual impossible in Postgres itself, the reference's restrict rule refuses deleting a user's individual (`Referenced`), and users are never deleted (Contracts 3.10). So once the backfill ran, every user has exactly one.

- **[judgment] Names.** The individual's `family_name` is the last word of the user's `name`, `given_name` the words before it; a one-word name (`Administrator`, a mononym) gives both. TMF632 requires both, and inventing a placeholder would be worse data than repeating the one name. The individual's `name` is the user's `name` unchanged, so references show what they showed before. Keeping the two in step when either is renamed later is Step 4's identity work (4D).
- **[judgment] An individual's name.** "`name` filled from them by a core rule" is the same kind of fixed step, after the before-write hooks: a save of an individual that leaves `name` empty (a create without one, or an update that changes the given or family name without setting `name`) gets `"<given> <family>"`. A save that sets `name` keeps it, so a user's individual keeps the user's name. Record rules (Contracts 4.10) cannot express it: their `set` values copy one field and cannot concatenate.
- **`ensureUserIndividual`** (`save-pipeline.ts`) gives an existing user its individual: it locks the user's root row (`FOR UPDATE`, because `individual` has a unique index, Contracts 2.2), reads it again, and if `individual` is still empty creates the individual and updates the user, the reference assigned by the service after validation as on a create. A user that has one is left alone. Updates take values the service assigns through an internal parameter of the update path, never from a request.
- `createInTransaction` is typed explicitly (`CreateInTransaction`): a user's create nests its individual's create, and TypeScript cannot infer a function's type from its own body.
- A protected override's `delete` is now refused by the protected-definition guard first (`DefinitionProtected`), as Contracts 1.8 requires of every operation; before, an override's delete was `DefinitionInvalid` before the guard ran. The core set's two choice-subset overrides are the first protected overrides, and the built-in protection tests found it.

## `data` migrations

`PlatformMigration` gains the kind `data`: an ID in the one numbered list, a name, a description (the ledger checksum is the hash of kind, name and description, so the description changes whenever what it does changes), and a `batch(after, size)` that changes up to `size` records after the keyset cursor `after`, selecting only records that still need the change.

- **Ledger.** Platform migration 0011 (`tx`) adds `state` (`running`, `applied`; default `applied`, so every earlier row and every `tx` and `concurrent_index` row stays `applied`) and `progress` (JSON: `after`, the cursor, and `changed`, the records changed so far) to `core.platform_migration`. The ledger is read in the shape the database has, so `std upgrade --plan` and `doctor` still read a `v0.0.2` ledger before 0011 ran.
- **Order (Contracts 8.5).** `std upgrade` runs `tx` and `concurrent_index` migrations, resumes change sets, loads the sets, then `runDataMigrations`: every `data` migration that is pending or `running`, in ID order. The test harness builds its templates with the first step only; its fixtures and `loadCore` run the `data` step after loading sets, as `std upgrade` does.
- **Batches.** The row is inserted `running` in its own transaction before the first batch. Each batch is one request transaction: lock the ledger row, read `progress`, run the batch as the system user (`WriteAccess.allowAll`, the outbox producer's hooks, scrypt; Contracts 3.1), write the new `progress`, or `applied` after the batch that finds nothing left. Records and cursor commit together, so a run killed anywhere leaves exactly the committed batches done, and the rerun continues from the cursor. 100 records per batch [judgment]: a batch of the backfill is 200 saves, well inside the 30 s request statement timeout, and the batch size is an option of `runUpgrade`.
- **Cause.** Change entries of a `data` migration carry `{"kind": "system", "migration": {"id": 12, "name": "user-individuals"}}`: Contracts 3.1's "cause `system` naming the migration". The key is optional, so earlier `system` causes decode unchanged.
- **Failures.** A batch's typed failure becomes `DataMigrationFailed` (its message names the migration and the refusal); the row stays `running`.
- **Server start (Contracts 1.9).** `checkPlatformMigrations` refuses a pending migration of any kind and a `running` `data` migration: `MigrationStateRefused` gains `incomplete`, and its message names the migration (`incomplete data migration 12 (user-individuals) (std upgrade was interrupted; rerun std upgrade)`), which `std serve` prints.
- **`doctor` check 1 (Contracts 1.10).** A `running` row is the error `dataMigrationIncomplete`, naming the migration and its progress.
- **Plan and report.** A planned migration has `state` `pending` or `running` (resumed); the report lists what each `data` migration changed in how many batches.
- **Two migrations, not one.** The ledger columns must exist before a `data` migration can record its state, and a `data` migration runs after the sets while `tx` migrations run before them, so the column change is its own `tx` migration (0011) and the backfill is 0012.

### Migration 0012: `user-individuals`

Each batch selects the next users by ID whose `individual` is empty and calls `ensureUserIndividual` for each, as the system user. On a fresh install it gives the system user its individual (it is inserted by the change set that creates `core.user`, outside the pipeline); on an upgraded install, every user. Users created while it runs already have one and are never selected, so concurrent creation (`std bootstrap-admin`, seeds, an in-process `ensureUser`) cannot get a second.

## Release compatibility

`PREVIOUS_RELEASE` moves to `v0.0.2`, as the Step 3 gate requires (`v0.0.2`'s quickstart, unchanged, against this branch). Extracting and installing the previous release moved from `release-compat.ts` into `examples/quickstart/src/release.ts`, unchanged, so the `party-foundation` upgrade test reuses it rather than building a second `v0.0.2` database some other way. `pnpm release-compat:ci` behaves as before (its quickstart runs, strace and CI wiring are untouched); its upgrade path now also runs the backfill (4 users on the upgraded database).

## Tests

| Test | Proves |
| --- | --- |
| `packages/server/test/party-foundation.test.ts` | new users through the generic API, `ensureUser` and a local child class each get one individual in their own operation; the reference is read-only, unique and keeps its individual; 24 concurrent creates; the derived individual name; the in-process backfill (250 users without individuals, batches of 7) while 30 users are created, with change entries naming the migration, and a rerun that writes nothing |
| `examples/quickstart/test/party-foundation-upgrade.test.ts` | `v0.0.2`'s own `std upgrade`, `std bootstrap-admin` and `std serve` make 1,000 users; this branch's `std upgrade` is stopped (SIGSTOP) once a batch committed, users are created by concurrent `std bootstrap-admin` runs, then it is killed (SIGKILL); the committed batches and nothing else are done, `std serve` refuses naming the migration, `std doctor` exits 1; the rerun completes it while more users are created, `doctor` exits 0, every user has exactly one individual, 2,000 change entries name the migration, and a second rerun writes nothing |
| `packages/server/test/data-migration-interrupted.test.ts` | a `std upgrade` killed while the second batch waits for a row lock leaves the row `running` with the first batch's progress; `std serve` refuses and names it; `doctor` exits 1 with one `dataMigrationIncomplete` naming it and its progress; a rerun completes it (`resumed`) and `doctor` exits 0; a second rerun writes nothing |
