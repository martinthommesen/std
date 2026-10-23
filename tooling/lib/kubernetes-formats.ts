// Portions derived from:
// - kube-openapi 70dd3763d340, pkg/validation/strfmt (default.go, date.go,
//   time.go, duration.go, bson.go), Copyright 2015 go-swagger maintainers,
//   Licensed under the Apache License, Version 2.0 (STD's LICENSE file);
// - Kubernetes v1.30.0, staging/src/k8s.io/apiextensions-apiserver/pkg/
//   apiserver/validation/formats.go, Copyright 2019 The Kubernetes Authors,
//   Licensed under the Apache License, Version 2.0;
// - govalidator f61b66f89f4a (github.com/asaskevich/govalidator), Copyright
//   (c) 2014 Alex Saskevich, MIT License (LICENSE-govalidator next to this
//   file).
// Modified for STD: the format list, patterns and checks translated to
// TypeScript, each reduced to a yes/no check.

/**
 * The string formats a Kubernetes 1.30 API server checks in a
 * CustomResourceDefinition's schema, ported from the validators it uses:
 * apiextensions-apiserver's `supportedFormats`
 * (`pkg/apiserver/validation/formats.go` at v1.30.0) and kube-openapi's
 * `pkg/validation/strfmt` at the version Kubernetes 1.30.0 pins
 * (70dd3763d340), with the govalidator checks it calls.
 *
 * A format name is normalized by removing `-` (go-openapi's rule), so
 * `date-time` is `datetime`. The API server drops any other format from the
 * schema before validating, so such a format checks nothing here either.
 * `uri` and `email` are ports of Go's `net/url` and `net/mail` parsers
 * (`go-url.ts`, `go-mail.ts`). tooling/fixtures/kubernetes-formats/ runs the
 * pinned Go validators over a corpus of inputs, and the tests compare.
 */
import { isIP } from "node:net";

import { isValidCivilDate } from "@std/values/calendar";

import { isEmailAddress } from "./go-mail.ts";
import { isRequestUri } from "./go-url.ts";

const fullDate = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

const timeOfDay =
  /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:.\d+)?(?:z|[+-]\d{2}:\d{2})$/u;

// kube-openapi's HostnamePattern, split into its parts: one label with at
// most one hyphen, right after its first character, or dotted labels ending
// in a top-level domain of letters.
const hostChar = String.raw`[a-zA-Z0-9\p{S}\p{L}]`;
const singleLabel = new RegExp(`^${hostChar}(?:-?${hostChar}{0,62})?$`, "u");

const dottedLabel = new RegExp(
  String.raw`^${hostChar}(?:[a-zA-Z0-9\-\p{S}\p{L}]{0,61}${hostChar})?$`,
  "u"
);

const topLevelDomain = /^[a-zA-Z\p{L}]{2,63}$/u;

const uuid =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu;

const uuid3 =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?3[0-9a-f]{3}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu;

const uuid4 =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?4[0-9a-f]{3}-?[89ab][0-9a-f]{3}-?[0-9a-f]{12}$/iu;

const uuid5 =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?5[0-9a-f]{3}-?[89ab][0-9a-f]{3}-?[0-9a-f]{12}$/iu;

const bsonObjectId = /^[0-9a-f]{24}$/iu;

const isbn10Digits = /^(?:\d{9}X|\d{10})$/u;
const isbn13Digits = /^\d{13}$/u;
const isbnSeparators = /[\s-]+/gu;

// govalidator's CreditCard pattern, one issuer at a time.
const cardIssuers = [
  /^4\d{12}(?:\d{3})?$/u,
  /^5[1-5]\d{14}$/u,
  /^6(?:011|5\d\d)\d{12}$/u,
  /^3[47]\d{13}$/u,
  /^3(?:0[0-5]|[68]\d)\d{11}$/u,
  /^(?:2131|1800|35\d{3})\d{11}$/u,
];

const notDigit = /\D+/gu;

const ssn = /^\d{3}[- ]?\d{2}[- ]?\d{4}$/u;
const hexColor = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const rgbColor = /^rgb\((?<red>[^,]*),(?<green>[^,]*),(?<blue>[^,]*)\)$/u;
const rgbChannel = /^\s*(?:0|[1-9]\d?|1\d\d?|2[0-4]\d|25[0-5])\s*$/u;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const goDurationNumber = /(?:\d+(?:\.\d*)?|\.\d+)/uy;
const goDurationUnit = /(?:ns|us|µs|μs|ms|s|m|h)/uy;

