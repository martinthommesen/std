import { migrationSqlTokens, splitSqlTokens } from "./migration-sql.ts";
import type { SqlToken } from "./migration-sql.ts";

/** Conservative SQL surface check for rolling-upgrade expand migrations. */
interface CheckMigration {
  readonly id: number;
  readonly name: string;
  readonly phase?: string;
  readonly kind: string;
  readonly statements?: readonly string[];
  readonly statement?: string;
}

const number = /^\d+(?:\.\d+)?$/u;
const forbidden = new Set(["DROP", "RENAME", "TRUNCATE", "CLUSTER", "REINDEX"]);

const words = (tokens: readonly SqlToken[]): string =>
  tokens.map((token) => (token.literal ? "<literal>" : token.text)).join(" ");

const identifierEnd = (tokens: readonly SqlToken[], start: number): number =>
  tokens[start + 1]?.text === "." ? start + 3 : start + 1;

const objectName = (tokens: readonly SqlToken[], start: number): string =>
  tokens
    .slice(start, identifierEnd(tokens, start))
    .map((token) =>
      token.text.startsWith('"')
        ? token.text.slice(1, -1).replaceAll('""', '"')
        : token.text.toLowerCase()
    )
    .join("");

const notValid = (text: string): boolean => text.endsWith("NOT VALID");

const constraint =
  /\b(?:CHECK|UNIQUE|REFERENCES|FOREIGN KEY|PRIMARY KEY|EXCLUDE)\b/u;

const setNotNull = /\bSET NOT NULL\b/u;

const typeChange =
  /\b(?:ALTER (?:COLUMN )?\S+ (?:SET DATA )?TYPE|SET (?:TABLESPACE|ACCESS METHOD)|SET LOGGED|SET UNLOGGED)\b/u;

// Defaults must be literal constants with optional scalar type casts. This
// deliberately rejects stable functions too: a reviewer must use a data migration.
const constantDefault = (tokens: readonly SqlToken[]): boolean => {
  const start = tokens.findIndex((token) => token.text === "DEFAULT") + 1;

  if (start === 0) {
    return true;
  }

  let position = start;

  if (tokens[position]?.text === "-" || tokens[position]?.text === "+") {
    position += 1;
  }

  const value = tokens[position];

  if (
    value === undefined ||
    !(
      value.literal ||
      number.test(value.text) ||
      ["NULL", "TRUE", "FALSE"].includes(value.text)
    )
  ) {
    return false;
  }

  position += 1;

  if (tokens[position]?.text === "::") {
    position = identifierEnd(tokens, position + 1);
  }

  const next = tokens[position];

  return (
    next === undefined ||
    [
      "NOT",
      "NULL",
      "CONSTRAINT",
      "CHECK",
      "REFERENCES",
      "UNIQUE",
      "PRIMARY",
    ].includes(next.text)
  );
};

const addedColumnProblems = (
  tokens: readonly SqlToken[]
): readonly string[] => {
  const text = words(tokens);
  const problems: string[] = [];

  if (
    text.includes("NOT NULL") &&
    (!text.includes("DEFAULT") || text.includes("DEFAULT NULL"))
  ) {
    problems.push("NOT NULL column without a constant default");
  }

  if (!constantDefault(tokens)) {
    problems.push(
      "nonconstant or unrecognized column default may rewrite the table"
    );
  }

  if (constraint.test(text) && !notValid(text)) {
    problems.push("constraint on an existing table requires NOT VALID");
  }

  if (text.includes("GENERATED") || text.includes("IDENTITY")) {
    problems.push("generated/identity column may rewrite the table");
  }

  return problems;
};

const alterTableProblems = (
  tokens: readonly SqlToken[],
  fresh: ReadonlySet<string>
): readonly string[] => {
  const end = identifierEnd(tokens, 2);
  const existing = !fresh.has(objectName(tokens, 2));
  const problems: string[] = [];

  for (const action of splitSqlTokens(tokens.slice(end), ",")) {
    const text = words(action);

    if (text.startsWith("ADD COLUMN ")) {
      if (existing) {
        problems.push(...addedColumnProblems(action));
      }
    } else if (text.startsWith("ADD ") && constraint.test(text)) {
      if (existing && !notValid(text)) {
        problems.push(
          "constraint on an existing table requires NOT VALID (UNIQUE/PRIMARY KEY cannot use it)"
        );
      }
    } else if (!text.startsWith("VALIDATE CONSTRAINT ")) {
      problems.push(`unrecognized ALTER TABLE action: ${text}`);
    }
  }

  return problems;
};

const CREATE_TABLE = "CREATE TABLE ";
const CREATE_FUNCTION = "CREATE FUNCTION ";

const CREATE_FORMS = [
  "CREATE SCHEMA ",
  CREATE_TABLE,
  "CREATE INDEX ",
  "CREATE UNIQUE INDEX ",
  "CREATE TYPE ",
  "CREATE TRIGGER ",
  "COMMENT ON ",
];

const tableAs = /\bAS (?:SELECT|TABLE|WITH|EXECUTE)\b/u;

