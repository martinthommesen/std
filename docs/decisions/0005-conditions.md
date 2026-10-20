# 0005 Conditions: one AST, two evaluators, one SQL compiler

Status: accepted, 2026-10-20. Workstreams 0D and 1D (conditions half). Contracts 2.3, 3.4 to 3.6, 4.1, 5, 6.5.

## Modules (`@std/conditions/<module>`)

| Module | What it holds |
| --- | --- |
| `ast` | The AST of Contracts 5.2 as TypeScript types, `ExprSchema` for its JSON form, `decodeExpr` (strict: unknown keys are refused), category guards |
| `class-view` | `ClassView` and `FieldInfo`, the only way the engine learns about classes; `staticClassView` for tests and simple callers |
| `profile` | The profile table of Contracts 5.10 (`profileRules`) and the operator/type table of 5.4 (`OPERATOR_KINDS`) |
| `issue` | `InvalidCondition` (a `Schema.TaggedError`) listing `ConditionIssue`s with an AST path, a reason, an optional hint and, from the parser, a span |
| `defect` | `ConditionDefectError`, thrown when a caller breaks the contract (a missing field on a complete image, an unresolved context value) |
| `check` | `checkCondition`, `checkConditionJson`: the checker, returning a `CheckedCondition` |
| `resolve` | `resolveCondition`: context values, relative dates and periods to literals (Temporal); `timeZoneFor` |
| `nnf` | Negation normal form |
| `evaluate` | The server's two-valued evaluator over complete images |
| `browser` | The browser's three-valued evaluator over partial records |
| `simplify` | `simplifyForCaller` (empty for never-readable fields, constant folding) and `foldConstants` |
| `sql-fragment` | `SqlFragment` (text parts around typed text parameters), `sql`, `identSql`, `quoteIdent`, `renderSql` |
| `sql` | The SQL compiler: `compileCondition`, `compileNegatedCondition`, `asBooleanValue` |
| `syntax-lexer`, `syntax-parse`, `syntax-print` | The text syntax: `parseCondition`, `locateIssues`, `printCondition` |
| `typed`, `evaluate-core` | Internal trees and the shared evaluation core |

## Pipeline

`Expr` (stored JSON) → `checkCondition(expr, { view, classId, profile, purpose })` → `CheckedCondition` → `resolveCondition(checked, context)` → `ResolvedCondition` → `evaluateCondition`, `evaluateInBrowser` or `compileCondition`.

- **Check once, resolve per evaluation.** The checker converts literals (`@std/values/literal`), resolves every path to its `FieldInfo`s and writes `ne`, `notIn`, `notContains`, `notEmpty` as `not` of their positive forms, exactly as Contracts 5.2 defines them. The server checks stored conditions with `purpose: "evaluate"` when it loads a snapshot (retired fields keep working) and with `purpose: "store"` when a condition is written (retired fields are refused).
- **Every issue is reported**, each with its AST path (`["args", 0, "right", "value"]`). Messages never contain literal values.
- **The view decides what can be named.** `ClassView.field(classId, fieldId)` returns fields of the class and its ancestors only (Contracts 2.3: child-only fields are unknown through a parent endpoint; 5.9: paths name fields of the declared target class and its ancestors). `canRead`, when present, is the caller's visible schema (filter profile); an unreadable field gives the same `unknownField` issue as a missing one (Contracts 3.4).

## Decisions

