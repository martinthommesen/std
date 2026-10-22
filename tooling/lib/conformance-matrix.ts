/**
 * The requirements matrix (Contracts 15): the row and decision-log schemas,
 * the static reader of test titles, and every check of
 * `tooling/check-conformance-matrix.ts`.
 *
 * Inputs: the pins (`packages/tmf/specs/pins.json`, decoded by
 * `@std/tmf/pins`), one matrix file per pinned specification
 * (`docs/conformance/<spec>@<version>.yaml`) and the decision log
 * (`docs/conformance/decisions.yaml`). Test files are parsed, never run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { PinsFile, Specification } from "@std/tmf/pins";
import { decodePinsFile, matrixFileName } from "@std/tmf/pins";
import { Predicate, Result, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import { readTestTitles } from "./test-titles.ts";

/** The name of the decision log inside the matrix directory. */
export const decisionLogName = "decisions.yaml";

/** The values `--gate` accepts. */
export const gateSteps = ["step3", "step4", "step5"] as const;

/** One of {@link gateSteps}. */
export type GateName = (typeof gateSteps)[number];

const rowIdPattern = /^[A-Za-z0-9-]+@v?\d+(?:\.\d+)*\/[A-Za-z0-9._@{}/-]+$/u;

const StepSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(3),
  Schema.isLessThanOrEqualTo(5)
);

// Fields every row has (Contracts 15.1). `level` is what the source states.
const rowFields = {
  id: Schema.String.check(Schema.isPattern(rowIdPattern)),
  kitCases: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  level: Schema.Literals(["mandatory", "optional", "recommended"]),
  note: Schema.optionalKey(Schema.NonEmptyString),
  requirement: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  // The step whose gate covers the row; defaults to the specification's.
  step: Schema.optionalKey(StepSchema),
};

/** A matrix row: `tested` with tests, `excluded` by a decision, or `pending`. */
const RowSchema = Schema.Union([
  Schema.Struct({
    ...rowFields,
    status: Schema.Literal("tested"),
    tests: Schema.NonEmptyArray(Schema.NonEmptyString),
  }),
  Schema.Struct({
    ...rowFields,
    decision: Schema.NonEmptyString,
    status: Schema.Literal("excluded"),
  }),
  Schema.Struct({ ...rowFields, status: Schema.Literal("pending") }),
]);

/** One matrix row. */
export type Row = typeof RowSchema.Type;

/** A row's status. */
export type RowStatus = Row["status"];

/** A document a matrix file's rows cite. */
const SourceSchema = Schema.Struct({
  document: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  licence: Schema.NonEmptyString,
  location: Schema.optionalKey(Schema.NonEmptyString),
  note: Schema.optionalKey(Schema.NonEmptyString),
  version: Schema.NonEmptyString,
});

/** `docs/conformance/<spec>@<version>.yaml`. */
const MatrixFileSchema = Schema.Struct({
  kit: Schema.optionalKey(
    Schema.Struct({
      name: Schema.NonEmptyString,
      note: Schema.NonEmptyString,
    })
  ),
  notes: Schema.optionalKey(Schema.NonEmptyString),
  rows: Schema.Array(RowSchema),
  sources: Schema.NonEmptyArray(SourceSchema),
  spec: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});

/** A decoded matrix file. */
export type MatrixFile = typeof MatrixFileSchema.Type;

const decisionFields = {
  decision0021: Schema.optionalKey(Schema.Int),
  id: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  recommendation: Schema.NonEmptyString,
  requirement: Schema.NonEmptyString,
  rows: Schema.Array(Schema.String.check(Schema.isPattern(rowIdPattern))),
};

/**
 * A decision-log entry (Contracts 15.1). A `decided` entry without an
 * `outcome`, `decidedBy`, `words` or `date` does not decode.
 */
const DecisionSchema = Schema.Union([
  Schema.Struct({ ...decisionFields, state: Schema.Literal("proposed") }),
  Schema.Struct({
    ...decisionFields,
    date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
    decidedBy: Schema.NonEmptyString,
    outcome: Schema.Literals(["accepted", "rejected"]),
    state: Schema.Literal("decided"),
    words: Schema.NonEmptyString,
  }),
]);