const scalaUnits = [
  ["ns", "nano"],
  ["us", "µs", "micro"],
  ["ms", "milli"],
  ["s", "sec"],
  ["m", "min"],
  ["h", "hr", "hour"],
  ["d", "day"],
  ["w", "wk", "week"],
];

const digit = /\d/u;
const space = /\s/u;
const unitLetter = /[A-Za-zµ]/u;

const hexPair = /^[0-9a-f]{2}$/iu;
const hexQuad = /^[0-9a-f]{4}$/iu;
const dottedQuad = /^\d+(?:\.\d+){3}$/u;
const decimal = /^\d+$/u;

// `time.Parse("2006-01-02", value)`.
const isDate = (value: string): boolean => {
  const groups = fullDate.exec(value)?.groups;

  if (groups === undefined) {
    return false;
  }

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);

  return isValidCivilDate({ day, month, year });
};

// kube-openapi's IsDateTime: a date, `t`, then a time with a zone, compared
// as Go compares the strings.
const isDateTime = (value: string): boolean => {
  const [date, time] = value.toLowerCase().split("t");

  if (value.length < 4 || date === undefined || time === undefined) {
    return false;
  }

  const groups = timeOfDay.exec(time)?.groups;

  if (!isDate(date) || groups === undefined) {
    return false;
  }

  const hourValid = (groups.hour ?? "") <= "23";
  const minuteValid = (groups.minute ?? "") <= "59";

  return hourValid && minuteValid && (groups.second ?? "") <= "59";
};

const isHostname = (value: string): boolean => {
  if (value.length > 255) {
    return false;
  }

  if (singleLabel.test(value)) {
    return true;
  }

  const labels = value.split(".");
  const last = labels.pop() ?? "";

  return (
    labels.length > 0 &&
    topLevelDomain.test(last) &&
    labels.every((label) => dottedLabel.test(label))
  );
};

// Go's sloppy IPv4 parsing tolerates leading zeros in each octet.
const sloppyIp = (value: string): string =>
  dottedQuad.test(value)
    ? value
        .split(".")
        .map((octet) => String(Number(octet)))
        .join(".")
    : value;

const isIpAddress = (value: string): boolean =>
  !value.includes("%") && isIP(sloppyIp(value)) !== 0;

const isCidr = (value: string): boolean => {
  const [address, prefix, extra] = value.split("/");

  if (address === undefined || prefix === undefined || extra !== undefined) {
    return false;
  }

  const bits = isIP(sloppyIp(address)) === 4 ? 32 : 128;

  return isIpAddress(address) && decimal.test(prefix) && Number(prefix) <= bits;
};

// Go's `net.ParseMAC`: 6, 8 or 20 octets as pairs separated by `:` or `-`,
// or as groups of four separated by `.`.
const isMac = (value: string): boolean => {
  for (const separator of [":", "-"]) {
    const parts = value.split(separator);

    if ([6, 8, 20].includes(parts.length)) {
      return parts.every((part) => hexPair.test(part));
    }
  }

  const groups = value.split(".");

  return (
    [3, 4, 10].includes(groups.length) &&
    groups.every((group) => hexQuad.test(group))
  );
};

const weightedSum = (
  digits: string,
  weight: (index: number) => number
): number => {
  let sum = 0;

  for (let index = 0; index < digits.length; index += 1) {
    const char = digits.charAt(index);

    sum += weight(index) * (char === "X" ? 10 : Number(char));
  }

  return sum;
};

const isIsbn10 = (value: string): boolean => {
  const digits = value.replaceAll(isbnSeparators, "");

  return (
    isbn10Digits.test(digits) &&
    weightedSum(digits, (index) => index + 1) % 11 === 0
  );
};

const isIsbn13 = (value: string): boolean => {
  const digits = value.replaceAll(isbnSeparators, "");

  return (
    isbn13Digits.test(digits) &&
    weightedSum(digits, (index) => (index % 2 === 0 ? 1 : 3)) % 10 === 0
  );
};

// govalidator's IsCreditCard: an issuer's pattern and the Luhn check.
const isCreditCard = (value: string): boolean => {
  const digits = value.replaceAll(notDigit, "");

  if (!cardIssuers.some((issuer) => issuer.test(digits))) {
    return false;
  }

  let sum = 0;

  for (let index = 0; index < digits.length; index += 1) {
    const fromRight = digits.length - 1 - index;

    const doubled =
      Number(digits.charAt(index)) * (fromRight % 2 === 1 ? 2 : 1);

    sum += doubled > 9 ? doubled - 9 : doubled;
  }

  return sum % 10 === 0;
};

