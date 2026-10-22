// Fixture for the conformance-matrix-check tests: never run, only parsed for
// its test titles.
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

describe("rows-count", () => {
  it("counts rows", () => {
    expect([1, 2]).toHaveLength(2);
  });

  it(`counts rows in a template`, () => {
    expect([1]).toHaveLength(1);
  });

  // `it.skip` titles do not satisfy a row.
  it.skip("a skipped case", () => {
    expect([3]).toHaveLength(1);
  });

  // A test without a body does not run.
  it("a case without a body");
});

describe("effect-rows", () => {
  it.effect("reads rows", () => Effect.void);
});

// Nothing inside a skipped block runs.
describe.skip("a skipped block", () => {
  it("a case in a skipped block", () => {
    expect([4]).toHaveLength(1);
  });
});
