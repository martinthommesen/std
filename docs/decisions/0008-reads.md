# 0008. Reads: access decisions, the read compiler, sessions and the HTTP API

Status: accepted, 2026-10-21 (workstream 0C, read side). Code: `packages/access`, `packages/api`, `packages/server/src/{auth,records,http}`, `packages/server/src/platform/migrations/0003-sessions.ts`, `packages/server/src/config/instance-settings.ts`, `packages/testing/src/{acme-fixture,owner-records,http-client}.ts`. Contracts 2.3, 3, 5.9, 5.10, 6.1 to 6.6.

## Modules

| Module | What it provides |
| --- | --- |
| `@std/access/decision` | `Decision` (`never`, `always`, `conditional` with a condition AST), `combine` (the 3.2 rule: `(OR allows) AND NOT (OR denies)`), `decisionKey`, `both` |
| `@std/access/rules` | `Caller` (role IDs), `recordRules`, `fieldRules`, `recordDecision`, `fieldDecision`, `knowsTable` |
| `@std/access/visible-schema` | `groupClasses`, `recordGroups`, `fieldGroups`, `readabilityOf`, `visibleSchema(snapshot, caller, classId, { exact? })`, `SYSTEM_FIELD_NAMES` |
| `@std/api/api` | `StdApi` (`/api/v1`): groups `signIn`, `session`, `records`; `SCHEMA_REVISION_HEADER` |
| `@std/api/{auth,session,records,authentication,session-token,request-decoding}` | endpoint definitions, record JSON schemas, the bearer `Authentication` middleware, `SessionToken` |
| `@std/api/errors/*` | one tagged error per file: `UnknownTable` 404, `UnknownField` 400, `NotFound` 404, `Unauthenticated` 401, `InvalidCredentials` 401, `InvalidRequest` 400, `InvalidCursor` 400, `InvalidFilter` 400, `InvalidSchemaRevision` 400, `SchemaChanged` 409; `errors/schemas` (filter issues, schema changes) |
| `server/auth/actor` | `Actor` service (`userId`, `roleIds`), `Actor.forUser`, `effectiveRoles`, `loadActor`, `readUserRoles` |
| `server/auth/password` | `hashPassword`, `verifyPassword` (scrypt, PHC string) |
| `server/auth/sessions` | `signIn`, `authenticate`, `signOut`, `SESSION_LIFETIME` |
| `server/auth/session-revocation` | `installSessionRevocation`, `sessionEndTrigger`: the `core.user` trigger that ends sessions on deactivation |
| `server/auth/dev-password` | `setPasswordForDevelopment` (table owner; fixtures and demo only) |
| `server/auth/user-table` | where `core.user` and `core.user_role` live, by well-known field IDs |
| `server/records/relation` | `recordRelation(snapshot, classId)`: one row per logical record with every column by name |
| `server/records/access-sql` | `AccessContext`, `decisionSql`, `groupsSql`, `branchesSql`, `classIn`, `recordPredicate`, `fieldPredicate` |
| `server/records/read-view` | `ReadScope`, `ReadView`, `makeReadScope`: visibility, membership, branches, masks and outputs over any alias |
| `server/records/read-field` | `ReadField`, system fields with synthetic IDs, `fieldInfoOf` |
| `server/records/read-query` | `parseLimit`, `parseFlag`, `parseSort`, `parseFields`, `defaultSelection`, `filterClassView`, `compileFilter`, `BASE_ALIAS` |
| `server/records/read-cursor` | `keyExpression`, `orderBy`, `cursorPredicate`, `encodeCursor`, `decodeCursor`, `sortSignature` |
| `server/records/read-records` | `listRecords`, `getRecord`, `currentReadScope`, `resolveTable`, `ListRequest`, `ListResult`, `GetRequest` |
| `server/records/record-json` | `encodeTextValue`, `recordJson`, `RecordParts`: the record JSON output encoder |
| `server/records/sql-run` | `readRows` (marked `readOnly`), `writeRows`, `TextRowSchema` |
| `server/http/app` | `ApiHandlers`, `ApiRoutes`, `HttpAppLayer` |
| `server/http/handlers` | `SignInHandlers`, `SessionHandlers`, `RecordHandlers` |
| `server/http/request-scope` | `inRequestTransaction`, `asActor`, `jsonResponse` |
| `server/http/schema-revision-header` | `SchemaRevisionHeaderLayer` (global middleware), `recordServedRevision`, `revisionHeaderValue` |
| `server/http/stale-request` | `parseRequestRevision`, `checkRequestRevision` |
| `server/http/stale-scope` | `definitionsAt`, `staleScope`: a read's fields resolved at the request's revision |
| `server/http/request-decoding` | `RequestDecodingLayer`: decoding failures as `InvalidRequest` |
| `server/records/read-tuning` | `withBranchTuning`: planner settings around branch-form page queries |
| `server/http/authentication` | `AuthenticationLayer` |
| `server/http/serve` | `ServerLayer` (`std serve`) |
| `server/config/instance-settings` | `InstanceSettings` (`STD_TIME_ZONE`, default `UTC`) |
| `@std/testing/acme-fixture` | `AcmeFixture` (Alice, Bob, deactivated Carol; L, M, S, AM, K), `acmeTestLayer`, `insertUserAsOwner`, `ACME_SET_DIRECTORY` |
| `@std/testing/owner-records` | `insertAsOwner`: direct SQL inserts, root first (temporary, see below) |
| `@std/testing/http-client` | `TestHttpClient`: the real `HttpAppLayer` as a web handler; `request`, `get`, `signIn` |

