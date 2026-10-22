/**
 * Go's `mail.ParseAddress` (net/mail, Go 1.22.2, the Go of Kubernetes
 * v1.30.0) as a yes/no check: the `email` format a Kubernetes API server
 * validates (kube-openapi's `IsEmail` also requires a non-empty address). A
 * port of `parseSingleAddress`, `parseAddress`, `consumeGroupList`,
 * `consumeAddrSpec`, `consumePhrase`, `consumeQuotedString`, `consumeAtom`,
 * `skipCFWS` and `consumeComment`. RFC 2047 encoded words are taken as
 * plain atoms: their decoding can only change the display name, which the
 * check does not use.
 */

/** The parser's remaining input, consumed from the front. */
interface Input {
  rest: string;
}

class ParseError extends Error {
  override readonly name = "ParseError";
}

const misformattedComment = "misformatted parenthetical comment";

const specials = new Set('()<>[]:;@\\,"');

const isVchar = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;

  return (code >= 0x21 && code <= 0x7e) || code >= 0x80;
};

const isWsp = (char: string): boolean => char === " " || char === "\t";

const isAtext = (char: string, dot: boolean): boolean => {
  if (char === ".") {
    return dot;
  }

  return !specials.has(char) && isVchar(char);
};

const isQtext = (char: string): boolean =>
  char !== "\\" && char !== '"' && isVchar(char);

const firstChar = (input: Input): string => {
  const code = input.rest.codePointAt(0);

  return code === undefined ? "" : String.fromCodePoint(code);
};

const skipSpace = (input: Input): void => {
  input.rest = input.rest.replace(/^[ \t]+/u, "");
};

const consume = (input: Input, char: string): boolean => {
  if (!input.rest.startsWith(char)) {
    return false;
  }

  input.rest = input.rest.slice(char.length);

  return true;
};

// '(' already consumed; true when the comment closes.
const consumeComment = (input: Input): boolean => {
  let depth = 1;

  while (input.rest !== "" && depth > 0) {
    if (input.rest.startsWith("\\") && input.rest.length > 1) {
      input.rest = input.rest.slice(1);
    } else if (input.rest.startsWith("(")) {
      depth += 1;
    } else if (input.rest.startsWith(")")) {
      depth -= 1;
    }

    input.rest = input.rest.slice(1);
  }

  return depth === 0;
};

const skipCfws = (input: Input): boolean => {
  skipSpace(input);

  while (consume(input, "(")) {
    if (!consumeComment(input)) {
      return false;
    }

    skipSpace(input);
  }

  return true;
};

const consumeQuotedString = (input: Input): string => {
  let index = 1;
  let text = "";
  let escaped = false;

  for (;;) {
    const code = input.rest.codePointAt(index);

    if (code === undefined) {
      throw new ParseError("unclosed quoted-string");
    }

    const char = String.fromCodePoint(code);

    if (escaped) {
      if (!isVchar(char) && !isWsp(char)) {
        throw new ParseError("bad character in quoted-string");
      }

      text += char;
      escaped = false;
    } else if (isQtext(char) || isWsp(char)) {
      text += char;
    } else if (char === '"') {
      break;
    } else if (char === "\\") {
      escaped = true;
    } else {
      throw new ParseError("bad character in quoted-string");
    }

    index += char.length;
  }

  input.rest = input.rest.slice(index + 1);

  return text;
};

const consumeAtom = (
  input: Input,
  dot: boolean,
  permissive: boolean
): string => {
  let index = 0;

  for (;;) {
    const code = input.rest.codePointAt(index);

    if (code === undefined || !isAtext(String.fromCodePoint(code), dot)) {
      break;
    }

    index += String.fromCodePoint(code).length;
  }

  if (index === 0) {
    throw new ParseError("invalid string");
  }

  const atom = input.rest.slice(0, index);

  input.rest = input.rest.slice(index);

  if (
    !permissive &&
    (atom.startsWith(".") || atom.includes("..") || atom.endsWith("."))
  ) {
    throw new ParseError("bad dot in atom");
  }

  return atom;
};