- **Context per type.** `me` and `myGroups` fit reference and uuid fields; `now` and `rel: "now"` fit date-time fields only; `rel: "today"` fits date fields (a date) and date-time fields (the instant the day starts). A date field compared with `now` is refused with a hint to use `today`, because a date never compares with a date-time (Contracts 5.7). [judgment]
- **`myGroups` in `in` and `notIn`.** `notIn` is exactly `not in` (Contracts 5.2), so `notIn(f, myGroups)` is allowed too; anywhere else `myGroups` is refused (`myGroupsOnlyInIn` from the parser; the JSON schema has no other place for it). `in` lists may mix literals with `me` and relative dates.
- **Offsets** of relative dates and periods are limited to ±100,000 units. A resolved bound outside years 0001 to 9999 turns its atom into the constant it denotes for in-range data: `f < (after 9999)` becomes `notEmpty(f)`, `f > (after 9999)` and `f = (after 9999)` become false, and out-of-range `in` elements are dropped. So a stored `today + 9000 years` never fails at evaluation time. [judgment]
- **Form-rule hops.** The form preloads one hop, so form rules allow one; the checker's `isPreloaded` option narrows it to the paths a form actually preloads. Access rules take `accessRuleHops: 0 | 1` (Step 1 and Step 3), filters and access rules take `myGroups: true` from Step 3.
- **`changed`** is refused for password and secret (only `empty` and `notEmpty`, Contracts 6.5) and on a `previous` path. Its argument may follow references: `changed(owner.name)` compares the name of the previous owner with the name of the proposed one.
- **Images.** A record image is `{ [fieldId]: StoredValue | Plaintext | null }`. `previous: null` means create (every previous value empty, so `changed(f)` is `notEmpty(f)`); on delete the caller passes `previous: record`, so `changed` is false. Reference targets come preloaded in `targets: Map<id, image | null>`; `null` is a target the caller cannot see, which behaves like an empty reference (Contracts 3.6). On the server a missing field, a missing target or an unresolved context value throws `ConditionDefectError`.
- **Browser.** Unknown for: a field missing from the partial record, a target not delivered, a context value not provided, proposed text holding code points unassigned in Unicode 16.0.0, and proposed text the server would refuse. Proposed text (the record's own text fields) goes through write-conversion steps 1 to 4 first. Kleene connectives; `in(f, [v, unavailable])` is true when `f ≡ v`, and comparisons with an empty left side are false whatever the unavailable right side holds, since every atom is total.
- **Simplifier.** `simplifyForCaller(expr, { isHidden, view, classId })` substitutes empty for every never-readable field (a path is empty when any field on it is hidden), using the table in `simplify.ts`; `eq(f, g)` with one empty side becomes `empty(g)`, or false when `g` is a boolean (never empty). Then it folds constants. A property test checks that the result evaluates like the original on records where hidden fields are empty, and names no hidden field.
- **SQL output** is a fragment, not Effect SQL: `{ parts, parameters }` where each parameter is text (or an array of text) with its cast. `renderSql(fragment, first)` numbers placeholders `$first..` and renders casts (`$3::numeric`, `$4::uuid[]`); casts must be plain type names. Literals are cast to their left field's kind (`parameterCast`), decimals to unconstrained `numeric`. The compiler never emits SQL `NOT`; `NOT LIKE` appears only inside the negated pattern form, guarded by `OR f IS NULL`.
- **`changed` in SQL.** Not in the table of Contracts 5.9 because form and record rules run in TypeScript, but the compiler accepts `previousAlias` and emits `p(f) IS DISTINCT FROM f` (negated `IS NOT DISTINCT FROM`). It exists so the differential test holds every profile, `previous` and `changed` included, to Postgres. Exact stored equality matches Postgres here: deterministic text equality is bytewise, numeric equality ignores scale as `storedEquals` does, jsonb equality is `jsonbEquals`. [judgment]
- **Text syntax** is described below; `parse(print(a)) = a` holds for every checked condition, because junctions with fewer than two arguments print as `all(...)` and `any(...)` and nested junctions are parenthesized.

## How the server calls the SQL compiler

```ts
const compiled = compileCondition(resolved, {
  alias: "r",                // the base record's alias in the query
  previousAlias: "p",        // only for conditions using previous/changed
  joinAliasPrefix: "c",      // join aliases c1, c2, ...; pick a prefix unique in the statement
  hooks: {
    column: (source, field) => /* SqlFragment */,
    join: (target) => ({ relation, guard }),
  },
});
// FROM <base> AS "r" <other joins> ${compiled.joins} WHERE ${compiled.predicate}
// select list: ${asBooleanValue(compiled.predicate)}
const { text, values } = renderSql(statementFragment, firstPlaceholder);
// sql.unsafe(text, values) in the SQL layer
```

- **`column(source, field)`** must return the expression for `field` on the record behind `source`, qualified by `source.alias`. For the base record (`source.prefix` is `[]`, `source.image` is `"current"`) the record compiler returns the masked expression for conditional fields, `CASE WHEN <predicate> THEN "r"."col" END`, and the bare column for always-readable fields (Contracts 3.5: every reference to a conditional field uses its masked expression, so a hidden value behaves like empty). With class-table storage it picks the level table that holds the field (`field.classId`). For joined targets (`source.prefix` non-empty) it returns the target's masked expression over `source.alias`. It is also called for the reference field itself when joining (`via`), so the reference's own mask applies first (3.6).
- **`join(target)`** returns the relation to `LEFT JOIN` for one reference prefix and an optional guard over `target.source.alias`. The relation must expose `id` and the columns `column` will name: a table when all target fields live in one level table, otherwise a parenthesized subquery joining the target class's level rows. The guard is the target's visibility predicate for the caller (3.6). The compiler emits `LEFT JOIN relation AS "c1" ON "c1"."id" = column(via, reference) AND (guard)`, one per distinct `(image, prefix)`, parents first; a rejected target joins no row, so its fields read NULL, like an empty reference.
- **Fragments compose.** Guards and masked expressions may carry their own parameters (`sql` template with `textParameter`); `renderSql` numbers everything once. Identifiers come only from the hooks (quote them with `identSql` / `quoteIdent`) and from the compiler's own quoted aliases.
- **WHERE vs values.** Put `predicate` into `WHERE` as is; in a select list, `CASE` or argument use `asBooleanValue(predicate)` (`COALESCE(e, false)`). For a proposed-state check (3.9) the same compiled predicate runs after the writes.
- **Time zone.** Put `timeZoneFor(profile, { instance, user })` into the context: the filter profile uses the user's zone (falling back to the instance zone), every other profile the instance zone.

## Text syntax

```
condition   = disjunction
disjunction = conjunction { "or" conjunction }
conjunction = negation { "and" negation }
negation    = "not" negation | primary
primary     = "(" disjunction ")" | "true" | "false"
            | ("all" | "any") "(" [ disjunction { "," disjunction } ] ")"
            | "changed" "(" path ")"
            | predicate
predicate   = path compare ( value | path )
            | path "in" ( list | "myGroups" | period )
            | path "not" "in" ( list | "myGroups" )
            | path "is" [ "not" ] "empty"
            | path [ "not" ] "contains" string
            | path "starts" "with" string
            | path "ends" "with" string
compare     = "=" | "!=" | "<" | "<=" | ">" | ">="
path        = [ "previous" "." ] name { "." name }
name        = word | "`" characters "`"
list        = "(" [ value { "," value } ] ")"
value       = string | [ "-" ] number | "true" | "false" | "me"
            | "now" [ ( "+" | "-" ) integer nowUnit ]
            | "today" [ ( "+" | "-" ) integer todayUnit ]
period      = ( "this" | "last" | "next" ) periodUnit
            | periodUnit [ "+" | "-" ] integer
nowUnit     = minute[s] | hour[s] | day[s] | week[s] | month[s] | year[s]
todayUnit   = day[s] | week[s] | month[s] | year[s]
periodUnit  = day | week | month | quarter | year
```

- Examples: `cost > 0 and status = "lost"`, `docked.name = "X"`, `owner = me`, `due < today - 7 days`, `opened in this week`, `opened in quarter -2`, `name contains "a"`, `assignee is empty`, `status in ("a", "b")`, `owner not in myGroups`, `not (a = 1 or b = 2)`, `previous.status != status`, `changed(status)`, `all()`.
- `and` binds tighter than `or`; `not` applies to the following negation. `a and b and c` is one `and` with three arguments; parentheses keep nesting (`(a and b) and c` is two).
- Words are `[A-Za-z_][A-Za-z0-9_]*`. Reserved words (`all and any changed contains empty ends false in is me myGroups not now or previous starts today true with`) and any other name are written in backticks: `` `in` = 1 ``. Strings use double quotes; both quote kinds take the escapes `\"`, `` \` ``, `\\`, `\n`, `\r`, `\t`, `\uXXXX` and `\u{X..}`. The printer escapes control characters, U+2028, U+2029 and lone surrogates as `\u{..}`.
- Literals become the left field's canonical JSON: numbers are digit text (`-12.50`) and stay text for big integer and decimal (they never pass through a JS `number`; integers are checked with `convertNumberText` first); booleans are `true`/`false`; every other type is a string. `now` alone is the context value; `now + 0 minutes` is `rel: "now"`. `today` is `rel: "today", unit: "day", offset: 0`.
- Names resolve through `resolveName(classId, name)` on the condition's class, then on each reference's target class. A name that does not resolve gives `unknownField` with its span; following a non-reference gives `notAReference`. The parser checks syntax and names only and never throws; `checkCondition` checks the rest, and `locateIssues(issues, spans)` gives its issues positions in the text.

## Verified facts (Postgres 18.6)

- [spike] Literal equality on a unique case-insensitive field, `casefold(("r"."name") COLLATE pg_unicode_fast) = $1::text` with a bound parameter, uses the expression index `ON t (casefold(name COLLATE pg_unicode_fast))`; EXPLAIN shows no sequential scan on 20,000 rows (`sql-postgres.test.ts`).
- Comparing a case-insensitive key with a case-sensitive column, `casefold(a COLLATE pg_unicode_fast) IS NOT DISTINCT FROM b`, raises no collation conflict: the explicit collation wins.
- `= ANY($1::text[])` and `<> ALL(...)` with arrays bound through `@effect/sql-pg` `unsafe(text, values)` work for every cast used (`text`, `int4`, `int8`, `numeric`, `date`, `timestamptz`, `uuid`, `boolean`).
- The differential test (`differential-postgres.test.ts`), default budget, on this machine: 3,159 generated cases, 20,163 checked conditions over the fixture (every condition-capable type, text and long text in both case settings, a child class, a self-referencing target for three-hop paths, masked fields, hidden targets, previous images), 80,627 row comparisons, all 640 permitted (operator, type, profile) combinations covered at least 18 times; no disagreement. A deliberately broken negated `eq` form is found and shrunk to a one-atom case within seconds; that case is kept as `test/fixtures/differential/negated-eq-keeps-empty-rows.json`.
- The fold-table equality for every scalar value and `LIKE` escaping for every ASCII character are tested in `@std/values` (`fold-postgres.test.ts`, `like-postgres.test.ts`) and not repeated here.

## Open items

- Tests use their own database helper (`test/support/postgres.ts`, codecs copied from `@std/values`'s test helper); switch to `@std/testing` when it lands.
- `ClassView` will be implemented by `@std/definitions` over the config snapshot; `FieldInfo.choices` should be filled so choice literals naming no choice are refused.
- The record compiler (0C) supplies the `column` and `join` hooks; the differential test's hooks in `test/support/differential.ts` are a working example of masks, guards and the previous image.
- The web app passes a pinned Temporal polyfill through `resolveCondition(..., { temporal })` where the global is missing.