## APIs for the writes workstream

- **Access predicates.** `recordDecision(snapshot, caller, action, classId)` and `fieldDecision(snapshot, caller, "create" | "update", classId, fieldId)` give condition ASTs; `recordPredicate` and `fieldPredicate` (`records/access-sql`) give the grouped decisions and the SQL predicate over a relation alias, for any action. Access-rule conditions read bare columns ("as system"); resolve them with `AccessContext` (`now`, the instance zone, `me`).
- **Compiled read SQL.** `makeReadScope(snapshot, actor, context).view(classId)` is the endpoint's `ReadView`: `visibility(alias)`, `readable(alias, field)`, `value(alias, field)` (masked), `output(alias, field)`. The existing-state check and the proposed-state re-read (3.9) use `recordRelation(snapshot, classId)` and these predicates, so reads and writes share one evaluator. `currentReadScope()` builds the scope inside a request transaction from `Actor`, `Catalog`, `InstanceSettings` and the clock.
- **Record JSON.** `recordJson(parts)` and `encodeTextValue(type, text)`; select values `::text` (password and secret as `col IS NOT NULL`). The response after a write projects with the endpoint class's view (`getRecord` does this for one ID).
- **Actor.** `Actor` is required by `listRecords` and `getRecord`; HTTP handlers get it from `asActor` inside `inRequestTransaction`. Tests and scripts use `Actor.forUser(userId)`.
- **Router.** Add write endpoints to `RecordsGroup` in `@std/api/records` and handlers to `RecordHandlers` (or a new group layer merged into `ApiHandlers`). Wrap each handler in `inRequestTransaction(transactions, request, asActor(...))`; that records the served revision for the header and maps `DatabaseError` to a 500 with an empty body.

## Decisions

### Access (`@std/access`, plain)

- A rule applies when it is active, names a role the caller holds, includes the action, and is attached to the concrete class, an ancestor or `*`. Field `*` on class T covers fields of T and its ancestors, never a descendant's; `*` on every class covers every field. Conditions keep rule ID order, so equal rule sets give equal keys.
- `never`: no allow, or an unconditional deny. `always`: an unconditional allow and no deny. Otherwise the condition, simplified (an unconditional allow drops the allow part; no denies drop the `not`).
- A stored condition that does not decode never grants (allow becomes `false`) and always refuses (deny becomes unconditional). The server compiles a condition that no longer checks against the snapshot to `FALSE`. Both fail closed. [judgment]
- Rows: classes of subtree(E) are grouped by equal record decision; never-classes are left out. Fields at E: readability is computed over the row-visible classes only (a class whose records the caller cannot see contributes nothing). `exact: true` considers one concrete class (for history).
- `knowsTable`: some allow (any action, records or fields) on `*`, E, an ancestor or a descendant of E. Otherwise `UnknownTable`, identical to a nonexistent table.
- The read field decision does not repeat the record decision: every read applies row visibility first. Writes check both.