/** One decision-log entry. */
export type Decision = typeof DecisionSchema.Type;

const DecisionLogSchema = Schema.Struct({
  entries: Schema.Array(DecisionSchema),
});

const strict = { errors: "all", onExcessProperty: "error" } as const;

/** Where the check reads its inputs. */
export interface MatrixInputs {
  /** `--gate`: also fail pending and undecided rows up to that step. */
  readonly gate: GateName | undefined;
  /** The directory of matrix files and the decision log. */
  readonly matrixDir: string;
  /** `pins.json`. */
  readonly pins: string;
  /** Test file paths in rows resolve against this directory. */
  readonly root: string;
}

/** Row counts of one file, as the gate review records them (Contracts 15.4). */
export interface FileSummary {
  /** Per source document (the second segment of the row ID), per status. */
  readonly bySource: ReadonlyMap<string, ReadonlyMap<RowStatus, number>>;
  readonly file: string;
  readonly rows: number;
}

/** What the check found. */
export interface MatrixReport {
  /** Facts that are not failures, such as a matrix file not written yet. */
  readonly notes: readonly string[];
  readonly problems: readonly string[];
  readonly summaries: readonly FileSummary[];
}

/** A matrix file as loaded, with its pin. */
interface LoadedFile {
  readonly file: MatrixFile;
  readonly name: string;
  readonly pin: Specification;
}

// Parses a YAML file and decodes it, or records why it cannot.
const decodeYamlFile = <S extends Schema.ConstraintDecoder<unknown>>(
  file: string,
  label: string,
  schema: S,
  problems: string[]
): S["Type"] | undefined => {
  let document: unknown;

  try {
    document = parseYaml(readFileSync(file, "utf-8"), {
      schema: "core",
      uniqueKeys: true,
    });
  } catch (error) {
    problems.push(`${label}: not valid YAML: ${String(error)}`);

    return undefined;
  }

  const decoded = Schema.decodeUnknownResult(schema, strict)(document);

  if (Result.isFailure(decoded)) {
    problems.push(
      `${label}: does not match its schema: ${String(decoded.failure)}`
    );

    return undefined;
  }

  return decoded.success;
};

const loadPins = (file: string): PinsFile => {
  const decoded = decodePinsFile(JSON.parse(readFileSync(file, "utf-8")));

  if (Result.isFailure(decoded)) {
    throw new Error(`${file}: ${String(decoded.failure)}`);
  }

  return decoded.success;
};

// The titles of one test file named by a row, or why it cannot be read.
const readNamedTestFile = (
  root: string,
  relative: string
): Result.Result<ReadonlySet<string>, string> => {
  const absolute = path.resolve(root, relative);

  const inside =
    !path.isAbsolute(relative) && absolute.startsWith(`${root}${path.sep}`);

  if (!inside || !existsSync(absolute) || !statSync(absolute).isFile()) {
    return Result.fail(`test file ${relative} does not exist`);
  }

  const read = readTestTitles(absolute, readFileSync(absolute, "utf-8"));

  if (read.errors.length > 0) {
    return Result.fail(
      `test file ${relative} cannot be read: ${read.errors.join("; ")}`
    );
  }

  return Result.succeed(read.titles);
};

/** Checks one `<test file>#<exact test title>`; `undefined` when it holds. */
type TestResolver = (reference: string) => string | undefined;

// Resolves test references, reading each file once.
const makeTestResolver = (root: string): TestResolver => {
  const cache = new Map<string, Result.Result<ReadonlySet<string>, string>>();

  return (reference) => {
    const hash = reference.indexOf("#");

    if (hash <= 0 || hash === reference.length - 1) {
      return `test reference "${reference}" is not <test file>#<exact test title>`;
    }

    const file = reference.slice(0, hash);
    const title = reference.slice(hash + 1);
    const titles = cache.get(file) ?? readNamedTestFile(root, file);

    cache.set(file, titles);

    if (Result.isFailure(titles)) {
      return titles.failure;
    }

    return titles.success.has(title)
      ? undefined
      : `no describe, it or it.effect in ${file} has the title "${title}"`;
  };
};

