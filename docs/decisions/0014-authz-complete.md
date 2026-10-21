# 0014. Authorization on every path (Step 1, workstream 1C)

Status: accepted, 2026-10-21 (workstream 1C). Code: `packages/server/src/records/save-pipeline.ts` (platform-table guard), `packages/server/src/auth/sessions.ts` (system user), `packages/server/src/http/{handlers,meta-handlers,record-writes,stale-request,stale-scope,app}.ts`, `packages/api/src/{auth,session,meta,api,client}.ts`, `packages/access/src/rules.ts` and `packages/definitions/src/validate.ts` (platform tables match only core rules), `packages/testing/src/acme-fixture.ts` (Ada, an admin). Contracts 1.8, 1.9, 2.2, 2.3, 3, 4.1, 6.1 to 6.7.

Builds on decisions 0008 (reads) and 0009 (writes). Step 1's gate asks for "the two-user suite from Stage 0, extended to every read and write path, plus fuzzed error responses that never contain Postgres text"; this note records the audit, the gaps it found, and the tests that now hold the line.

## Path audit

Every path resolves the table against the caller's rules first (`resolveTable`, `knowsTable`: `UnknownTable`), and every record decision is SQL over `recordRelation` with the compiled predicates of `access-sql.ts`, so reads, existing-state checks, proposed-state checks and history share one evaluator.

| Path | Where the rules apply | Test |
| --- | --- | --- |
| list, count, cursor pages | `listRecords`: visibility in `WHERE`, masked keys in `ORDER BY` and cursors, counts over the same `FROM`/`WHERE` | `authz-paths` rows 1 to 5, `rows-count`, `cursor-nulls`, `noninterference` |
| get by ID, parent and child endpoints | `getRecord`: visibility and subtree in one statement; outside either is `NotFound` | `authz-paths`, `invisible-404`, `invisible-identity` |
| filters through reference paths, sorts, `fields`, `labels` | names resolve against the visible schema (`UnknownField`); targets joined under their own visibility and masks; audit references labelled through the built-in `core.user` rule | `authz-paths`, `hidden-names`, `masked-filter`, `references`, `users` |
| history and its filters | one statement: the record's visibility and per-field readability over its concrete class, joined to `core.change`; field filters need the field readable on the same row | `authz-paths`, `history`, `history-endpoint`, `write-leaks` |
| create, update, delete, parent and child endpoints | `RuleWriteAccess`: existing state after the root lock, proposed state after the row writes; the platform-table guard | `authz-paths`, `two-user-write`, `write-authorization`, `field-rule-states` |
| nested saves from hooks | the hook saves through the record service with the save's `Actor` and `RuleWriteAccess`; a refusal fails and rolls back the outer save; `RecordInSave` for a record on the save stack | `authz-paths` "a nested save from an after-write hook acts as the acting user" |
| sign-in, sign-out, session use, `auth/me` | sessions checked inside the request transaction; inactive users and the system user never authenticate | `authz-paths`, `sign-in`, `users`, `built-ins` |
| change-set endpoints | not built yet (1A) | marked `1A:` in `authz-paths` and `built-ins` |

`authz-paths` is the table: one row per path with Alice's and Bob's outcome under the twelve rules of 3.3 (42 rows: 27 reads, 15 writes), plus the nested-save test. Read rows change nothing; write rows make their own records, so the rows are independent.

## Gaps found and fixed

1. **Generic writes reached platform tables.** The admin allow-all rule grants create, update and delete on every class, and the save pipeline wrote whatever class the endpoint named. An admin could forge `core.change` entries, edit the journal, or edit and delete protected access rules without a change set, a revision bump or the protection check of 1.8. The save pipeline now refuses every create, update and delete on a class with `storage: platform` with `NotAllowed`, for every caller: on creates after the body's names resolve, on updates and deletes right after visibility and the version check (so a caller who cannot see the record still gets `NotFound`, 3.9). Platform rows come only from migrations, change sets, the coordinator and the pipeline's own change entries. Hook for 1A: generic writes on definition tables become one-operation change sets before they reach this guard (Contracts 1.4); the journal and `core.change` stay refused.
2. **The system user could become an HTTP actor.** It is an ordinary `core.user` row (inactive, no password). An admin could activate it and set a password, and sign-in would then issue a session for it. `signIn` and `authenticate` now never yield `SYSTEM_USER_ID`: its refusals are the same `InvalidCredentials` and `Unauthenticated` as anyone's. This checks a user ID, not a role name.
3. **Auth endpoints ignored `STD-Schema-Revision`.** Sign-in and `auth/me` now give `400 InvalidSchemaRevision` for a malformed header and `409 SchemaChanged` (no changes listed) for a revision this database never had. Sign-out checks only the format: refusing it for staleness would keep a credential alive. [judgment]
4. **Stale scopes of history and deletes.** History now adds its `field` filter's IDs to the stale scope (they are IDs, so renames never matter, but retirement, purge and type changes do), next to the default selection it already used because it shows fields by current name. A delete names no field, so its scope is the table alone; before, it used the default selection and a change to any default field refused it.
5. **No `auth/me`.** `GET /api/v1/auth/me` returns the session's user ID and effective roles (ID, name, label), `authenticated` included.