### SQL shapes

The relation of a class (alias `r` for the endpoint, `s<n>` for joined targets in the selection, `f<n>` for filter hops):

```sql
(SELECT "t0"."id", "t0"."class_id", "t0"."version", "t0"."created_at", ..., "t0"."name", ...,
        "t1"."serial", ..., "d0"."size_inches"
   FROM "acme"."asset" AS "t0"
   JOIN "acme"."laptop" AS "t1" ON "t1"."id" = "t0"."id"            -- E and its ancestors: inner
   LEFT JOIN "acme"."monitor" AS "d0" ON "d0"."id" = "t0"."id")     -- descendants: left
```

A list page, plain form:

```sql
SELECT "r"."id"::text AS "id", "r"."class_id"::text AS "class_id", "r"."version"::text AS "version",
       CAST("r"."name" AS text) AS "v0",
       CAST((CASE WHEN ("r"."class_id" = ANY($1::uuid[]) AND ("r"."cost" <= $2::numeric OR "r"."cost" IS NULL))
                  THEN "r"."docked_to" END) AS text) AS "v1",
       CAST(COALESCE(<same mask>, false) AS text) AS "w1",
       CAST("s0"."name" AS text) AS "l1",
       CAST(<sort key> AS text) AS "k0"
  FROM <relation(E)> AS "r"
  LEFT JOIN <relation(T)> AS "f1" ON "f1"."id" = <masked reference> AND (<T's visibility over f1>)
  LEFT JOIN <relation(T)> AS "s0" ON "s0"."id" = <masked reference> AND <T's visibility over s0>
 WHERE ("r"."class_id" = ANY($subtree) AND (("r"."class_id" = ANY($g1) AND p1) OR ...))
   AND <filter over masked expressions> AND <cursor>
 ORDER BY <k0> ASC NULLS LAST, ..., "r"."id" ASC
 LIMIT <limit + 1>
```

- Always-readable fields and system fields are bare columns; conditional ones `CASE WHEN <mask> THEN col END` plus a `w<n>` flag; a `false` flag leaves the key out and lists it in `withheld`. Password and secret select `col IS NOT NULL` under the mask, never the column.
- `class` is a `CASE class_id WHEN ... THEN '<qualified name>' END` over subtree(E), as a case-sensitive text field: filters `class = "acme.laptop"` and `class in (...)` and sorts work on it.
- Every value is selected `::text` and decoded by field type (`record-json`), so a row is always `Record<string, string | null>`.
- Labels: the target's display field (the nearest one on its lineage; never a password or secret, which `@std/definitions` refuses as a display field and the compiler skips), masked by the target's rules, over a join whose condition is the masked reference and the target's visibility. A label is present only when the reference is readable, the target visible and the display field readable on it.
- One-hop paths in `fields` use the same join; a path's value is null when the reference is empty or the target or field is hidden (like a label, it does not tell those apart; a `p<n>` column carries that presence, so a hidden password path is null, not `{"set": false}`), and absent only when the reference itself is withheld.
- `class` of a target class the caller has no allow on is a typed `CAST(NULL AS text)`.
- Counts: `SELECT count(*)::text FROM <relation(E)> AS "r" <filter joins> WHERE <visibility> AND <filter>` (no cursor), only with `count=true`.
- Get by ID: one statement over `relation(E)` with `"r"."id" = $id` and E's visibility, the same projection as a list (E's lineage fields only, Contracts 2.3). An ID that is not a UUID, does not exist, is outside subtree(E) or is not visible gives the same `NotFound` body.
- Sort keys: masked expressions; text and long text by `casefold(e COLLATE pg_unicode_fast) COLLATE pg_unicode_fast` (case-sensitive text and choice: `e COLLATE pg_unicode_fast`), so text sorts by code point of the comparison key, independent of the database's default collation. Password, secret, json and condition fields cannot be sorted (`InvalidRequest`). [judgment]

