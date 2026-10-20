# 0003 Values: field type representation

Status: accepted, 2026-10-20. Workstream 1D (values half). Contracts 4.3, 5.1 to 5.7, 6.5 to 6.7.

## Decisions

- **One package, plain.** `@std/values` imports only `effect/Schema` from Effect and does no I/O. Modules are subpaths (`@std/values/codec`, `@std/values/fold`, ...); there is no index.
- **Field types are flat JSON.** `{ kind: "decimal", precision: 10, scale: 2, min?: "0" }`. Omitted settings take their defaults (text `maxLength` 255, long text 1,000,000, `caseSensitive` false). Big integer and decimal bounds are canonical strings, so a field type can be stored in a definition as is. `FieldTypeSchema` checks ranges and cross-setting rules (scale at most precision, bounds that fit and are in order).
- **Conversions return `Decoded<A>`**, `{ ok: true, value }` or `{ ok: false, error: InvalidValue }`. `InvalidValue` is a `Schema.TaggedError` with a `reason` code and an optional `hint`. Messages never contain the refused value, so errors cannot leak passwords, secrets or hidden values (Contracts 4.3).
- **`decodeIn` takes a `JsonValue`, not `unknown`.** Payloads must be parsed with `parseJson`: duplicate keys and inexact digits cannot be seen once `JSON.parse` has run.
- **Exact numbers in json.** A number literal is accepted when it denotes the same decimal value as the shortest round-trip form of its double (`0.1` yes, `0.1000000000000000055511151231257827` no). Integral values beyond ±(2^53 - 1) are refused even when exact (`1e300`), as the contract says. Also refused: `\u0000` (jsonb refuses it), lone surrogates, a field value nesting deeper than 1,000 (Postgres accepts that depth; `checkJsonValue` enforces it per field value, while `parseJson` gives whole request bodies a budget of 1,064 so the envelope never consumes a field's allowance), more than 1 MiB of canonical UTF-8 text.
- **Encoding dispatches on the field kind only.** `encodeOut` never infers a type from a value's shape (a json value `{"set": true, ...}` comes out whole), and a value of the wrong kind throws a `TypeError` instead of being reinterpreted.
- **jsonb key order needs its own serializer.** jsonb orders keys by UTF-8 byte length, then bytewise; JS objects put integer-like keys first, so `stringifyJson` writes the canonical text and `JSON.stringify` must not be used for json values.
- **Single-line text also refuses U+2028, U+2029 and DEL** (contract text updated): they are a line break and a control character as much as CR, LF and C0/C1.
- **Write-only values.** `decodeIn` wraps password and secret plaintext in `Plaintext`, which prints `<redacted>` in `String`, `JSON.stringify` and `util.inspect`; `reveal()` is the only way to read it. `""` is refused (send null to clear). `storedEquals` counts any new plaintext as a change, since salted hashes cannot be compared.
- **Text equality across fields** keys each side with its own field's case setting, as the SQL `k(f) = k(g)` does.
- **Assigned code points** are DerivedAge.txt minus the 66 noncharacters, whose general category is Cn; this equals Postgres's `unicode_assigned()`.
- **Literals** convert under the type's limits (text 4,000 code points, long text 1,000,000, decimal 100 digits at any scale), and `convertNumberText` reads digit text for the condition text syntax without a JS `number`.
- The package tsconfig sets `types: ["node"]` for tests and the generator; `src/` uses no Node API, and the CI import check guards it.

## Verified facts (Postgres 18.6, @effect/sql-pg 4.0.5)

- `casefold` is IMMUTABLE (`provolatile = 'i'`), so expression indexes work. `unicode_version()` is `16.0`.
- The generated fold table equals `casefold(chr(cp) COLLATE pg_unicode_fast)` for every scalar value except U+0000 and surrogates: exactly 1,557 code points fold to something else, as CaseFolding.txt statuses C and F list. The exhaustive query runs in under a second when it returns only the code points that change.
- [spike] Per-code-point equality implies string equality: "ΣΑΣ" folds to "σασ" in both engines (no final-sigma context), "Straße" to "strasse", "İ" to "i" plus U+0307; 10,000 generated strings (edge pools and arbitrary code points) fold identically. `name = "STRASSE"` matches "Straße"; `"i"` does not match "İ".
- `LIKE` with the default escape `\` treats the escaped `\`, `%` and `_` literally for every ASCII character, also on `casefold(... COLLATE pg_unicode_fast)`, and agrees with the TypeScript evaluator on 36,000 cases.
- jsonb keeps the last of duplicate keys, keeps digits a double cannot hold (`0.1000000000000000055511151231257827::jsonb <> 0.1::jsonb`), and refuses `\u0000`. Its key order and equality equal `jsonbKeys` and `jsonbEquals` on 3,000 generated values.
- @effect/sql-pg 4.0.5 reads the binary format only. Text reads therefore need codecs registered through the `types` option that render each binary value in the type's text form (`test/support/postgres.ts` does this and is checked against `::text`). Its built-in codecs truncate `timestamptz` to a `Date`, use astronomical years for BC dates and run json through `JSON.parse` (contract 5.6 updated). `startupParameters: { TimeZone: "UTC", DateStyle: "ISO" }` sets both session parameters.
- Text-form round-trips hold at int8 limits, ±(2^53 ± 1), 0001-01-01, 9999-12-31 and 2024-02-29, under several process time zones; BC dates, year 10000 and infinities are refused on read.

## Open items

- The root `vitest.config.ts` lists `bench`, which does not exist yet, so the root `pnpm test` fails at startup until the bench workstream lands; `pnpm --filter @std/values test` passes.
- The SQL layer (server workstream) should adopt the text-rendering codecs of `test/support/postgres.ts`, or equivalent, before relying on `@std/values/postgres-text`.