No gap was found in reads, history access or the write checks themselves; the new tests pin them.

## Built-ins (3.1, 3.2)

- Roles `admin`, `authenticated`, `schema_purger` and permissions `schema.purge`, `schema.snapshot`, `rules.run_as` sit at the stable IDs of `@std/definitions/well-known`, protected and core-owned. The only grant is `schema_purger` to `schema.purge`; admin holds no permission. The five built-in rules match 3.2 exactly (`built-ins`).
- `authenticated` is never assigned (`core.user_role` has no row for it); `effectiveRoles` adds it for every active user and gives an inactive user nothing.
- Permission checks by ID: no code in Step 1 main checks a permission yet. `hasPermission` (by permission ID, through live grants of active roles) arrives with 1A (`@std/definitions/requester`) for `schema.purge`; `schema.snapshot` is Step 4 and `rules.run_as` Step 3. `no-bypass` scans the source for lookups of roles or permissions by name.
- Protection: the protected rules refuse generic edits and deletes from admins (the platform-table guard). The change-set side of 1.8 is 1A's.
- The built-in deny on `core.user` deletes names `authenticated`, which every active user holds, so it refuses every caller who can act ("every role" in 3.2).

## `no-bypass`

The test makes the two allow-all rules inactive as table owner in its own database, commits an unrelated change set so the catalog reloads, and takes fifteen paths as Ada: `UnknownTable` on acme and platform tables, `NotAllowed` on `core.user`, which stays known through the `authenticated` read rule. `auth/me` still lists the `admin` role: it grants nothing by name. A local role named `deputy` with copies of the two rules then sees exactly what Ada saw. A source scan of every package's `src/` finds no quoted built-in role name in code and no `roleByName` or `permissionByName` outside the definition-set resolver, where set files' names become IDs.

## `error-fuzz`

A fuzz hierarchy (`acme.fuzz_item`, child `acme.fuzz_special`: a case-insensitive unique code, a required short name, integer, decimal, date, a self-reference and a reference to `core.user`; the child adds its own unique field) is created by a change set. As table owner the test adds what the service does not know: a CHECK, a NOT NULL on an optional column and a trigger whose error message, detail and hint carry stored values. fast-check (50 runs of 5 to 20 steps) drives creates, updates and deletes through both endpoints and `core.user` as an admin and through `acme.asset` and `acme.laptop` as Alice. Every response has a documented status, no Postgres wording or constraint name, no stored value or ID of a record the request did not name, an empty body on 500, and error bodies with only their documented members. A unique conflict is `ValidationFailed` with `InvalidValue`/`notUnique` on the field and nothing else; `Referenced` is `{"_tag":"Referenced"}`. Each run must reach thirteen distinct outcomes, so the property is not vacuous. Violations the service cannot map (owner-added constraints, triggers) are an empty 500, with the raw text in the server log only.

## `@std/api` for Step 1 (6.1, 6.2)