const isRgbColor = (value: string): boolean => {
  const groups = rgbColor.exec(value)?.groups;

  return (
    groups !== undefined &&
    [groups.red, groups.green, groups.blue].every((channel) =>
      rgbChannel.test(channel ?? "")
    )
  );
};

// govalidator's IsBase64: whole groups of four, padding only at the end.
const isBase64 = (value: string): boolean =>
  value.length % 4 === 0 && base64.test(value);

// Go's `time.ParseDuration`: an optional sign, then number-unit pairs.
const isGoDuration = (value: string): boolean => {
  if (value === "0") {
    return true;
  }

  let at = value.startsWith("-") || value.startsWith("+") ? 1 : 0;
  let pairs = 0;

  while (at < value.length) {
    goDurationNumber.lastIndex = at;

    if (!goDurationNumber.test(value)) {
      return false;
    }

    goDurationUnit.lastIndex = goDurationNumber.lastIndex;

    if (!goDurationUnit.test(value)) {
      return false;
    }

    at = goDurationUnit.lastIndex;
    pairs += 1;
  }

  return pairs > 0;
};

const isScalaUnit = (unit: string): boolean =>
  scalaUnits.some((variants) =>
    variants.some(
      (variant, index) =>
        variant === unit ||
        (index === variants.length - 1 && unit.startsWith(variant))
    )
  );

// The units strfmt's Scala-style fallback finds: every run of digits,
// optional spaces, then letters; one known unit is enough.
const scalaDurationUnits = (value: string): string[] => {
  const units: string[] = [];
  let at = 0;

  while (at < value.length) {
    if (digit.test(value.charAt(at))) {
      while (digit.test(value.charAt(at))) {
        at += 1;
      }

      while (space.test(value.charAt(at))) {
        at += 1;
      }

      const start = at;

      while (unitLetter.test(value.charAt(at))) {
        at += 1;
      }

      units.push(value.slice(start, at).toLowerCase());
    } else {
      at += 1;
    }
  }

  return units;
};

const isDuration = (value: string): boolean =>
  isGoDuration(value) || scalaDurationUnits(value).some(isScalaUnit);

// Each format Kubernetes 1.30 checks, by its normalized name.
const checks = new Map<string, (value: string) => boolean>([
  ["bsonobjectid", (value) => bsonObjectId.test(value)],
  ["uri", isRequestUri],
  ["email", isEmailAddress],
  ["hostname", isHostname],
  ["ipv4", (value) => isIpAddress(value) && value.includes(".")],
  ["ipv6", (value) => isIpAddress(value) && value.includes(":")],
  ["cidr", isCidr],
  ["mac", isMac],
  ["uuid", (value) => uuid.test(value)],
  ["uuid3", (value) => uuid3.test(value)],
  ["uuid4", (value) => uuid4.test(value)],
  ["uuid5", (value) => uuid5.test(value)],
  ["isbn", (value) => isIsbn10(value) || isIsbn13(value)],
  ["isbn10", isIsbn10],
  ["isbn13", isIsbn13],
  ["creditcard", isCreditCard],
  ["ssn", (value) => value.length === 11 && ssn.test(value)],
  ["hexcolor", (value) => hexColor.test(value)],
  ["rgbcolor", isRgbColor],
  ["byte", isBase64],
  ["password", () => true],
  ["date", isDate],
  ["duration", isDuration],
  ["datetime", isDateTime],
]);

/**
 * Checks a string against a schema's `format` as a Kubernetes 1.30 API
 * server does.
 *
 * @param format - The schema's `format`, such as `date-time`.
 * @param value - The string.
 * @returns False when the server would refuse the value; true when it
 * accepts it or does not check that format.
 */
export const matchesFormat = (format: string, value: string): boolean =>
  checks.get(format.replaceAll("-", ""))?.(value) ?? true;

/**
 * Whether a Kubernetes 1.30 API server checks a format at all.
 *
 * @param format - The schema's `format`.
 * @returns True for the formats it checks.
 */
export const isCheckedFormat = (format: string): boolean =>
  checks.has(format.replaceAll("-", ""));
