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

  const loopAssignments = ["of", "in"].flatMap((operator) =>
    [
      "dbTest",
      "dbTest.effect",
      'dbTest["effect"]',
      "[dbTest]",
      "{ test: dbTest }",
      "{ test: dbTest.effect }",
      "[dbTest = fake]",
      "[...dbTest]",
      "{ ...dbTest }",
      "{ test: { nested: dbTest } }",
      "(dbTest as unknown)",
    ].map((target) => `for (${target} ${operator} values) {}`)
  );

  it.each(loopAssignments)(
    "rejects a shared-layer title after %s",
    (assignment) => {
      const result = readTestTitles(
        "loop.ts",
        `import { it, layer } from "@effect/vitest";
layer(fixture())((dbTest) => {
  ${assignment}
  dbTest.effect("phantom", () => Effect.void);
});
layer(fixture())((realTest) => {
  realTest.effect("real shared behavior", () => Effect.void);
});
it.live("real live behavior", () => Effect.void);`
      );

      expect(result.errors).toStrictEqual([]);
      expect([...result.titles]).toStrictEqual([
        "real shared behavior",
        "real live behavior",
      ]);
    }
  );

  it.each(["of", "in"])(
    "refuses imported test names assigned by for-%s",
    (operator) => {
      for (const { name, target } of [
        { name: "it", target: "it" },
        { name: "it", target: "it.effect" },
        { name: "it", target: "[it]" },
        { name: "layer", target: "layer" },
        { name: "describe", target: "describe" },
      ]) {
        const result = readTestTitles(
          "import-loop.ts",
          `import { describe, it, layer } from "@effect/vitest";
for (${target} ${operator} values) {}`
        );

        expect(result.errors).toStrictEqual([
          `declares its own ${name}, which shadows the imported ${name}`,
        ]);
      }
    }
  );

  it("keeps unrelated loop bindings and property keys from invalidating real registrations", () => {
    const result = readTestTitles(
      "unrelated-loops.ts",
      `import { it, layer } from "@effect/vitest";
layer(fixture())((dbTest) => {
  for (const value of values) {}
  for (const key in values) {}
  for (let [item] of values) {}
  for (var { dbTest: other } of values) {}
  for ({ dbTest: other } of values) {}
  for ({ dbTest: other } in values) {}
  dbTest.effect("real shared behavior", () => Effect.void);
});
it.live("real live behavior", () => Effect.void);`
    );

    expect(result.errors).toStrictEqual([]);
    expect([...result.titles]).toStrictEqual([
      "real shared behavior",
      "real live behavior",
    ]);
  });

  it.each(["of", "in"])(
    "conservatively rejects a shared-layer parameter shadowed by a for-%s declaration",
    (operator) => {
      const result = readTestTitles(
        "shadowed-loop.ts",
        `import { layer } from "@effect/vitest";
layer(fixture())((dbTest) => {
  for (const dbTest ${operator} values) {}
  dbTest.effect("shadowed binding", () => Effect.void);
});`
      );

      expect(result.errors).toStrictEqual([]);
      expect([...result.titles]).toStrictEqual([]);
    }
  );

  it.each([
    "{ effect: () => undefined }",
    `new Proxy(dbTest, {
      get: (target, key, receiver) => key === "effect"
        ? target.effect.skip
        : Reflect.get(target, key, receiver)
    })`,
  ])("rejects phantom or skipped titles after replacement with %s", (fake) => {
    const result = readTestTitles(
      "registration.test.ts",
      `import { describe, it, layer, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";
describe("mutation registration probe", () => {
  layer(Layer.empty)((dbTest) => {
    for (dbTest of [${fake}]) {}
    dbTest.effect("phantom", () => Effect.void);
  });
  it("real sentinel", () => { assert.isTrue(true); });
});`
    );

    expect(result.errors).toStrictEqual([]);
    expect([...result.titles]).toStrictEqual([
      "mutation registration probe",
      "real sentinel",
    ]);
  });
});