const gateNumber = (gate: GateName): number =>
  Number(gate.slice("step".length));

const countRows = (loaded: LoadedFile): FileSummary => {
  const bySource = new Map<string, Map<RowStatus, number>>();

  for (const row of loaded.file.rows) {
    const segment = row.id.split("/")[1] ?? "";
    const counts = bySource.get(segment) ?? new Map<RowStatus, number>();

    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    bySource.set(segment, counts);
  }

  return { bySource, file: loaded.name, rows: loaded.file.rows.length };
};

// A file must declare its pin, and its rows must carry the pin's prefix.
const checkPinAgreement = (loaded: LoadedFile, problems: string[]): void => {
  const { file, name, pin } = loaded;
  const prefix = `${pin.spec}@${pin.version}/`;

  if (file.spec !== pin.spec || file.version !== pin.version) {
    problems.push(
      `${name}: declares ${file.spec}@${file.version}, but pins.json pins ${pin.spec}@${pin.version}`
    );
  }

  for (const row of file.rows) {
    if (!row.id.startsWith(prefix)) {
      problems.push(`${name}: row ${row.id} does not start with ${prefix}`);
    }

    if (row.step !== undefined && row.step < pin.step) {
      problems.push(
        `${name}: row ${row.id} has step ${row.step}, before the specification's step ${pin.step}`
      );
    }
  }
};

// Loads one pinned specification's file, or notes that it is awaited.
const loadPinnedFile = (
  matrixDir: string,
  pin: Specification,
  problems: string[],
  notes: string[]
): LoadedFile | undefined => {
  const name = matrixFileName(pin);
  const file = path.join(matrixDir, name);

  if (!existsSync(file)) {
    if (pin.awaitingMatrix === undefined) {
      problems.push(
        `${name}: pins.json pins ${pin.spec}@${pin.version}, but the file is missing`
      );
    } else {
      notes.push(
        `${name}: not written yet (awaited from workstream ${pin.awaitingMatrix})`
      );
    }

    return undefined;
  }

  const decoded = decodeYamlFile(file, name, MatrixFileSchema, problems);

  if (decoded !== undefined && pin.awaitingMatrix !== undefined) {
    notes.push(
      `${name}: written; remove "awaitingMatrix": "${pin.awaitingMatrix}" from pins.json`
    );
  }

  return decoded === undefined ? undefined : { file: decoded, name, pin };
};

// Every pinned specification's file, and a problem for each unpinned file.
const loadMatrixFiles = (
  matrixDir: string,
  pins: PinsFile,
  problems: string[],
  notes: string[]
): LoadedFile[] => {
  const pinned = new Set(pins.specifications.map(matrixFileName));
  const present = existsSync(matrixDir) ? readdirSync(matrixDir) : [];

  for (const name of present) {
    const unpinned =
      name.endsWith(".yaml") && name !== decisionLogName && !pinned.has(name);

    if (unpinned) {
      problems.push(
        `${name}: not a pinned specification; pins.json pins ${[...pinned].join(", ")}`
      );
    }
  }

  return pins.specifications.flatMap((pin) => {
    const loaded = loadPinnedFile(matrixDir, pin, problems, notes);

    return loaded === undefined ? [] : [loaded];
  });
};

const loadDecisions = (file: string, problems: string[]): Decision[] => {
  if (!existsSync(file)) {
    problems.push(`${decisionLogName}: missing`);

    return [];
  }

  const log = decodeYamlFile(
    file,
    decisionLogName,
    DecisionLogSchema,
    problems
  );

  return [...(log?.entries ?? [])];
};

const duplicates = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      repeated.add(id);
    }

    seen.add(id);
  }

  return [...repeated];
};

