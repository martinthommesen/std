/**
 * A static check of the command forms in `examples/quickstart.sh`, so the
 * runtime argument log (`argv-log.ts`) cannot be bypassed.
 *
 * The argument log wraps commands found on PATH by name. A command started
 * by path (`/usr/bin/jq`), through `command -p`, `exec`, `env`, `eval` or
 * `builtin`, or after a change of PATH would skip the wrappers, and a
 * password in its arguments would go unnoticed. This check refuses those
 * forms in the script's text, wherever a command can start: at the start
 * of a line, after `;`, `&`, `|`, `(`, `{` and shell keywords, after
 * assignment prefixes (`TOKEN=x cmd`), inside `$( ... )` and backticks
 * (also within double quotes and unquoted here-documents).
 *
 * It is a small lexer, not a shell parser, and it errs on the side of
 * refusing. It rejects:
 *
 * - a command word that contains `/` (an absolute or relative path);
 * - a command word that is not a literal (`$cmd`, `"$JQ"`, `$(...)`);
 * - the commands `command`, `builtin`, `exec`, `env`, `eval`, `source`,
 *   `.`, `hash`, `alias`, `enable`, `xargs`, `nohup`, `setsid`, `sudo`,
 *   `timeout`, `nice`, `stdbuf` and `bash`, whatever their arguments
 *   (some of these would be harmless in a given use, such as `exec 3>&1`
 *   or `timeout 5 curl`);
 * - `sh` with any arguments but `-c "$STD_DOCTOR_COMMAND"`, the one
 *   configurable command the script runs, which starts no password-bearing
 *   process of the script's own;
 * - the text `PATH=` or `PATH+=` anywhere in the script, quoted or not
 *   (so also a harmless mention in a string).
 */

/** One refused form, with its 1-based line. */
export interface CommandFormProblem {
  readonly line: number;
  readonly problem: string;
}

/** Commands that can run another command without a PATH lookup by name. */
const FORBIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  ".",
  "alias",
  "bash",
  "builtin",
  "command",
  "enable",
  "env",
  "eval",
  "exec",
  "hash",
  "nice",
  "nohup",
  "setsid",
  "source",
  "stdbuf",
  "sudo",
  "timeout",
  "xargs",
]);

/** Keywords after which a command starts. */
const COMMAND_KEYWORDS: ReadonlySet<string> = new Set([
  "!",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "until",
  "while",
  "{",
]);

/** Keywords after which no command starts until the next separator. */
const ARGUMENT_KEYWORDS: ReadonlySet<string> = new Set([
  "[[",
  "case",
  "for",
  "function",
  "in",
  "local",
  "declare",
  "readonly",
  "export",
  "return",
]);

/** Keywords that end a construct; the next word starts a command. */
const CLOSING_KEYWORDS: ReadonlySet<string> = new Set([
  "done",
  "esac",
  "fi",
  "}",
]);

const ASSIGNMENT = /^[A-Z_a-z]\w*\+?=/u;
const PATH_ASSIGNMENT = /PATH\+?=/u;
const SEPARATORS = new Set([";", "&", "|", "\n"]);
const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const DOCTOR_LINE = /^\s*sh -c "\$STD_DOCTOR_COMMAND"/u;

/** A pending here-document. */
interface Heredoc {
  readonly tag: string;
  readonly quoted: boolean;
}

/** The scanner's state within one command list. */
interface ScanState {
  commandPosition: boolean;
  heredocs: Heredoc[];
}

