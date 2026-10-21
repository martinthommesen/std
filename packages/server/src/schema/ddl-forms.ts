/**
 * The DDL forms the schema engine may generate (Contracts 1.4) and the guard
 * that checks every statement against them before a change set runs any.
 *
 * | Form | 1.4 table row | Runs in |
 * | --- | --- | --- |
 * | `createSchema` | create table (its namespace) | main |
 * | `createTable` | create table, child table and level FK | main |
 * | `createTrigger` | create table (class-change trigger, 2.1) | main |
 * | `createIndex` | create table: plain `CREATE INDEX` on a new or empty table | main |
 * | `addColumn` | add field: no default or a constant default | main |
 * | `addForeignKey` | add reference field: FK `NOT VALID`; valid on a new or empty table | main |
 * | `addCheck` | check constraint (max length): `NOT VALID`; valid on a new or empty table | main |
 * | `addNotNull` | make required: `NOT NULL ... NOT VALID`; valid on an empty table | main |
 * | `replaceSubtreeCheck` | adding a class (2.4): drop and re-add the subtree CHECK `NOT VALID` | main |
 * | `setDefault`, `dropDefault` | set or drop default | main |
 * | `dropColumn` | purge field (workstream 1A) | main |
 * | `dropConstraint` | drop a generated constraint (abandon of a `NOT VALID` constraint, workstream 1A) | main |
 * | `validateConstraint` | `VALIDATE CONSTRAINT` of a `NOT VALID` constraint | follow-up |
 * | `createIndexConcurrently` | index or unique index on a table with rows | follow-up |
 * | `dropIndexConcurrently` | drop index | follow-up |
 *
 * Everything else is refused, in particular a volatile or non-constant
 * default, `ALTER COLUMN ... TYPE` and a direct `SET NOT NULL`.
 */
import type { DdlRefusal } from "./ddl-refused.ts";

/** A generated DDL form. */
export type DdlForm =
  | "createSchema"
  | "createTable"
  | "createTrigger"
  | "createIndex"
  | "addColumn"
  | "addForeignKey"
  | "addCheck"
  | "addNotNull"
  | "replaceSubtreeCheck"
  | "setDefault"
  | "dropDefault"
  | "dropColumn"
  | "dropConstraint"
  | "validateConstraint"
  | "createIndexConcurrently"
  | "dropIndexConcurrently";

/** Where a form runs: in the main transaction or as a follow-up step. */
export type DdlPhase = "main" | "followUp";

/** Table lock modes generated DDL needs, weakest first. */
export const LOCK_MODES = [
  "SHARE",
  "SHARE ROW EXCLUSIVE",
  "ACCESS EXCLUSIVE",
] as const;

/** A table lock mode. */
export type LockMode = (typeof LOCK_MODES)[number];

/** A lock a statement takes on a table. */
export interface TableLock {
  /** The quoted table. */
  readonly table: string;
  readonly mode: LockMode;
}

/**
 * One generated statement, with its lock inventory: every table lock it
 * takes on a relation other than one it creates. The engine takes these
 * locks explicitly, one at a time, under the attempt's lock budget before
 * the statement runs (Contracts 1.4), so the statement itself never waits.
 */
export interface DdlStatement {
  readonly form: DdlForm;
  readonly sql: string;
  readonly locks: readonly TableLock[];
}

const FOLLOW_UP_FORMS: ReadonlySet<DdlForm> = new Set<DdlForm>([
  "validateConstraint",
  "createIndexConcurrently",
  "dropIndexConcurrently",
]);

/**
 * Where a form runs.
 *
 * @param form - A DDL form.
 * @returns `followUp` for validation and concurrent index statements.
 */
export const phaseOfForm = (form: DdlForm): DdlPhase =>
  FOLLOW_UP_FORMS.has(form) ? "followUp" : "main";

const IDENT = String.raw`"(?:[^"]|"")+"`;
const TABLE = String.raw`${IDENT}\.${IDENT}`;
const HEX = "[0-9a-f]{32}";
const CONSTANT = String.raw`(?:'(?:[^']|'')*'::[a-z0-9_(), ]+|true|false)`;
const UUID_LITERAL = String.raw`'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'::uuid`;
const NOT_VALID = "(?: NOT VALID)?";

