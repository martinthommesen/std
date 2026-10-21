/**
 * The static check of `examples/quickstart.sh` (`src/command-forms.ts`):
 * the script passes, and every form that would start a command without
 * the argument log's wrappers, planted in a copy of it, is refused.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

import { commandFormProblems } from "../src/command-forms.ts";

const SCRIPT = readFileSync(
  fileURLToPath(new URL("../../quickstart.sh", import.meta.url)),
  "utf-8"
);

const ANCHOR = 'heading "std doctor"';

/**
 * The script with a line planted before the doctor step.
 * @param planted - The line or lines.
 * @returns The new script.
 */
const withPlanted = (planted: string): string =>
  SCRIPT.replace(ANCHOR, `${planted}\n${ANCHOR}`);

/** Forms that must be refused, each planted alone. */
const FORBIDDEN: readonly (readonly [string, string])[] = [
  ["absolute path", '/usr/bin/jq -n --arg password "$ALICE_PASSWORD" .'],
  ["relative path", "./bin/jq -n ."],
  ["parent path", "../jq -n ."],
  ["quoted path", '"/usr/bin/jq" -n .'],
  ["command -p", "command -p jq -n ."],
  ["command", "command jq -n ."],
  ["builtin", "builtin command jq -n ."],
  ["exec with a path", "exec /usr/bin/jq -n ."],
  ["exec", "exec jq -n ."],
  ["env with PATH", "env PATH=/usr/bin jq -n ."],
  ["env", "env jq -n ."],
  ["PATH prefix", "PATH=/usr/bin jq -n ."],
  ["PATH assignment", 'PATH="/usr/bin:$PATH"'],
  ["PATH append", "PATH+=:/opt/bin"],
  ["export PATH", "export PATH=/usr/bin"],
  ["hash -p", "hash -p /usr/bin/jq jq"],
  ["alias", "alias jq=/usr/bin/jq"],
  ["eval", "eval '/usr/bin/jq -n .'"],
  ["source", "source ./other.sh"],
  ["dot", ". ./other.sh"],
  ["bash -c", "bash -c 'jq -n .'"],
  ["sh -c other than doctor", "sh -c 'jq -n .'"],
  ["xargs", "echo . | xargs jq -n"],
  ["timeout", "timeout 5 jq -n ."],
  ["variable command", '"$JQ" -n .'],
  ["unquoted variable command", "$JQ -n ."],
  ["assignment then path", "TOKEN= /usr/bin/curl -s x"],
  ["after &&", "true && /usr/bin/jq -n ."],
  ["after ||", "false || /usr/bin/jq -n ."],
  ["after a pipe", "echo . | /usr/bin/jq ."],
  ["after ;", "true; /usr/bin/jq -n ."],
  ["in a subshell", "( /usr/bin/jq -n . )"],
  ["in a group", "{ /usr/bin/jq -n .; }"],
  ["in if", "if /usr/bin/true; then :; fi"],
  ["in a command substitution", "x=$(/usr/bin/jq -n .)"],
  ["in a nested substitution", 'x=$(echo "$(/usr/bin/jq -n .)")'],
  ["in backticks", "x=`/usr/bin/jq -n .`"],
  ["in a double-quoted substitution", 'echo "now $(command -p jq -n .)"'],
  ["in an unquoted here-document", "cat <<EOF\n$(/usr/bin/jq -n .)\nEOF"],
  ["in a trap handler", "trap '/usr/bin/jq -n .' EXIT"],
  ["a computed command", "$(echo /usr/bin/jq) -n ."],
];

describe("command-forms", () => {
  it("examples/quickstart.sh starts every command by name", () => {
    assert.deepStrictEqual(commandFormProblems(SCRIPT), []);
  });

  it("the anchor exists, so every probe is planted", () => {
    assert.include(SCRIPT, ANCHOR);
  });

  it.each(FORBIDDEN)("refuses %s", (_name, planted) => {
    const problems = commandFormProblems(withPlanted(planted));

    const plantedLine = SCRIPT.slice(0, SCRIPT.indexOf(ANCHOR)).split(
      "\n"
    ).length;

    assert.isNotEmpty(problems, planted);
    assert.isTrue(
      problems.every(
        (found) =>
          found.line >= plantedLine &&
          found.line < plantedLine + planted.split("\n").length
      ),
      JSON.stringify(problems)
    );
  });

  it("leaves quoted text, single-quoted jq programs and quoted here-documents alone", () => {
    const harmless = [
      "echo '/usr/bin/jq is not run here'",
      'echo "a /path in text (and parentheses)"',
      "jq -n '{a: (1 | . + 1)}'",
      "cat <<'EOF'\n$(/usr/bin/jq -n .)\nEOF",
    ].join("\n");

    assert.deepStrictEqual(commandFormProblems(withPlanted(harmless)), []);
  });
});
