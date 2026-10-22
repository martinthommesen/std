/**
 * Parsing the log of `strace -f -qq -e trace=execve,execveat -e signal=none`.
 *
 * The parser fails closed: every non-empty line must be a call it parses
 * completely (`execve` or `execveat`, whole or split into `<unfinished ...>`
 * and `<... resumed>`) or one of the listed metadata lines
 * (`+++ exited with N +++`, `+++ killed by SIGX +++`). Anything else, a
 * call that does
 * not parse, a call left unfinished, becomes a problem, and a string or
 * an argument list strace shortened is marked for `checkTrace` to refuse, so an unexpected trace cannot pass as clean.
 * Both PID prefixes strace writes are accepted, `123 ` and `[pid 123] `,
 * with any run of spaces after them: strace left-aligns the PID in a
 * column five characters wide (`%-5d `), so PIDs under five digits are
 * followed by two or more spaces. Every problem carries its line's text,
 * which `checkTrace` redacts and shortens before it reports the problem.
 */
import { Cursor } from "./trace-cursor.ts";

/** The traced calls. */
export type CallKind = "execve" | "execveat";

/** One execve or execveat from the trace. */
export interface Execve {
  readonly kind: CallKind;
  readonly pid: number;
  /** The path passed (empty for execveat on a file descriptor). */
  readonly program: string;
  /** `execveat`'s directory file descriptor, as printed. */
  readonly dirfd: string | undefined;
  readonly argv: readonly string[];
  /** `0`, or the error, such as `-1 ENOENT (No such file or directory)`. */
  readonly result: string;
  /** Whether strace cut a string or the argument list short. */
  readonly truncated: boolean;
}

/** A line or call the parser could not read. */
export interface TraceProblem {
  /** The 1-based line number. */
  readonly line: number;
  /** What is wrong, such as `not a recognized line`. */
  readonly problem: string;
  /** The line's full text, unredacted: report it only through `checkTrace`. */
  readonly text: string;
}

/** A parsed trace. */
export interface Trace {
  readonly calls: readonly Execve[];
  /** Lines and calls that could not be read. */
  readonly problems: readonly TraceProblem[];
}

const PREFIX = /^(?:\[pid +(?<bracketed>\d+)\]|(?<plain>\d+)) +(?<rest>\S.*)$/u;

