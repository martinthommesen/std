import { describe, expect, it } from "vitest";

import { isCheckedFormat, matchesFormat } from "../lib/kubernetes-formats.ts";

// The formats a Kubernetes 1.30 API server checks in CRD schemas
// (docs/decisions/0027-oda-canvas-probe.md, `oda-component-schema`).
// Addresses come from the documentation ranges (RFC 5737, RFC 3849).
const cases: readonly (readonly [
  string,
  readonly string[],
  readonly string[],
])[] = [
  [
    "date-time",
    [
      "2024-09-17T00:00:00.000Z",
      "2024-09-17T10:20:30+02:00",
      "2024-09-17t10:20:30z",
    ],
    [
      "definitely-not-a-date",
      "2024-02-30T00:00:00Z",
      "2024-09-17T24:00:00Z",
      "2024-09-17T10:20:30",
    ],
  ],
  ["date", ["2024-02-29"], ["2023-02-29", "2024-9-17"]],
  [
    "uri",
    ["https://example.org/a", "/relative/path", "urn:isbn:0451450523"],
    ["relative/path", ""],
  ],
  ["email", ["a@example.org", "Ann <a@example.org>"], ["not an address"]],
  ["hostname", ["example.org", "localhost"], ["-bad.example", "a..b"]],
  ["ipv4", ["192.0.2.1", "010.1.1.1"], ["2001:db8::1", "256.1.1.1"]],
  ["ipv6", ["2001:db8::1"], ["192.0.2.1", "2001:db8::1%eth0"]],
  ["cidr", ["192.0.2.0/24", "2001:db8::/32"], ["192.0.2.0/33", "192.0.2.0"]],
  [
    "mac",
    ["00:00:5e:00:53:01", "00-00-5e-00-53-01", "0000.5e00.5301"],
    ["00:00:5e:00:53"],
  ],
  ["uuid", ["123e4567-e89b-12d3-a456-426614174000"], ["123e4567"]],
  [
    "uuid4",
    ["123e4567-e89b-42d3-a456-426614174000"],
    ["123e4567-e89b-12d3-a456-426614174000"],
  ],
  ["isbn", ["0321751043", "978-0321751041"], ["0321751044"]],
  ["creditcard", ["4111 1111 1111 1111"], ["4111 1111 1111 1112"]],
  ["ssn", ["123-45-6789"], ["123456789"]],
  ["hexcolor", ["#FFFFFF", "fff"], ["#FFFF"]],
  ["rgbcolor", ["rgb(255, 0, 12)"], ["rgb(256,0,0)"]],
  ["byte", ["aGVsbG8="], ["aGVsbG8", "not base64!"]],
  ["duration", ["1h30m", "22 ns", "5 days", "-1.5h"], ["soon", "1x"]],
  ["bsonobjectid", ["507f1f77bcf86cd799439011"], ["507f1f77"]],
];

describe("kubernetes-formats", () => {
  it.each(cases)("checks %s", (format, valid, invalid) => {
    expect(
      valid.filter((value) => !matchesFormat(format, value))
    ).toStrictEqual([]);
    expect(
      invalid.filter((value) => matchesFormat(format, value))
    ).toStrictEqual([]);
  });

  it("ignores a format the API server does not check, as it does", () => {
    expect(isCheckedFormat("url")).toBeFalsy();
    expect(matchesFormat("url", "not a url")).toBeTruthy();
    expect(isCheckedFormat("password")).toBeTruthy();
  });
});