- Fixed endpoints: `POST /auth/sign-in`, `GET /auth/me`, `POST /auth/sign-out`, the generic record routes, and `GET /api/v1/openapi.json`. Every response carries `STD-Schema-Revision` (`api-client` fetches ten, errors and unknown routes included).
- `@std/api/client`: `makeStdClient({ baseUrl, schemaRevision? })` is `HttpApiClient.make(StdApi, ...)`, sending the revision header when given; `authenticationClient(token?)` is the client side of the `Authentication` middleware. `HttpApiClient.make` needs the client middleware of every group with `requiredForClient`, so a client built before sign-in passes no token. `api-client` runs it against the HTTP app on a Node server at an ephemeral port.
- Type-level test: canaries `tooling/canaries/api-compatible` (client code against `StdApi`, passes) and `api-drift` (the same code against the real groups with sign-in's `login` renamed `username`, fails `tsc`), run by `pnpm test:canaries`.
- OpenAPI: `effect/http-api` 4.0.5 generates OpenAPI 3.1 (`OpenApi.fromApi`); the `meta` group's `openApi` endpoint serves it without a session (round 1). Generic record bodies appear with their fixed envelope; `values` is a JSON record.

## Stale requests on every path (6.4)

`stale-paths` takes list, get, history (with and without its field filter), create, update, delete, sign-in, `auth/me` and sign-out with a malformed header (400 everywhere), a revision the database never had, ahead or with another change set at the same number (409 everywhere but sign-out), the current revision and an older one past a label change (all succeed), and an older one past `status` becoming required (only history, which shows `status`, and creates, for which it became required without a default, are refused).

## Deviations

- The generic write refusal on platform tables is `NotAllowed` (3.8: refused on a visible record), not a new error.
- `auth/me` returns IDs and role names but not the user's name: that is a `core.user` read the client makes through the record routes, under rules.

## Review round 1

- **Platform tables match only core rules (3.2, 3.7).** `@std/access` applies a rule to a platform class only when the rule is in the `core` owner layer, in record and field decisions and in `knowsTable`, so `*` in an app or local rule never reaches definition tables, the journal or `core.change`. `@std/definitions` refuses an app or local rule that names a platform table (`invalidAccessRule`). The decision uses the table's storage and the rule's owner layer, not a role name. `platform-tables` adds a local `allow employee * records read`: Bob then sees every asset, and `core.change` and `core.access_rule` stay `UnknownTable`, identical to a missing table; a local rule naming `core.change` is refused. In `no-bypass`, the local copies of the allow-all rules reach app tables like admin and stop at platform tables.
- **`no-bypass` parses the source.** The scan uses `oxc-parser` (a server dev dependency) instead of text matching: a string literal or template text equal to a built-in role or permission name is a finding anywhere in executable code (comparisons, `switch` cases, `includes`, map lookups, constants), except as a plain object key or in a type; `roleByName` and `permissionByName` calls are findings outside the definition-set resolver. Comments neither hide nor cause findings. A probe source (a role check behind a block comment, a `switch` case, `includes`, a computed lookup, a template, a lookup by name) proves the scan finds each.
- **`error-fuzz` oracle.** A refusal may repeat only what the request sent: stored values of every record, the target included, are checked on errors; only a success may show the saved record's own projection. A synthetic 422 repeating the target's old value proves the oracle rejects it.
- **`error-fuzz` matrix.** Every constraint (unique on the parent and on the child, required, type, length, the owner's CHECK and NOT NULL, the reference precheck, the FK backstop, a referenced delete) × every operation it applies to × both endpoints: 36 cells, each with its intended refusal. For the FK backstop another transaction deletes the target and holds the delete open until the write waits on its row lock (observed in `pg_stat_activity`); Postgres's FK check refuses the write, mapped by constraint name to `InvalidReference` with no Postgres text.
- **OpenAPI checks the stated revision.** The document is now the `meta` group's `openApi` endpoint of `StdApi` (no longer `HttpApiBuilder`'s `openapiPath` route), in a request transaction like every endpoint: a malformed header is 400, a revision the database never had 409, and the response carries the revision it was served at. `stale-paths` includes it.
- **History of a descendant through a parent endpoint.** History shows every readable field of the record's concrete class (2.3), so after the record proved visible its stale check also covers the concrete class's default selection: with laptop `serial` made read-only, stale history of K is `SchemaChanged` through `/acme.asset` as through `/acme.laptop`, while Bob's stale request for the invisible K stays byte-identical to a random ID. A unit test of `staleScope` shows the field filter's IDs entering the scope on their own class.

## Waiting on 1A

- The change-set endpoints and generic writes on definition tables routed to one-operation change sets: their rows in `authz-paths` (marked `1A:`), their stale checks in `stale-paths`, and protected-definition refusals through them in `built-ins`.
- `hasPermission` (by ID) for `schema.purge`, with a test that admin without `schema_purger` is refused a purge.