// One row's tests, or its decision.
const checkRowReferences = (
  name: string,
  row: Row,
  resolveTest: TestResolver,
  decisionById: ReadonlyMap<string, Decision>,
  problems: string[]
): void => {
  if (row.status === "tested") {
    for (const reference of row.tests) {
      const problem = resolveTest(reference);

      if (problem !== undefined) {
        problems.push(`${name}: row ${row.id}: ${problem}`);
      }
    }

    return;
  }

  if (row.status !== "excluded") {
    return;
  }

  const decision = decisionById.get(row.decision);

  if (decision === undefined) {
    problems.push(
      `${name}: row ${row.id} names decision ${row.decision}, which the decision log does not have`
    );
  } else if (!decision.rows.includes(row.id)) {
    problems.push(
      `${name}: row ${row.id} is excluded by ${row.decision}, whose rows do not list it`
    );
  }
};

// A decision's rows must be rows it excludes. Rows of a matrix file that is
// not written yet cannot be checked until it is.
const checkDecisionRows = (
  decisions: readonly Decision[],
  rowById: ReadonlyMap<string, Row>,
  unwritten: readonly string[],
  problems: string[]
): void => {
  for (const decision of decisions) {
    for (const id of decision.rows) {
      const row = rowById.get(id);
      const awaited = unwritten.some((prefix) => id.startsWith(prefix));

      const excludedHere =
        row?.status === "excluded" && row.decision === decision.id;

      if (row === undefined && !awaited) {
        problems.push(
          `${decisionLogName}: ${decision.id} lists row ${id}, which no matrix file has`
        );
      } else if (row !== undefined && !excludedHere) {
        problems.push(
          `${decisionLogName}: ${decision.id} lists row ${id}, which it does not exclude`
        );
      }
    }
  }
};

// One gated row: nothing pending, and only exclusions Martin accepted.
const checkGatedRow = (
  gate: GateName,
  name: string,
  row: Row,
  decisionById: ReadonlyMap<string, Decision>,
  problems: string[]
): void => {
  if (row.status === "pending") {
    problems.push(`${gate}: ${name}: row ${row.id} is pending`);

    return;
  }

  const decision =
    row.status === "excluded" ? decisionById.get(row.decision) : undefined;

  if (decision?.state === "proposed") {
    problems.push(
      `${gate}: ${name}: row ${row.id} is excluded by ${decision.id}, which Martin has not decided`
    );
  } else if (decision?.state === "decided" && decision.outcome === "rejected") {
    problems.push(
      `${gate}: ${name}: row ${row.id} is excluded by ${decision.id}, which Martin rejected; it needs a test`
    );
  }
};

// Gate mode (Contracts 15.4): nothing pending or undecided up to the step.
const checkGate = (
  gate: GateName,
  pins: PinsFile,
  files: readonly LoadedFile[],
  decisionById: ReadonlyMap<string, Decision>,
  problems: string[]
): void => {
  const step = gateNumber(gate);
  const loadedNames = new Set(files.map((loaded) => loaded.name));

  for (const pin of pins.specifications) {
    if (pin.step <= step && !loadedNames.has(matrixFileName(pin))) {
      problems.push(
        `${gate}: ${matrixFileName(pin)} is missing or invalid, so none of its requirements is tested or excluded`
      );
    }
  }

  for (const { file, name, pin } of files) {
    const gated = file.rows.filter((row) => (row.step ?? pin.step) <= step);

    if (pin.step <= step && gated.length === 0) {
      problems.push(`${gate}: ${name} has no rows for this step`);
    }

    for (const row of gated) {
      checkGatedRow(gate, name, row, decisionById, problems);
    }
  }
};

// The row-ID prefixes of pinned specifications whose file is not loaded.
const unwrittenPrefixes = (
  pins: PinsFile,
  files: readonly LoadedFile[]
): string[] => {
  const loadedNames = new Set(files.map((loaded) => loaded.name));
  const prefixes: string[] = [];

  for (const pin of pins.specifications) {
    if (!loadedNames.has(matrixFileName(pin))) {
      prefixes.push(`${pin.spec}@${pin.version}/`);
    }
  }

  return prefixes;
};

// JSON pointers into OpenAPI documents: `#/components/schemas/Error`.
const pointerPattern = /#\/[^\s;,()]+/gu;