const FORMS: readonly (readonly [DdlForm, RegExp])[] = [
  ["createSchema", new RegExp(String.raw`^CREATE SCHEMA ${IDENT}$`, "u")],
  [
    "createTable",
    new RegExp(String.raw`^CREATE TABLE ${TABLE} \(\n[\s\S]+\n\)$`, "u"),
  ],
  [
    "createTrigger",
    new RegExp(
      String.raw`^CREATE TRIGGER std_tg_${HEX} BEFORE UPDATE ON ${TABLE} FOR EACH ROW WHEN \(OLD\.class_id IS DISTINCT FROM NEW\.class_id\) EXECUTE FUNCTION core\.refuse_class_change\(\)$`,
      "u"
    ),
  ],
  [
    "createIndex",
    new RegExp(
      String.raw`^CREATE (?:UNIQUE )?INDEX std_ix_${HEX} ON ${TABLE} \(.+\)$`,
      "u"
    ),
  ],
  [
    "createIndexConcurrently",
    new RegExp(
      String.raw`^CREATE (?:UNIQUE )?INDEX CONCURRENTLY std_ix_${HEX} ON ${TABLE} \(.+\)$`,
      "u"
    ),
  ],
  [
    "dropIndexConcurrently",
    new RegExp(
      String.raw`^DROP INDEX CONCURRENTLY IF EXISTS ${IDENT}\.std_ix_${HEX}$`,
      "u"
    ),
  ],
  [
    "addColumn",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} ADD COLUMN ${IDENT} [a-z0-9(), ]+?(?: CONSTRAINT std_nn_${HEX} NOT NULL)?(?: DEFAULT ${CONSTANT})?$`,
      "u"
    ),
  ],
  [
    "addForeignKey",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} ADD CONSTRAINT std_(?:fk|cb|ub)_${HEX} FOREIGN KEY \(${IDENT}\) REFERENCES ${TABLE} \(id\)${NOT_VALID}$`,
      "u"
    ),
  ],
  [
    "addCheck",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} ADD CONSTRAINT std_ck_${HEX} CHECK \(char_length\(${IDENT}\) <= \d+\)${NOT_VALID}$`,
      "u"
    ),
  ],
  [
    "addNotNull",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} ADD CONSTRAINT std_nn_${HEX} NOT NULL ${IDENT}${NOT_VALID}$`,
      "u"
    ),
  ],
  [
    "replaceSubtreeCheck",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} DROP CONSTRAINT (?<check>std_sc_${HEX}), ADD CONSTRAINT \k<check> CHECK \(class_id IN \(${UUID_LITERAL}(?:, ${UUID_LITERAL})*\)\) NOT VALID$`,
      "u"
    ),
  ],
  [
    "setDefault",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} ALTER COLUMN ${IDENT} SET DEFAULT ${CONSTANT}$`,
      "u"
    ),
  ],
  [
    "dropDefault",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} ALTER COLUMN ${IDENT} DROP DEFAULT$`,
      "u"
    ),
  ],
  [
    "dropColumn",
    new RegExp(String.raw`^ALTER TABLE ${TABLE} DROP COLUMN ${IDENT}$`, "u"),
  ],
  [
    "dropConstraint",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS std_(?:fk|ck|nn)_${HEX}$`,
      "u"
    ),
  ],
  [
    "validateConstraint",
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} VALIDATE CONSTRAINT std_[a-z]{2}_${HEX}$`,
      "u"
    ),
  ],
];

const TYPE_CHANGE = /\bALTER COLUMN\b[\s\S]*\bTYPE\b/u;
const SET_NOT_NULL = /\bSET NOT NULL\b/u;
const CONSTANT_ONLY = new RegExp(String.raw`^${CONSTANT}$`, "u");
const ON_DELETE = /\bON (?:DELETE|UPDATE) (?<action>[A-Z ]+?)(?=,\n|\n\)|$)/gu;
const LEVEL_FK = /CONSTRAINT std_lv_[0-9a-f]{32} FOREIGN KEY/u;

/** The outcome of checking one statement. */
export type DdlCheck =
  | { readonly ok: true; readonly form: DdlForm }
  | { readonly ok: false; readonly reason: DdlRefusal };

const QUOTES: ReadonlySet<string> = new Set(["'", '"']);

const MASK = "_";

/**
 * The statement with the contents of every string literal and quoted
 * identifier replaced by `_`, same length and same positions, so keyword
 * checks never read data or names as SQL (a default `'SET NOT NULL'` or a
 * column named `"type"` is not syntax). A doubled quote inside a literal or
 * identifier is part of its content.
 *
 * @param sql - A statement.
 * @returns The masked statement.
 */
export const maskQuoted = (sql: string): string => {
  let masked = "";
  let quote: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql.charAt(index);

    if (quote === null) {
      masked += char;

      if (QUOTES.has(char)) {
        quote = char;
      }
    } else if (char === quote && sql.charAt(index + 1) === quote) {
      masked += MASK + MASK;
      index += 1;
    } else if (char === quote) {
      masked += char;
      quote = null;
    } else {
      masked += MASK;
    }
  }

  return masked;
};

const WORD_CHAR = /[\w$]/u;

/**
 * Whether a statement uses lexical forms the builders never emit: escape
 * strings (`E'...'`, backslash escapes), dollar quotes (`$tag$...$tag$`)
 * and any other `$`, Unicode escapes (`U&'...'`, `U&"..."`) and comments.
 * The builders write standard strings and quoted identifiers only
 * (`quoteLiteral`, `quoteIdent`), which `maskQuoted` reads exactly; a
 * statement with any other form is refused before it is classified, so a
 * quote inside such a form can never hide the rest of the statement.
 *
 * @param sql - A statement.
 * @returns True when the statement leaves the builders' subset.
 */
export const usesUnsupportedSyntax = (sql: string): boolean => {
  const masked = maskQuoted(sql);

  for (let index = 0; index < masked.length; index += 1) {
    const char = masked.charAt(index);
    const next = masked.charAt(index + 1);
    const wordBefore = index > 0 && WORD_CHAR.test(masked.charAt(index - 1));

    const escapeString = (char === "E" || char === "e") && next === "'";
    const unicodeEscape = (char === "U" || char === "u") && next === "&";
    const prefixed = (escapeString || unicodeEscape) && !wordBefore;

    const comment =
      (char === "-" && next === "-") || (char === "/" && next === "*");

    if (char === "$" || comment || prefixed) {
      return true;
    }
  }

  return false;
};

const DEFAULT_KEYWORD = " DEFAULT ";

const CLAUSE_ENDS = [",\n", "\n)"] as const;

/**
 * The expressions after every ` DEFAULT ` keyword of a statement, each up to
 * the end of its column definition. Keywords and clause ends are found in
 * the masked text, the expressions are taken from the original.
 *
 * @param sql - A statement.
 * @param masked - The same statement with quoted contents masked.
 * @returns The default expressions.
 */
const defaultExpressions = (sql: string, masked: string): readonly string[] => {
  const found: string[] = [];
  let from = masked.indexOf(DEFAULT_KEYWORD);

  while (from !== -1) {
    const start = from + DEFAULT_KEYWORD.length;

    const ends = CLAUSE_ENDS.flatMap((end) => {
      const index = masked.indexOf(end, start);

      return index === -1 ? [] : [index];
    });

    const end = ends.length === 0 ? sql.length : Math.min(...ends);

    found.push(sql.slice(start, end).trim());
    from = masked.indexOf(DEFAULT_KEYWORD, start);
  }

  return found;
};

const hasVolatileDefault = (sql: string, masked: string): boolean =>
  defaultExpressions(sql, masked).some(
    (expression) => !CONSTANT_ONLY.test(expression)
  );

const createTableProblem = (sql: string): DdlRefusal | undefined => {
  const actions = [...sql.matchAll(ON_DELETE)].map(
    (match) => match.groups?.action ?? ""
  );

  const cascades = actions.filter((action) => action === "CASCADE").length;
  const levelFks = LEVEL_FK.test(sql) ? 1 : 0;

  if (actions.some((action) => action !== "CASCADE") || cascades > levelFks) {
    return "unknownForm";
  }

  return undefined;
};

/**
 * Classifies one statement against the allowed forms.
 *
 * @param sql - A generated statement.
 * @returns Its form, or why it is refused.
 */
export const checkDdl = (sql: string): DdlCheck => {
  if (usesUnsupportedSyntax(sql)) {
    return { ok: false, reason: "unknownForm" };
  }

  const masked = maskQuoted(sql);

  if (TYPE_CHANGE.test(masked)) {
    return { ok: false, reason: "typeChange" };
  }

  if (SET_NOT_NULL.test(masked)) {
    return { ok: false, reason: "setNotNull" };
  }

  if (hasVolatileDefault(sql, masked)) {
    return { ok: false, reason: "volatileDefault" };
  }

  const form = FORMS.find(([, pattern]) => pattern.test(sql))?.[0];

  if (form === undefined) {
    return { ok: false, reason: "unknownForm" };
  }

  const problem =
    form === "createTable" ? createTableProblem(masked) : undefined;

  return problem === undefined
    ? { form, ok: true }
    : { ok: false, reason: problem };
};