### Branch form (storage benchmark)

When the caller's visibility has more than one top-level disjunct (several class groups, or several allow conditions in a group), a page is:

```sql
SELECT "u"."id", ..., "u"."k0" FROM (
  (SELECT <columns>, <key> AS "o0", "r"."id" AS "oid" FROM <relation(E)> AS "r" <joins>
    WHERE <membership> AND <b1> AND <filter> AND <cursor> ORDER BY <keys>, "r"."id" LIMIT n)
  UNION ALL
  (SELECT ... WHERE <membership> AND <b2> AND NOT COALESCE((<b1>), false) AND <filter> AND <cursor> ...)
) AS "u" ORDER BY "u"."o0" ASC NULLS LAST, ..., "u"."oid" ASC LIMIT n
```

The branch-form page query runs inside `withBranchTuning`: `SET LOCAL max_parallel_workers_per_gather = 0` and `SET LOCAL plan_cache_mode = force_custom_plan` (decision 0002, "Read tuning"), sent unprepared (`readOnly(..., { unprepared: true })`), then both settings are set back to the values read before, so counts and later statements run with the defaults. A branch is a group's membership and one allow disjunct with the group's denies; `NOT` is applied only to `COALESCE(..., false)`, which is never NULL (5.9). Counts keep the plain form. `branch-form.test.ts` compares both forms page for page through keyset cursors over generated filters, sorts, page sizes and endpoints, for a caller with three branches. `ListRequest.form = "plain"` forces the plain form.

### Filters, names and errors

- `filter` uses the condition text syntax (`@std/conditions/syntax-parse`), names resolved through `filterClassView`: the visible schema of the endpoint, then of each reference's target, plus system fields. The parser records each name it cannot resolve, so `UnknownField` names what the request said; a never-readable field and a misspelled one give identical responses apart from that name. Other parse and check issues are `InvalidFilter` with positions, never values.
- Filters are checked under the filter profile (`purpose: "evaluate"`), resolved with the instance zone until users have a zone preference, and compiled with masked column hooks and target guards.
- `sort`, `fields`, `limit` (1 to 1000, default 100), `count` and `labels` are parsed by the server; malformed values are `InvalidRequest` naming the parameter.

### Cursor format

`base64url(JSON {"i": <last id>, "k": [<key text or null>...], "s": ["<field id>" | "-<field id>"...]})`. Key texts are the `::text` of the masked key expressions, so a cursor carries nothing the caller could not read. A cursor whose signature differs from the request's sort, or whose values do not parse for their field types, is `InvalidCursor` before any query. The predicate is the expanded null-aware form over the same key expressions as `ORDER BY`:

| Key | after (v stored) | after (v empty) | equal |
| --- | --- | --- | --- |
| ascending, `NULLS LAST` | `k > $v OR k IS NULL` | `FALSE` | `k = $v` / `k IS NULL` |
| descending, `NULLS FIRST` | `k < $v` | `k IS NOT NULL` | `k = $v` / `k IS NULL` |

`(after1) OR (eq1 AND after2) OR ... OR (eq1 AND ... AND eqn AND "r"."id" > $id)`; no row comparison.

### Sessions

