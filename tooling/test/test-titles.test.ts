import { describe, expect, it } from "vitest";

import { readTestTitles } from "../lib/test-titles.ts";

describe("test title import classification", () => {
  it("recognizes live tests and direct shared-layer effect registrations", () => {
    const result = readTestTitles(
      "shared.ts",
      `
import { describe as suite, it as test, layer as shared } from "@effect/vitest";
test.live("live behavior", () => Effect.void);
suite("browser", () => {
  shared(fixture(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("browser behavior", () => Effect.void);
  });
  shared(fixture())("named layer", (namedTest) => {
    namedTest.effect("named behavior", () => Effect.void);
  });
});`
    );

    expect(result.errors).toStrictEqual([]);
    expect([...result.titles]).toStrictEqual([
      "live behavior",
      "browser",
      "browser behavior",
      "named behavior",
    ]);
  });

  it("does not invent tests from inactive, shadowed or indirect registrations", () => {
    const sources = [
      `function unused() { layer(fixture())((dbTest) => { dbTest.effect("phantom", () => Effect.void); }); }`,
      `if (false) { layer(fixture())((dbTest) => { dbTest.effect("phantom", () => Effect.void); }); }`,
      `describe.skip("skipped", () => { layer(fixture())((dbTest) => { dbTest.effect("phantom", () => Effect.void); }); });`,
      `layer.skip(fixture())((dbTest) => { dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())((dbTest) => { function unused() { dbTest.effect("phantom", () => Effect.void); } });`,
      `layer(fixture())((dbTest) => { dbTest.effect.skip("phantom", () => Effect.void); dbTest.effect("bodyless"); });`,
      `layer(fixture())((dbTest) => { const dbTest = fake; dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())((dbTest) => { dbTest = fake; dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())((dbTest) => { dbTest.effect = fake; dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())((dbTest) => { [dbTest] = [fake]; dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())((dbTest) => { ({ method: dbTest.effect } = fake); dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())((dbTest) => { (dbTest as unknown) = fake; dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())((dbTest) => { function unused(dbTest) {} dbTest.effect("phantom", () => Effect.void); });`,
      `layer(fixture())(async (dbTest) => { dbTest.effect("phantom", () => Effect.void); });`,
      `it.live.skipIf(true)("phantom", () => Effect.void); it.live() ("indirect", () => Effect.void);`,
      `it() ("phantom", () => Effect.void);`,
    ];

    for (const source of sources) {
      const result = readTestTitles(
        "phantom.ts",
        `import { describe, it, layer } from "@effect/vitest";\n${source}`
      );

      expect([...result.titles]).toStrictEqual([]);
    }

    expect([
      ...readTestTitles(
        "fake.ts",
        `import { layer } from "other"; layer(fixture())((dbTest) => { dbTest.effect("phantom", () => {}); });`
      ).titles,
    ]).toStrictEqual([]);
  });

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
