/**
 * Part of `pnpm check`: proves that Oxlint loads `@foldkit/oxlint-plugin`
 * and runs its rules on `apps/web` only (docs/decisions/0010-foldkit-tooling.md).
 * A plugin that fails to load, or an override that stops matching, would
 * otherwise leave the web app's Foldkit rules silently off.
 *
 * It lints `tooling/canaries/foldkit-lint/counter.ts` with the root config
 * (`--format json`) at `apps/web/src/`, as an `apps/web` test file, and at
 * `packages/server/src/`, and requires exactly the expected Foldkit rules on
 * each.
 *
 * Usage: `node tooling/check-foldkit-lint.ts [--config <oxlint config>]`.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import {
  expectedFoldkitRules,
  probeFiles,
  probeFoldkitLint,
  rootOxlintConfig,
} from "./lib/foldkit-lint.ts";
import { report, runCheck } from "./lib/report.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "check-foldkit-lint";
const probeNames = ["web", "webTest", "server"] as const;

const describeRules = (rules: readonly string[]): string =>
  rules.length === 0
    ? "none"
    : rules.map((rule) => `foldkit/${rule}`).join(", ");

await runCheck(checkName, async () => {
  const { values } = parseArgs({
    options: { config: { default: rootOxlintConfig, type: "string" } },
  });

  const config = path.resolve(values.config);
  const probe = await probeFoldkitLint(config);
  const label = path.relative(repoRoot, config);

  if (probe.rules === undefined) {
    report(
      checkName,
      [
        `oxlint did not run with ${label} (exit ${String(probe.code)}); is @foldkit/oxlint-plugin installed and loadable?\n${probe.output.split("\n").slice(0, 20).join("\n")}`,
      ],
      ""
    );

    return;
  }

  const { rules } = probe;

  const problems = probeNames.flatMap((name) => {
    const expected = expectedFoldkitRules[name];
    const actual = rules[name];

    return actual.join(",") === expected.join(",")
      ? []
      : [
          `${probeFiles[name]}: expected ${describeRules(expected)}, got ${describeRules(actual)}; is @foldkit/oxlint-plugin loaded in ${label} and scoped to apps/web?`,
        ];
  });

  report(
    checkName,
    problems,
    `@foldkit/oxlint-plugin is loaded: ${describeRules(rules.web)} fire on ${probeFiles.web}, and no Foldkit rule fires on ${probeFiles.server}`
  );
});