- `POST /api/v1/auth/sign-in` `{login, password}`: the login is compared by `casefold(login COLLATE pg_unicode_fast)` (the unique index's key). An unknown login still runs one scrypt derivation against a dummy hash. Unknown login, wrong password and deactivated user give the same `401 InvalidCredentials`.
- Passwords: `$scrypt$ln=15,r=8,p=1$<salt>$<hash>` (16-byte salt, 32-byte key, unpadded base64), compared with `timingSafeEqual`. The parameters travel with the hash. [judgment]
- Deactivation ends sessions in the same transaction: the change set that creates `core.user` attaches `core.end_user_sessions()` (migration 0003) as `AFTER UPDATE ... WHEN (OLD.active AND NOT NEW.active)`. A trigger rather than a save-pipeline hook [judgment]: users are also deactivated by tooling, imports and by hand, and no path may leave a session behind. Reactivation does not revive a session; the user signs in again.
- Tokens: 32 random bytes, unpadded base64url (43 characters), returned once. `core.session` (migration 0003) stores `sha256(token)` as `bytea`, the user, `created_at` and `expires_at` (12 hours [judgment]). It has no `id`, so it is internal and not described by the core set.
- `Authorization: Bearer <token>`: the middleware only refuses a missing token; the handler checks the token inside its request transaction (`authenticate` joins `core.user` and requires `active`), so the session, roles and records are read at one revision. `POST /api/v1/auth/sign-out` deletes the presented session.
- Effective roles: `authenticated` plus `core.user_role` rows naming a live role; none for an inactive user. No code checks a role name.

### HTTP

- One request transaction per request (`inRequestTransaction`); its revision is recorded per request and written as `STD-Schema-Revision: <n>.<change_set_id>` by a global router middleware just before the response is sent. Responses no transaction served (no token, unknown route, undecodable payload) get the current revision from a separate `begin_request()`.
- Record bodies are written with `stringifyJson` (raw `HttpServerResponse`), so json values keep jsonb's key order; the `HttpApi` schemas describe the same shape for clients.
- Typed errors carry their status (`httpApiStatus`); `DatabaseError` becomes a defect, which the HTTP layer answers with an empty 500. Raw Postgres text is never in a response.
- Request decoding: the `RequestDecoding` middleware on every endpoint turns path, query, header and body decoding failures (malformed JSON included) into `400 InvalidRequest` with the part's name and a fixed message, never the decoder's text.
- Stale requests (6.4, reads): the request's scope is resolved at R from `core.definition_revision` (`stale-scope.ts`): filter paths through the condition parser, sort and selection names, the default selection when `fields` is absent, one-hop target fields and labels' display fields. Changes in (R, C] to those fields, to their overrides on the classes they are read on, to those classes, and fields added under a name the request used are relevant; `changes` lists only fields the caller can name at C.

## Deviations and open items

- Q7 (a filter through a reference, restricted caller) is a known gap of the storage benchmark.
- **Fixture inserts.** The acme fixture now creates users, role assignments and records through the save pipeline (decision 0009). `@std/testing/owner-records` remains only for the bulk data of `cursor-nulls` and `branch-form` (thousands of rows, inserted as table owner).
- A filter that does not parse at R contributes the names the parser saw before it stopped.

## Review round 1

- Deactivation deletes the user's sessions through a trigger (above); `endSessionsOf` is gone.
- Stale checks resolve the request at R, include reference targets, default selections and label display fields.
- `RequestDecoding` maps decoding failures to `InvalidRequest` on every endpoint.
- Password and secret display fields are refused by `@std/definitions` validation (`invalidDisplayField`) and skipped by the compiler; hidden password paths are null; `class` of an unknown target is a typed null.
- Branch-form pages run with the read-tuning settings, unprepared, restored afterwards.
- Filters use the instance time zone; the user preference arrives with user settings.
- Read statements return every value as text, one string per column; a list of 100 rows with 20 fields decodes 2,000 strings. Not measured yet.

## Where the writes workstream meets these APIs (decision 0009)

- `records/write-access-rules.ts` (`RuleWriteAccess`) builds on `makeReadScope`, `recordRelation`, `recordPredicate` and `fieldPredicate`: one evaluator for reads, existing-state and proposed-state checks. The projection after a write is `getRecord` through the endpoint.
- The write and history routes live in the `records` group (`create`, `update`, `remove`, `history`) and use `inRequestTransaction` and `asActor`; their stale check passes the body's field names as `fields` to `stale-scope.ts`.
