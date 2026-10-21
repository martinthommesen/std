/**
 * Re-renders the Markdown of a committed results file from its JSON, after
 * a change to the report's wording: `node src/render.ts results/<date>.json`
 * writes `results/<date>.md` next to it. The JSON is not changed.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { renderMarkdown } from "./report.ts";
import type { ProbeReport } from "./report.ts";

const [file] = process.argv.slice(2);

if (file === undefined || !file.endsWith(".json")) {
  throw new Error("usage: node src/render.ts results/<date>.json");
}

// SAFETY: the file was written by main.ts with JSON.stringify of a ProbeReport.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; the file is our own ProbeReport output
const report = JSON.parse(readFileSync(file, "utf-8")) as ProbeReport;

writeFileSync(file.replace(/\.json$/u, ".md"), renderMarkdown(report));
