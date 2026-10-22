// Portions derived from Go go1.22.2, src/net/url/url.go.
// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE-go file next to this one.
//
// Modified for STD: translated to TypeScript and reduced to a yes/no check;
// the parsed URL and error messages are not kept.

/**
 * Go's `url.ParseRequestURI` (net/url, Go 1.22.2, the Go of Kubernetes
 * v1.30.0) as a yes/no check: the `uri` format a Kubernetes API server
 * validates. A port of `parse` with `viaRequest`, `getScheme`,
 * `parseAuthority`, `parseHost`, `validOptionalPort`, `validUserinfo`,
 * `unescape` and `shouldEscape`, keeping only what decides success.
 */

// Go's encoding modes that `unescape` distinguishes here.
type Mode = "host" | "path" | "userPassword" | "zone";

const hex = /^[0-9a-f]$/iu;

// What `shouldEscape` leaves unescaped in the host and zone modes:
// unreserved characters and the sub-delimiters Go allows in a host.
const hostCharacter = /^[A-Za-z0-9\-_.~!$&'()*+,;=:[\]<>"]$/u;

const port = /^(?::\d*)?$/u;

const userinfoCharacters = /^[A-Za-z0-9\-._:~!$&'()*+,;=%@]*$/u;

// A scheme as `getScheme` reads it: a letter, then letters, digits, `+`,
// `-` or `.`, up to the first `:`.
const schemePrefix = /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):/u;

const escapedInHost = (c: string): boolean => !hostCharacter.test(c);

const codeAt = (value: string, index: number): number =>
  value.codePointAt(index) ?? 0;

const hasControlByte = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = codeAt(value, index);

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
};

const validEscape = (value: string, index: number, mode: Mode): boolean => {
  const first = value.charAt(index + 1);
  const second = value.charAt(index + 2);

  if (index + 2 >= value.length || !hex.test(first) || !hex.test(second)) {
    return false;
  }

  const sequence = value.slice(index, index + 3);

  if (mode === "host") {
    return Number.parseInt(first, 16) >= 8 || sequence === "%25";
  }

  if (mode === "zone") {
    const char = String.fromCodePoint(Number.parseInt(first + second, 16));

    return sequence === "%25" || char === " " || !escapedInHost(char);
  }

  return true;
};

// Go's `unescape`, as a check: every `%` starts a valid escape, and the
// host and zone modes refuse ASCII characters that would need escaping.
const unescapes = (value: string, mode: Mode): boolean => {
  const hostLike = mode === "host" || mode === "zone";
  let index = 0;

  while (index < value.length) {
    const char = value.charAt(index);

    if (char === "%") {
      if (!validEscape(value, index, mode)) {
        return false;
      }

      index += 3;
    } else {
      if (hostLike && codeAt(value, index) < 0x80 && escapedInHost(char)) {
        return false;
      }

      index += 1;
    }
  }

  return true;
};

const parseHost = (host: string): boolean => {
  if (host.startsWith("[")) {
    const close = host.lastIndexOf("]");

    if (close === -1 || !port.test(host.slice(close + 1))) {
      return false;
    }

    const zone = host.slice(0, close).indexOf("%25");

    if (zone !== -1) {
      return (
        unescapes(host.slice(0, zone), "host") &&
        unescapes(host.slice(zone, close), "zone") &&
        unescapes(host.slice(close), "host")
      );
    }
  } else {
    const colon = host.lastIndexOf(":");

    if (colon !== -1 && !port.test(host.slice(colon))) {
      return false;
    }
  }

  return unescapes(host, "host");
};

const parseAuthority = (authority: string): boolean => {
  const at = authority.lastIndexOf("@");

  if (!parseHost(at === -1 ? authority : authority.slice(at + 1))) {
    return false;
  }

  if (at === -1) {
    return true;
  }

  const userinfo = authority.slice(0, at);

  return (
    userinfoCharacters.test(userinfo) &&
    userinfo.split(":").every((part) => unescapes(part, "userPassword"))
  );
};

interface Scheme {
  readonly scheme: string;
  readonly rest: string;
}

// Go's `getScheme`; undefined for "missing protocol scheme".
const getScheme = (raw: string): Scheme | undefined => {
  if (raw.startsWith(":")) {
    return undefined;
  }

  const scheme = schemePrefix.exec(raw)?.groups?.scheme;

  return scheme === undefined
    ? { rest: raw, scheme: "" }
    : { rest: raw.slice(scheme.length + 1), scheme };
};

const withoutQuery = (rest: string): string => {
  const question = rest.indexOf("?");

  return question === -1 ? rest : rest.slice(0, question);
};

/**
 * Whether Go's `url.ParseRequestURI` accepts a string: an absolute URI or an
 * absolute path, with valid escapes, host and port.
 *
 * @param raw - The string.
 * @returns True when Go parses it without an error.
 */
export const isRequestUri = (raw: string): boolean => {
  if (hasControlByte(raw) || raw === "") {
    return false;
  }

  if (raw === "*") {
    return true;
  }

  const parsed = getScheme(raw);

  if (parsed === undefined) {
    return false;
  }

  const rest = withoutQuery(parsed.rest);

  if (!rest.startsWith("/")) {
    // A rootless path after a scheme is opaque; without a scheme a request
    // URI must be absolute.
    return parsed.scheme !== "";
  }

  if (parsed.scheme !== "" && rest.startsWith("//")) {
    const authorityAndPath = rest.slice(2);
    const slash = authorityAndPath.indexOf("/");

    const authority =
      slash === -1 ? authorityAndPath : authorityAndPath.slice(0, slash);

    const path = slash === -1 ? "" : authorityAndPath.slice(slash);

    return parseAuthority(authority) && unescapes(path, "path");
  }

  return unescapes(rest, "path");
};
