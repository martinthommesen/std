// Portions derived from Go go1.22.2, src/net/mail/message.go
// (Copyright 2011 The Go Authors) and src/mime/encodedword.go
// (Copyright 2015 The Go Authors). All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE-go file next to this one.
//
// Modified for STD: translated to TypeScript and reduced to a yes/no check;
// decoded text and error messages are not kept.

/**
 * Go's `mail.ParseAddress` (net/mail, Go 1.22.2, the Go of Kubernetes
 * v1.30.0) as a yes/no check: the `email` format a Kubernetes API server
 * validates (kube-openapi's `IsEmail` also requires a non-empty address). A
 * port of `parseSingleAddress`, `parseAddress`, `consumeGroupList`,
 * `consumeAddrSpec`, `consumePhrase`, `consumeQuotedString`, `consumeAtom`,
 * `consumeDisplayNameComment`, `skipCFWS`, `consumeComment` and
 * `decodeRFC2047Word` (with mime's `WordDecoder.Decode`): an RFC 2047
 * encoded word in a charset Go does not know fails the address, as in Go.
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

const isAtext = (char: string): boolean => !specials.has(char) && isVchar(char);

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
// '(' already consumed; the comment's text, or undefined when it does not
// close.
const consumeComment = (input: Input): string | undefined => {
  let depth = 1;
  let comment = "";

  while (input.rest !== "" && depth > 0) {
    if (input.rest.startsWith("\\") && input.rest.length > 1) {
      input.rest = input.rest.slice(1);
    } else if (input.rest.startsWith("(")) {
      depth += 1;
    } else if (input.rest.startsWith(")")) {
      depth -= 1;
    }

    if (depth > 0) {
      comment += input.rest.charAt(0);
    }

    input.rest = input.rest.slice(1);
  }

  return depth === 0 ? comment : undefined;
};

// mime's encoded-word decoding, as far as net/mail's outcome depends on it.
const goCharsets = new Set(["utf-8", "iso-8859-1", "us-ascii"]);

const strictBase64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const qText = /^(?:=[0-9A-Fa-f]{2}|[\t\n\r -<>-~])*$/u;
const lineBreaks = /[\r\n]/gu;

const utf8Length = (text: string): number =>
  new TextEncoder().encode(text).length;

const decodes = (encoding: string, text: string): boolean => {
  if (encoding === "B" || encoding === "b") {
    return strictBase64.test(text.replaceAll(lineBreaks, ""));
  }

  return (encoding === "Q" || encoding === "q") && qText.test(text);
};

/**
 * Whether `decodeRFC2047Word` fails on a word: a well-formed encoded-word
 * whose text decodes, in a charset other than UTF-8, ISO-8859-1 and
 * US-ASCII (net/mail's decoder has no others). Any other word, encoded or
 * not, is kept as it is.
 *
 * @param word - An atom or a word of a comment.
 * @returns True when Go reports an unsupported charset.
 */
const hasUnsupportedCharset = (word: string): boolean => {
  if (
    utf8Length(word) < 8 ||
    !word.startsWith("=?") ||
    !word.endsWith("?=") ||
    word.split("?").length !== 5
  ) {
    return false;
  }

  const [charset = "", encoding = "", text = ""] = word.slice(2, -2).split("?");

  return (
    charset !== "" &&
    encoding.length === 1 &&
    decodes(encoding, text) &&
    !goCharsets.has(charset.toLowerCase())
  );
};

const skipCfws = (input: Input): boolean => {
  skipSpace(input);

  while (consume(input, "(")) {
    if (consumeComment(input) === undefined) {
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

const consumeAtom = (input: Input, permissive: boolean): string => {
  let index = 0;

  for (;;) {
    const code = input.rest.codePointAt(index);

    if (code === undefined || !isAtext(String.fromCodePoint(code))) {
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
        : consumeAtom(input, false);

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

    return `${localPart}@${consumeAtom(input, false)}`;
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
// An atom is consumed before it is decoded, so a word in an unsupported
// charset ends the phrase after it, or fails a phrase without words.
const readWord = (input: Input): string => {
  if (firstChar(input) === '"') {
    return consumeQuotedString(input);
  }

  const atom = consumeAtom(input, true);

  if (hasUnsupportedCharset(atom)) {
    throw new ParseError("charset not supported");
  }

  return atom;
};

const consumeWord = (input: Input, haveWords: boolean): string | undefined => {
  try {
    return readWord(input);
  } catch (error) {
    if (haveWords && error instanceof ParseError) {
      return undefined;
    }

    throw error;
  }
};

const consumePhrase = (input: Input): void => {
  let haveWords = false;

  for (;;) {
    if (haveWords && !skipCfws(input)) {
      throw new ParseError(misformattedComment);
    }

    skipSpace(input);

    const word = input.rest === "" ? undefined : consumeWord(input, haveWords);

    if (word === undefined) {
      return;
    }

    haveWords = true;
  }
};

const consumeDisplayNameComment = (input: Input): void => {
  const comment = consume(input, "(") ? consumeComment(input) : undefined;

  if (comment === undefined) {
    throw new ParseError(misformattedComment);
  }

  if (comment.split(/[ \t]+/u).some((word) => hasUnsupportedCharset(word))) {
    throw new ParseError("charset not supported");
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
