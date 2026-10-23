/**
 * Reading strace's output: a cursor over one line, with C strings as
 * strace prints them (`"..."` with escapes, and `...` when shortened).
 */

/** strace's one-letter escapes. */
const ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["a", "\u0007"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
]);

/** A string from the trace. */
export interface TraceString {
  readonly text: string;
  /** strace printed `...` after it: the string is cut short. */
  readonly truncated: boolean;
}

/** A cursor over one line of the trace. */
export class Cursor {
  index = 0;
  readonly #text: string;

  /**
   * A cursor at the start of a line.
   * @param text - The line.
   */
  constructor(text: string) {
    this.#text = text;
  }

  /**
   * The text not read yet.
   * @returns It.
   */
  get rest(): string {
    return this.#text.slice(this.index);
  }

  /**
   * Skips `expected` if the text continues with it.
   * @param expected - The text.
   * @returns Whether it did.
   */
  skip(expected: string): boolean {
    if (this.#text.startsWith(expected, this.index)) {
      this.index += expected.length;

      return true;
    }

    return false;
  }

  /**
   * Reads a C string as strace prints it, `"..."` with escapes, followed by
   * `...` when strace shortened it.
   * @returns Its text (the bytes decoded as UTF-8) and whether strace
   *   shortened it; undefined when there is no complete string here.
   */
  string(): TraceString | undefined {
    if (!this.skip('"')) {
      return undefined;
    }

    const bytes: number[] = [];

    while (this.index < this.#text.length && this.#text[this.index] !== '"') {
      const code = this.#text.codePointAt(this.index) ?? 0;

      if (code < 0x80 && code !== 0x5c) {
        bytes.push(code);
        this.index += 1;
      } else {
        bytes.push(...this.#byte());
      }
    }

    if (!this.skip('"')) {
      return undefined;
    }

    return {
      text: Buffer.from(bytes).toString("utf-8"),
      truncated: this.skip("..."),
    };
  }

  #byte(): readonly number[] {
    const char = this.#text[this.index] ?? "";

    if (char !== "\\") {
      this.index += 1;

      return [...Buffer.from(char, "utf-8")];
    }

    const next = this.#text[this.index + 1] ?? "";
    const named = ESCAPES.get(next);

    if (named !== undefined) {
      this.index += 2;

      return [named.codePointAt(0) ?? 0];
    }

    if (next === "x") {
      const hex =
        /^[\da-f]{1,2}/iu.exec(this.#text.slice(this.index + 2))?.[0] ?? "";

      this.index += 2 + hex.length;

      return [Number.parseInt(hex || "0", 16)];
    }

    const octal =
      /^[0-7]{1,3}/u.exec(this.#text.slice(this.index + 1))?.[0] ?? "";

    this.index += 1 + Math.max(octal.length, 1);

    return [Number.parseInt(octal || "0", 8)];
  }
}