// A source segment naming another API's document: `TMF621 OAS v5.0.1 #/...`.
const namedDocumentPattern = /\b(?<spec>TMF\d+) OAS\b/u;

/** A parsed OpenAPI document. */
type JsonDocument = Schema.Json;

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

// Follows one JSON pointer (RFC 6901) through a parsed document.
const resolvesPointer = (document: JsonDocument, pointer: string): boolean => {
  let node: unknown = document;

  for (const raw of pointer.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");

    if (!Predicate.hasProperty(node, key)) {
      return false;
    }

    node = node[key];
  }

  return true;
};

/** Resolves pointers against pinned OpenAPI documents, each parsed once. */
type PointerResolver = (spec: string, pointer: string) => string | undefined;

const makePointerResolver = (
  specsDir: string,
  pins: PinsFile
): PointerResolver => {
  const documents = new Map<string, JsonDocument>();

  return (spec, pointer) => {
    const file = pins.specifications.find((pin) => pin.spec === spec)?.openApi
      ?.file;

    if (file === undefined) {
      return `cites ${pointer}, but ${spec} has no pinned OpenAPI document`;
    }

    const document =
      documents.get(file) ??
      decodeJson(parseYaml(readFileSync(path.join(specsDir, file), "utf-8")));

    documents.set(file, document);

    return resolvesPointer(document, pointer)
      ? undefined
      : `${pointer} does not resolve in ${file}`;
  };
};

// Every `#/...` pointer in a row's source must resolve in the document it
// names (`TMFnnn OAS` in the same `;`-separated part), else its own API's.
const checkRowPointers = (
  loaded: LoadedFile,
  resolve: PointerResolver,
  problems: string[]
): void => {
  for (const row of loaded.file.rows) {
    for (const part of row.source.split(";")) {
      const spec =
        namedDocumentPattern.exec(part)?.groups?.spec ?? loaded.pin.spec;

      for (const pointer of part.match(pointerPattern) ?? []) {
        const problem = resolve(spec, pointer);

        if (problem !== undefined) {
          problems.push(`${loaded.name}: row ${row.id}: ${problem}`);
        }
      }
    }
  }
};

/**
 * Runs every check of Contracts 15.4 over the matrix.
 *
 * @param inputs - Where the pins, matrix files, decision log and tests are.
 * @returns The problems (empty when the check passes), notes and row counts.
 */
export const checkConformanceMatrix = (inputs: MatrixInputs): MatrixReport => {
  const problems: string[] = [];
  const notes: string[] = [];
  const pins = loadPins(inputs.pins);
  const files = loadMatrixFiles(inputs.matrixDir, pins, problems, notes);

  const decisions = loadDecisions(
    path.join(inputs.matrixDir, decisionLogName),
    problems
  );

  const decisionById = new Map(decisions.map((entry) => [entry.id, entry]));

  const rows = files.flatMap((loaded) =>
    loaded.file.rows.map((row) => ({ name: loaded.name, row }))
  );

  const resolveTest = makeTestResolver(path.resolve(inputs.root));

  const resolvePointer = makePointerResolver(path.dirname(inputs.pins), pins);

  for (const loaded of files) {
    checkPinAgreement(loaded, problems);
    checkRowPointers(loaded, resolvePointer, problems);
  }

  for (const id of duplicates(rows.map(({ row }) => row.id))) {
    problems.push(`row id ${id} appears more than once`);
  }

  for (const id of duplicates(decisions.map((entry) => entry.id))) {
    problems.push(
      `${decisionLogName}: decision id ${id} appears more than once`
    );
  }

  for (const { name, row } of rows) {
    checkRowReferences(name, row, resolveTest, decisionById, problems);
  }

  checkDecisionRows(
    decisions,
    new Map(rows.map(({ row }) => [row.id, row])),
    unwrittenPrefixes(pins, files),
    problems
  );

  if (inputs.gate !== undefined) {
    checkGate(inputs.gate, pins, files, decisionById, problems);
  }

  return { notes, problems, summaries: files.map(countRows) };
};