// On failure the input is left as it was, as Go restores it.
const consumeAddrSpec = (input: Input): string => {
  const saved = input.rest;

  try {
    skipSpace(input);

    if (input.rest === "") {
      throw new ParseError("no addr-spec");
    }

    const localPart =
      firstChar(input) === '"'
        ? consumeQuotedString(input)
        : consumeAtom(input, true, false);

    if (localPart === "") {
      throw new ParseError("empty quoted string in addr-spec");
    }

    if (!consume(input, "@")) {
      throw new ParseError("missing @ in addr-spec");
    }

    skipSpace(input);

    if (input.rest === "") {
      throw new ParseError("no domain in addr-spec");
    }

    return `${localPart}@${consumeAtom(input, true, false)}`;
  } catch (error) {
    input.rest = saved;
    throw error;
  }
};

const tryAddrSpec = (input: Input): string | undefined => {
  try {
    return consumeAddrSpec(input);
  } catch (error) {
    if (error instanceof ParseError) {
      return undefined;
    }

    throw error;
  }
};

// One word, or undefined when none can be read and there are words already
// (Go ignores the error then and ends the phrase).
const consumeWord = (input: Input, haveWords: boolean): string | undefined => {
  try {
    return firstChar(input) === '"'
      ? consumeQuotedString(input)
      : consumeAtom(input, true, true);
  } catch (error) {
    if (haveWords && error instanceof ParseError) {
      return undefined;
    }

    throw error;
  }
};

const consumePhrase = (input: Input): string => {
  const words: string[] = [];
  let done = false;

  while (!done) {
    if (words.length > 0 && !skipCfws(input)) {
      throw new ParseError(misformattedComment);
    }

    skipSpace(input);

    const word =
      input.rest === "" ? undefined : consumeWord(input, words.length > 0);

    if (word === undefined) {
      done = true;
    } else {
      words.push(word);
    }
  }

  return words.join(" ");
};

const consumeDisplayNameComment = (input: Input): void => {
  if (!consume(input, "(") || !consumeComment(input)) {
    throw new ParseError(misformattedComment);
  }
};

// One address, or a group's addresses when `handleGroup` is true.
const parseAddress = (input: Input, handleGroup: boolean): string[] => {
  skipSpace(input);

  if (input.rest === "") {
    throw new ParseError("no address");
  }

  // An addr-spec first; on failure the input is as it was.
  const bare = tryAddrSpec(input);

  if (bare !== undefined) {
    skipSpace(input);

    if (input.rest.startsWith("(")) {
      consumeDisplayNameComment(input);
    }

    return [bare];
  }

  if (!input.rest.startsWith("<")) {
    consumePhrase(input);
  }

  skipSpace(input);

  if (handleGroup && consume(input, ":")) {
    // oxlint-disable-next-line no-use-before-define -- groups nest addresses, as in Go
    return consumeGroupList(input);
  }

  if (!consume(input, "<")) {
    throw new ParseError("no angle-addr");
  }

  const spec = consumeAddrSpec(input);

  if (!consume(input, ">")) {
    throw new ParseError("unclosed angle-addr");
  }

  return [spec];
};

const consumeGroupList = (input: Input): string[] => {
  const group: string[] = [];

  skipSpace(input);

  if (consume(input, ";")) {
    if (!skipCfws(input)) {
      throw new ParseError(misformattedComment);
    }

    return group;
  }

  for (;;) {
    skipSpace(input);
    group.push(...parseAddress(input, false));

    if (!skipCfws(input)) {
      throw new ParseError(misformattedComment);
    }

    if (consume(input, ";")) {
      if (!skipCfws(input)) {
        throw new ParseError(misformattedComment);
      }

      return group;
    }

    if (!consume(input, ",")) {
      throw new ParseError("expected comma");
    }
  }
};

/**
 * Whether Go's `mail.ParseAddress` accepts a string as exactly one address
 * with a non-empty addr-spec (kube-openapi's `IsEmail`).
 *
 * @param value - The string.
 * @returns True when Go parses it as one address.
 */
export const isEmailAddress = (value: string): boolean => {
  const input: Input = { rest: value };

  try {
    const addresses = parseAddress(input, true);

    return (
      skipCfws(input) &&
      input.rest === "" &&
      addresses.length === 1 &&
      addresses[0] !== ""
    );
  } catch (error) {
    if (error instanceof ParseError) {
      return false;
    }

    throw error;
  }
};
