import { describe, expect, it } from "vitest";

import { readTestTitles } from "../lib/test-titles.ts";

describe("test title import classification", () => {
  it("keeps shadow diagnostics ordered before other test-module imports", () => {
    const result = readTestTitles(
      "aliased.ts",
      `import { describe as d, it as i, test as d } from "vitest";
import { other as i } from "other";
d("a", () => {});`
    );

    expect(result.errors).toStrictEqual([
      "declares its own i, which shadows the imported it",
      "declares its own d, which shadows the imported describe",
    ]);
    expect(result.titles).toStrictEqual(new Set(["a"]));
  });
});