/** A here-document operator: `<<TAG`, `<<-TAG`, `<<'TAG'`, `<<"TAG"`. */
const HEREDOC = /^<<-?[\t ]*(?<quote>['"]?)(?<tag>\w+)\k<quote>/u;

/** A word: its text with quotes removed, and whether it was a literal. */
interface Word {
  readonly text: string;
  readonly literal: boolean;
  readonly end: number;
}

/** The lexer over one script. */
class Lexer {
  readonly problems: CommandFormProblem[] = [];
  readonly #source: string;
  readonly #lineStarts: number[] = [0];
  /** The next word is a `trap` handler: a script run later. */
  #trapHandler = false;

  constructor(source: string) {
    this.#source = source;

    let newline = source.indexOf("\n");

    while (newline !== -1) {
      this.#lineStarts.push(newline + 1);
      newline = source.indexOf("\n", newline + 1);
    }
  }

  lineOf(index: number): number {
    let line = 0;

    while (
      line + 1 < this.#lineStarts.length &&
      (this.#lineStarts[line + 1] ?? 0) <= index
    ) {
      line += 1;
    }

    return line + 1;
  }

  #lineText(index: number): string {
    const line = this.lineOf(index);
    const start = this.#lineStarts[line - 1] ?? 0;
    const end = this.#source.indexOf("\n", start);

    return this.#source.slice(start, end === -1 ? undefined : end);
  }

  #refuse(index: number, problem: string): void {
    this.problems.push({ line: this.lineOf(index), problem });
  }

  /**
   * Scans commands from `start` until `closer` (or the end).
   * @param start - Where to start.
   * @param closer - `)` inside `$( ... )`, a backtick inside backticks.
   * @returns The index after the closer.
   */
  commands(start: number, closer?: string): number {
    const state: ScanState = { commandPosition: true, heredocs: [] };
    let index = start;

    while (index < this.#source.length && this.#source[index] !== closer) {
      index = this.#step(index, state);
    }

    return index + 1;
  }

  /**
   * Scans one character, separator, comment, redirection or word.
   * @param index - Where to look.
   * @param state - Command position and pending here-documents.
   * @returns The index after what was scanned.
   */
  #step(index: number, state: ScanState): number {
    const source = this.#source;
    const char = source[index] ?? "";

    if (char === "\n" && state.heredocs.length > 0) {
      const after = this.#heredocBodies(index + 1, state.heredocs);

      state.heredocs = [];
      state.commandPosition = true;

      return after;
    }

    if (SEPARATORS.has(char) || char === "(") {
      state.commandPosition = true;

      return index + 1;
    }

    if (char === ")" || char === " " || char === "\t" || char === "\\") {
      return index + (char === "\\" ? 2 : 1);
    }

    if (char === "#") {
      const end = source.indexOf("\n", index);

      return end === -1 ? source.length : end;
    }

    if (char === "<" || char === ">") {
      return this.#redirection(index, state);
    }

    const word = this.#word(index);

    if (state.commandPosition) {
      state.commandPosition = this.#commandWord(word, index);
    } else if (this.#trapHandler) {
      this.#trapHandler = false;
      this.#nested(word, index);
    }

    return word.end;
  }

  /**
   * Scans a redirection: a here-document is remembered for its body; any
   * other target is a word, not a command.
   * @param index - At `<` or `>`.
   * @param state - Pending here-documents.
   * @returns The index after it.
   */
  #redirection(index: number, state: ScanState): number {
    const source = this.#source;
    const heredoc = HEREDOC.exec(source.slice(index));

    if (heredoc?.groups !== undefined && !source.startsWith("<<<", index)) {
      state.heredocs.push({
        quoted: (heredoc.groups.quote ?? "") !== "",
        tag: heredoc.groups.tag ?? "",
      });

      return index + heredoc[0].length;
    }

    let after = index + 1;

    while (source[after] === ">" || source[after] === "&") {
      after += 1;
    }

    return this.#word(after).end;
  }

  /**
   * Checks a word in command position.
   * @param word - The word.
   * @param index - Where it starts.
   * @returns Whether the next word is in command position too.
   */
  #commandWord(word: Word, index: number): boolean {
    // The name of an assignment is literal text; its value may expand.
    if (ASSIGNMENT.test(word.text)) {
      return true;
    }

    if (word.literal && COMMAND_KEYWORDS.has(word.text)) {
      return true;
    }

    if (word.literal && CLOSING_KEYWORDS.has(word.text)) {
      return true;
    }

    if (word.literal && ARGUMENT_KEYWORDS.has(word.text)) {
      return false;
    }

    this.#trapHandler = word.literal && word.text === "trap";

    if (!word.literal) {
      this.#refuse(index, "a command that is not a literal name");
    } else if (word.text.includes("/")) {
      this.#refuse(index, `a command started by path: ${word.text}`);
    } else if (FORBIDDEN_COMMANDS.has(word.text)) {
      this.#refuse(index, `the command ${word.text}`);
    } else if (word.text === "sh" && !DOCTOR_LINE.test(this.#lineText(index))) {
      this.#refuse(index, 'sh other than sh -c "$STD_DOCTOR_COMMAND"');
    }

    return false;
  }

  /**
   * Checks the script a `trap` runs later, reported at the trap's line.
   * @param word - The handler.
   * @param index - Where it starts.
   */
  #nested(word: Word, index: number): void {
    if (!word.literal) {
      this.#refuse(index, "a trap handler that is not a literal");

      return;
    }

    const inner = new Lexer(word.text);

    inner.commands(0);

    for (const found of inner.problems) {
      this.#refuse(index, `in a trap handler: ${found.problem}`);
    }
  }

  /**
   * Reads one word, scanning command substitutions inside it.
   * @param start - Where it starts.
   * @returns The word.
   */
  #word(start: number): Word {
    const source = this.#source;
    let index = start;
    let text = "";
    let literal = true;

    while (index < source.length && !this.#wordEnds(text, index)) {
      const char = source[index] ?? "";

      if (char === "(") {
        // An array assignment, `name=(...)`, is one word.
        const end = this.#closing(index + 1);

        text += source.slice(index, end);
        index = end;
      } else if (char === "\\") {
        text += source[index + 1] ?? "";
        index += 2;
      } else if (char === "'") {
        const end = this.#singleQuoteEnd(index + 1);

        text += source.slice(index + 1, end);
        index = end + 1;
      } else if (char === '"') {
        const inner = this.#doubleQuoted(index + 1);

        literal &&= inner.literal;
        text += inner.text;
        index = inner.end;
      } else if (char === "$" || char === "`") {
        literal = false;
        index = this.#expansion(index);
      } else {
        text += char;
        index += 1;
      }
    }

    return { end: index, literal, text };
  }

  /**
   * Whether a word ends at `index`: at a blank, separator, parenthesis or
   * redirection, except the `(` of an array assignment.
   * @param text - The word so far.
   * @param index - The next character.
   * @returns Whether it ends.
   */
  #wordEnds(text: string, index: number): boolean {
    const char = this.#source[index] ?? "";

    const arrayAssignment =
      char === "(" && ASSIGNMENT.test(text) && text.endsWith("=");

    return WORD_END.has(char) && !arrayAssignment;
  }

  /**
   * Where a single-quoted string ends.
   * @param start - After the opening quote.
   * @returns The index of the closing quote, or the end of the script.
   */
  #singleQuoteEnd(start: number): number {
    const end = this.#source.indexOf("'", start);

    return end === -1 ? this.#source.length : end;
  }

  /**
   * Reads a double-quoted string from after its opening quote.
   * @param start - After the quote.
   * @returns Its text, whether it was literal, and the index after it.
   */
  #doubleQuoted(start: number): Word {
    const source = this.#source;
    let index = start;
    let text = "";
    let literal = true;

    while (index < source.length && source[index] !== '"') {
      const char = source[index] ?? "";

      if (char === "\\") {
        text += source[index + 1] ?? "";
        index += 2;
      } else if (char === "$" || char === "`") {
        literal = false;
        index = this.#expansion(index);
      } else {
        text += char;
        index += 1;
      }
    }

    return { end: index + 1, literal, text };
  }

  /**
   * Skips an expansion at `$` or a backtick, scanning the commands of a
   * command substitution.
   * @param start - At `$` or the backtick.
   * @returns The index after it.
   */
  #expansion(start: number): number {
    const source = this.#source;

    if (source[start] === "`") {
      return this.commands(start + 1, "`");
    }

    if (source.startsWith("$((", start)) {
      return this.#closing(start + 3) + 1;
    }

    if (source.startsWith("$(", start)) {
      return this.commands(start + 2, ")");
    }

    if (source.startsWith("${", start)) {
      const end = source.indexOf("}", start);

      return end === -1 ? source.length : end + 1;
    }

    if (source.startsWith("$'", start)) {
      const end = source.indexOf("'", start + 2);

      return end === -1 ? source.length : end + 1;
    }

    const name = /^\$(?:\w+|[!#$*?@-])/u.exec(source.slice(start));

    return start + (name?.[0].length ?? 1);
  }

  /**
   * The index of the `)` that closes a parenthesis, skipping quotes.
   * @param start - After the opening parenthesis.
   * @returns The index after the closing one.
   */
  #closing(start: number): number {
    const source = this.#source;
    let depth = 1;
    let index = start;

    while (index < source.length && depth > 0) {
      const char = source[index] ?? "";

      if (char === "'") {
        index = this.#singleQuoteEnd(index + 1) + 1;
      } else if (char === '"') {
        index = this.#doubleQuoted(index + 1).end;
      } else if (char === "$") {
        index = this.#expansion(index);
      } else {
        depth += char === "(" ? 1 : 0;
        depth -= char === ")" ? 1 : 0;
        index += 1;
      }
    }

    return index;
  }

  /**
   * Scans the bodies of pending here-documents: the expansions of an
   * unquoted one run, so their commands are checked.
   * @param start - The start of the first body line.
   * @param heredocs - The pending here-documents, in order.
   * @returns The index after the last terminator line.
   */
  #heredocBodies(start: number, heredocs: readonly Heredoc[]): number {
    let index = start;

    for (const heredoc of heredocs) {
      index = this.#heredocBody(index, heredoc);
    }

    return index;
  }

  /**
   * Scans one here-document body, up to and including its terminator.
   * @param start - The start of its first line.
   * @param heredoc - Its tag and whether it was quoted.
   * @returns The index after the terminator line.
   */
  #heredocBody(start: number, heredoc: Heredoc): number {
    const source = this.#source;
    let index = start;
    let ended = false;

    while (index < source.length && !ended) {
      const end = source.indexOf("\n", index);
      const lineEnd = end === -1 ? source.length : end;

      ended = source.slice(index, lineEnd).trim() === heredoc.tag;

      if (!(ended || heredoc.quoted)) {
        index = this.#lineExpansions(index, lineEnd);
      }

      index = Math.max(index, lineEnd) + 1;
    }

    return index;
  }

  /**
   * Scans the expansions in one line of an unquoted here-document.
   * @param start - The line's start.
   * @param lineEnd - The line's end.
   * @returns Where scanning stopped (past `lineEnd` when an expansion
   *   spans lines).
   */
  #lineExpansions(start: number, lineEnd: number): number {
    let index = start;

    while (index < lineEnd) {
      const char = this.#source[index] ?? "";

      index = char === "$" || char === "`" ? this.#expansion(index) : index + 1;
    }

    return index;
  }
}

/**
 * The command forms in a script that would bypass the argument log.
 * @param source - The script's text.
 * @returns One entry per refused form; empty when the script is clean.
 */
export const commandFormProblems = (
  source: string
): readonly CommandFormProblem[] => {
  const lexer = new Lexer(source);

  lexer.commands(0);

  const pathAssignments = source
    .split("\n")
    .flatMap((text, index) =>
      PATH_ASSIGNMENT.test(text)
        ? [{ line: index + 1, problem: "a PATH assignment" }]
        : []
    );

  return [...lexer.problems, ...pathAssignments].toSorted(
    (left, right) => left.line - right.line
  );
};
