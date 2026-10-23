import { describe, expect, it } from "vitest";

import { linksOf, nextOf } from "./paging.ts";

describe("paging Link helpers", () => {
  it("retains hyphenated version relations, navigation, and commas in URIs", () => {
    expect([
      ...linksOf(
        '<https://example.test/a?fields=name,status>; rel="self", <https://example.test/a/history>; rel="version-history", </a?after=cursor>; rel="next"'
      ),
    ]).toStrictEqual([
      ["self", "https://example.test/a?fields=name,status"],
      ["version-history", "https://example.test/a/history"],
      ["next", "/a?after=cursor"],
    ]);
    expect(nextOf('</a?after=cursor>; rel="next"')).toBe("/a?after=cursor");
  });

  it("has no continuation when Link is absent or only has self", () => {
    expect([...linksOf(null)]).toStrictEqual([]);
    expect([...linksOf("")]).toStrictEqual([]);
    expect(nextOf(null)).toBeUndefined();
    expect(nextOf('<https://example.test/a>; rel="self"')).toBeUndefined();
  });
});
