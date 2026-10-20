/**
 * Line-based readers for the few, fixed YAML shapes the tooling checks need
 * (`pnpm-workspace.yaml` and `pnpm-lock.yaml`). They avoid a YAML dependency
 * and fail loudly instead of guessing when a file has an unexpected shape.
 */

const topLevelKey = /^(?<key>[A-Za-z][\w-]*):(?:\s|$)/u;

/** One `key: value` line of a YAML mapping. */
export interface MapLine {
  readonly key: string;
  readonly value: string;
}

/**
 * Removes one pair of matching YAML quotes.
 *
 * @param text - A scalar as written in the file.
 * @returns The scalar without its quotes.
 */
export const unquote = (text: string): string => {
  const first = text.at(0);

  if ((first === '"' || first === "'") && text.length > 1) {
    return text.endsWith(first) ? text.slice(1, -1) : text;
  }

  return text;
};

const isIgnorable = (line: string): boolean => {
  const trimmed = line.trim();

  return trimmed === "" || trimmed.startsWith("#");
};

/**
 * Returns the indented lines of every top-level block named `key`, across all
 * YAML documents in the file (pnpm 12 lockfiles hold two documents).
 *
 * @param source - The YAML text.
 * @param key - The top-level key, such as `packages`.
 * @returns The block's non-blank, non-comment lines, still indented.
 */
export const blockLines = (source: string, key: string): string[] => {
  const lines: string[] = [];
  let inside = false;

  for (const line of source.split("\n")) {
    const top = topLevelKey.exec(line);

    if (line === "---" || top !== null) {
      inside = top?.groups?.key === key;
    } else if (inside && !isIgnorable(line)) {
      lines.push(line);
    }
  }

  return lines;
};

const fail = (key: string, line: string): never => {
  throw new Error(`Unexpected line in "${key}": ${line}`);
};

/**
 * Splits one indented `key: value` line.
 *
 * @param line - The line, with its indentation.
 * @param block - The enclosing block's key, for error messages.
 * @returns The unquoted key and the unquoted value.
 */
export const parseMapLine = (line: string, block: string): MapLine => {
  const trimmed = line.trim();
  const quote = trimmed.at(0);
  const quoted = quote === '"' || quote === "'";
  // The key ends after its closing quote, or at the first colon.
  const keyEnd = quoted ? trimmed.indexOf(quote, 1) + 1 : trimmed.indexOf(":");

  if (keyEnd <= 0 || trimmed[keyEnd] !== ":") {
    return fail(block, line);
  }

  return {
    key: unquote(trimmed.slice(0, keyEnd)),
    value: unquote(trimmed.slice(keyEnd + 1).trim()),
  };
};

/**
 * Reads a top-level YAML sequence of scalars, such as `packages:`.
 *
 * @param source - The YAML text.
 * @param key - The top-level key.
 * @returns The unquoted items.
 */
export const readList = (source: string, key: string): string[] =>
  blockLines(source, key).map((line) => {
    const trimmed = line.trim();

    return trimmed.startsWith("- ")
      ? unquote(trimmed.slice(2).trim())
      : fail(key, line);
  });

/**
 * Reads a top-level YAML mapping of scalars, such as `catalog:`.
 *
 * @param source - The YAML text.
 * @param key - The top-level key.
 * @returns The entries, keyed by unquoted name.
 */
export const readFlatMap = (source: string, key: string): Map<string, string> =>
  new Map(
    blockLines(source, key).map((line) => {
      const entry = parseMapLine(line, key);

      return [entry.key, entry.value] as const;
    })
  );

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

/**
 * Reads the keys at the first indentation level of a top-level block, such
 * as the `name@version` keys under a lockfile's `packages:`.
 *
 * @param source - The YAML text.
 * @param key - The top-level key.
 * @returns The unquoted keys, in file order.
 */
export const readKeys = (source: string, key: string): string[] => {
  const lines = blockLines(source, key);
  const indent = indentOf(lines[0] ?? "");

  return lines.flatMap((line) =>
    indentOf(line) === indent ? [parseMapLine(line, key).key] : []
  );
};
