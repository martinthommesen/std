/**
 * Checks the requirements matrix (Contracts 15.4). Fails when:
 *
 * - a matrix file does not parse against the row schema, a row ID repeats,
 *   a file names a specification or version that `pins.json` does not pin,
 *   or a pinned specification has no file (unless its pin names the
 *   workstream that will write it, `awaitingMatrix`; gate mode fails it);
 * - a `tested` row names a test file that does not exist or a title that no
 *   `describe`, `it` or `it.effect` in that file has (read statically);
 * - an `excluded` row names a decision that does not exist, or one whose
 *   `rows` do not list it, or a decision lists a row it does not exclude;
 * - the decision log does not parse (a `decided` entry needs an outcome);
 * - with `--gate step3|step4|step5`: a row of that step or an earlier one is
 *   `pending`, or is excluded by a decision that is `proposed` or
 *   `rejected`, or a specification of that step has no file or no rows.
 *
 * Completeness against the sources is the gate review's job; `--summary`
 * prints the row counts per file and source document that it records.
 *
 * Usage: `node tooling/check-conformance-matrix.ts [options]`, with
 * `--gate <step3 | step4 | step5>`, `--summary`, `--pins <file>`,
 * `--matrix-dir <dir>` and `--root <dir>`.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import type { FileSummary, GateName } from "./lib/conformance-matrix.ts";
import { checkConformanceMatrix, gateSteps } from "./lib/conformance-matrix.ts";
import { report, runCheck } from "./lib/report.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "check-conformance-matrix";

const isGate = (value: string): value is GateName =>
  gateSteps.some((gate) => gate === value);

const formatSummary = (summary: FileSummary): string => {
  const sources = [...summary.bySource].map(([source, counts]) => {
    const parts = [...counts].map(([status, count]) => `${status} ${count}`);

    return `  ${source}: ${parts.join(", ")}`;
  });

  return [`${summary.file}: ${summary.rows} rows`, ...sources].join("\n");
};

await runCheck(checkName, () => {
  const { values } = parseArgs({
    options: {
      gate: { type: "string" },
      "matrix-dir": {
        default: path.join(repoRoot, "docs", "conformance"),
        type: "string",
      },
      pins: {
        default: path.join(repoRoot, "packages", "tmf", "specs", "pins.json"),
        type: "string",
      },
      root: { default: repoRoot, type: "string" },
      summary: { default: false, type: "boolean" },
    },
  });

  const { gate } = values;

  if (gate !== undefined && !isGate(gate)) {
    throw new Error(`--gate must be one of ${gateSteps.join(", ")}`);
  }

  const result = checkConformanceMatrix({
    gate,
    matrixDir: values["matrix-dir"],
    pins: values.pins,
    root: values.root,
  });

  const lines = [
    ...result.notes.map((note) => `${checkName}: note: ${note}`),
    ...(values.summary ? result.summaries.map(formatSummary) : []),
  ];

  if (lines.length > 0) {
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  const rows = result.summaries.reduce((sum, file) => sum + file.rows, 0);
  const gateText = gate === undefined ? "" : `, gate ${gate} passed`;

  report(
    checkName,
    result.problems,
    `${result.summaries.length} matrix file(s), ${rows} row(s)${gateText}`
  );
});