const CALL = /^(?<kind>execve|execveat)\((?<call>[^\n]*)$/u;
const RESUMED = /^<\.\.\. (?<kind>execve|execveat) resumed>(?<rest>[^\n]*)$/u;
const DIRFD = /^(?<dirfd>AT_FDCWD|-?\d+), /u;

const METADATA: readonly RegExp[] = [
  /^\+\+\+ exited with \d+ \+\+\+$/u,
  /^\+\+\+ killed by SIG[\dA-Z]+(?: \(core dumped\))? \+\+\+$/u,
];

const UNFINISHED = " <unfinished ...>";

/** A call's text, split off the line, before it is parsed. */
interface RawCall {
  readonly kind: CallKind;
  readonly pid: number;
  readonly line: number;
  readonly text: string;
  /** The whole line, for problems. */
  readonly source: string;
}

/**
 * Reads the argument list after `[`, up to and including `]`.
 * @param cursor - At the first argument.
 * @returns The arguments and whether any was cut short, or undefined.
 */
const argumentList = (
  cursor: Cursor
): { readonly argv: string[]; readonly truncated: boolean } | undefined => {
  const argv: string[] = [];
  let truncated = false;
  let valid = true;

  while (valid && !cursor.skip("]")) {
    cursor.skip(", ");

    if (cursor.skip("...")) {
      truncated = true;
    } else {
      const argument = cursor.string();

      valid = argument !== undefined;
      truncated ||= argument?.truncated ?? false;
      argv.push(argument?.text ?? "");
    }
  }

  return valid ? { argv, truncated } : undefined;
};

/**
 * Parses one complete call, from after `execve(` or `execveat(`.
 * @param raw - The call's kind, PID and text.
 * @returns The call, or undefined when the text does not parse.
 */
const parseCall = (raw: RawCall): Execve | undefined => {
  const dirfd =
    raw.kind === "execveat" ? DIRFD.exec(raw.text)?.groups?.dirfd : undefined;

  if (raw.kind === "execveat" && dirfd === undefined) {
    return undefined;
  }

  const cursor = new Cursor(raw.text);

  cursor.index = dirfd === undefined ? 0 : dirfd.length + 2;

  const program = cursor.string();

  if (program === undefined || !cursor.skip(", [")) {
    return undefined;
  }

  const list = argumentList(cursor);
  const { rest } = cursor;
  const close = rest.indexOf(")");
  const after = close === -1 ? "" : rest.slice(close + 1).trimStart();

  if (list === undefined || !after.startsWith("=")) {
    return undefined;
  }

  return {
    argv: list.argv,
    dirfd,
    kind: raw.kind,
    pid: raw.pid,
    program: program.text,
    result: after.slice(1).trim(),
    truncated: program.truncated || list.truncated,
  };
};

/** The parser's running state. */
interface ParseState {
  readonly calls: Execve[];
  readonly problems: TraceProblem[];
  readonly pending: Map<string, RawCall>;
}

const complete = (state: ParseState, raw: RawCall): void => {
  const parsed = parseCall(raw);

  if (parsed === undefined) {
    state.problems.push({
      line: raw.line,
      problem: `an ${raw.kind} that does not parse`,
      text: raw.source,
    });
  } else {
    state.calls.push(parsed);
  }
};

/**
 * Reads one line after its PID prefix.
 * @param state - The parser's state.
 * @param pid - The PID.
 * @param rest - The rest of the line.
 * @param line - Its 1-based number.
 * @param source - The whole line, for problems.
 */
const readLine = (
  state: ParseState,
  pid: number,
  rest: string,
  line: number,
  source: string
): void => {
  const call = CALL.exec(rest)?.groups;
  const resumed = RESUMED.exec(rest)?.groups;

  if (call !== undefined) {
    const kind = call.kind === "execveat" ? "execveat" : "execve";
    const text = call.call ?? "";

    if (text.endsWith(UNFINISHED)) {
      state.pending.set(`${kind} ${pid}`, {
        kind,
        line,
        pid,
        source,
        text: text.slice(0, -UNFINISHED.length),
      });
    } else {
      complete(state, { kind, line, pid, source, text });
    }
  } else if (resumed === undefined) {
    if (!METADATA.some((pattern) => pattern.test(rest))) {
      state.problems.push({
        line,
        problem: "not a recognized line",
        text: source,
      });
    }
  } else {
    const kind = resumed.kind === "execveat" ? "execveat" : "execve";
    const key = `${kind} ${pid}`;
    const started = state.pending.get(key);

    state.pending.delete(key);

    if (started === undefined) {
      state.problems.push({
        line,
        problem: `a resumed ${kind} that never started`,
        text: source,
      });
    } else {
      complete(state, {
        ...started,
        text: `${started.text}${resumed.rest ?? ""}`,
      });
    }
  }
};

/**
 * Every execve and execveat in a trace log, in order of completion.
 * @param log - The log.
 * @returns The calls, and a problem for every line or call that could not
 *   be read.
 */
export const parseTrace = (log: string): Trace => {
  const state: ParseState = { calls: [], pending: new Map(), problems: [] };

  for (const [index, text] of log.split("\n").entries()) {
    if (text.trim() !== "") {
      const prefixed = PREFIX.exec(text)?.groups;
      const pid = prefixed?.bracketed ?? prefixed?.plain;

      if (pid === undefined) {
        state.problems.push({
          line: index + 1,
          problem: "no PID prefix",
          text,
        });
      } else {
        readLine(state, Number(pid), prefixed?.rest ?? "", index + 1, text);
      }
    }
  }

  for (const unfinished of state.pending.values()) {
    state.problems.push({
      line: unfinished.line,
      problem: `an ${unfinished.kind} that never finished`,
      text: unfinished.source,
    });
  }

  return { calls: state.calls, problems: state.problems };
};