const historicalStatement = (
  id: number,
  tokens: readonly SqlToken[]
): boolean => {
  const text = tokens.map((token) => token.text).join(" ");

  if (id === 1) {
    return (
      text ===
      "INSERT INTO CORE . CONFIG_STATE ( REVISION , CHANGE_SET_ID ) VALUES ( 0 , UUIDV7 ( ) )"
    );
  }

  if (id === 11) {
    return (
      text ===
      "ALTER TABLE CORE . PLATFORM_MIGRATION ADD COLUMN STATE TEXT NOT NULL DEFAULT 'applied' CONSTRAINT PLATFORM_MIGRATION_STATE CHECK ( STATE IN ( 'running' , 'applied' ) ) , ADD COLUMN PROGRESS JSONB"
    );
  }

  return (
    id === 14 &&
    text ===
      "UPDATE CORE . DELIVERY SET FINISHED_AT = NOW ( ) WHERE STATUS IN ( 'done' , 'dead' )"
  );
};

const allowedForm = (text: string): boolean => {
  if (CREATE_FORMS.some((prefix) => text.startsWith(prefix))) {
    return true;
  }

  return text.startsWith("ALTER TYPE ") && text.includes(" ADD VALUE ");
};

const functionBodyProblems = (
  tokens: readonly SqlToken[]
): readonly string[] => {
  const body = tokens.find(
    (token, index) => token.literal && tokens[index - 1]?.text === "AS"
  );

  if (body === undefined) {
    return ["unrecognized function body"];
  }

  const source = body.body ?? body.text.slice(1, -1).replaceAll("''", "'");
  const bodyTokens = migrationSqlTokens(source);
  const text = words(bodyTokens);

  const unsafe = bodyTokens.some(
    (token) =>
      !token.literal &&
      (forbidden.has(token.text) ||
        token.text === "EXECUTE" ||
        token.text === "CALL")
  );

  return unsafe || setNotNull.test(text) || typeChange.test(text)
    ? ["destructive or dynamic SQL in a function body"]
    : [];
};

const creationProblems = (
  tokens: readonly SqlToken[],
  fresh: ReadonlySet<string>,
  functions: ReadonlySet<string>
): readonly string[] => {
  const text = words(tokens);

  if (text.startsWith("CREATE OR REPLACE ")) {
    return [
      "CREATE OR REPLACE may change existing function behavior; use a new name",
    ];
  }

  if (text.startsWith(CREATE_FUNCTION)) {
    const nameProblems = functions.has(objectName(tokens, 2))
      ? ["existing function name; use a new name even for a new signature"]
      : [];

    return [...nameProblems, ...functionBodyProblems(tokens)];
  }

  if (text.startsWith("CREATE UNIQUE INDEX ")) {
    const on = tokens.findIndex((token) => token.text === "ON");

    if (!fresh.has(objectName(tokens, on + 1))) {
      return ["unique index on an existing table constrains old writers"];
    }
  }

  if (text.startsWith(CREATE_TABLE) && tableAs.test(text)) {
    return ["CREATE TABLE AS requires a data migration"];
  }

  return allowedForm(text)
    ? []
    : [
        "unrecognized expand statement; use reviewed additive SQL or a contract/data migration",
      ];
};

const statementProblems = (
  migration: CheckMigration,
  tokens: readonly SqlToken[],
  fresh: ReadonlySet<string>,
  functions: ReadonlySet<string>
): readonly string[] => {
  if (migration.phase !== "expand") {
    return [];
  }

  const text = words(tokens);
  const problems: string[] = [];

  if (tokens.some((token) => !token.literal && forbidden.has(token.text))) {
    problems.push("DROP, RENAME or rewrite command");
  }

  if (setNotNull.test(text) || typeChange.test(text)) {
    problems.push("nullability/type/storage change");
  }

  if (historicalStatement(migration.id, tokens)) {
    return problems;
  }

  const specific = text.startsWith("ALTER TABLE ")
    ? alterTableProblems(tokens, fresh)
    : creationProblems(tokens, fresh, functions);

  return [...problems, ...specific];
};

const sqlProblems = (
  migration: CheckMigration,
  functions: Set<string>
): readonly string[] => {
  const problems: string[] = [];
  const fresh = new Set<string>();

  const statements =
    migration.kind === "tx"
      ? (migration.statements ?? [])
      : [migration.statement ?? ""];

  for (const [index, sql] of statements.entries()) {
    const parts = splitSqlTokens(migrationSqlTokens(sql), ";");

    for (const tokens of parts) {
      const text = words(tokens);

      if (text.startsWith(CREATE_TABLE)) {
        fresh.add(objectName(tokens, 2));
      }

      for (const failure of statementProblems(
        migration,
        tokens,
        fresh,
        functions
      )) {
        problems.push(`${migration.id} statement ${index + 1}: ${failure}`);
      }

      if (text.startsWith(CREATE_FUNCTION)) {
        functions.add(objectName(tokens, 2));
      }

      if (text.startsWith("CREATE OR REPLACE FUNCTION ")) {
        functions.add(objectName(tokens, 4));
      }
    }
  }

  return problems;
};

/**
 * Checks phase declarations and a closed subset of expand SQL. This is not a
 * PostgreSQL parser or a proof of old-code compatibility; see decision 0030.
 * @param migrations - The ordered, evaluated migration list.
 * @returns Human-readable failures, with migration and statement numbers.
 */
export const migrationPhaseProblems = (
  migrations: readonly CheckMigration[]
): readonly string[] => {
  const problems: string[] = [];
  const functions = new Set<string>();

  for (const migration of migrations) {
    if (migration.phase !== "expand" && migration.phase !== "contract") {
      problems.push(
        `${migration.id}: missing or unknown phase ${String(migration.phase)}`
      );
    } else if (migration.kind !== "data") {
      problems.push(...sqlProblems(migration, functions));
    }
  }

  return problems;
};
