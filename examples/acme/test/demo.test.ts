/**
 * Smoke test of `pnpm spike:demo`: the demo runs end to end against a test
 * database and prints the expected outcomes of the two-user scenario.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { acmeTestLayer } from "@std/testing/acme-fixture";
import { TestHttpClient } from "@std/testing/http-client";
import { Effect, Layer, Ref } from "effect";

import { runDemo } from "../src/demo.ts";

const DemoLayer = TestHttpClient.layer.pipe(
  Layer.provideMerge(acmeTestLayer())
);

// A printer that collects the demo's lines.
const collectInto =
  (lines: Ref.Ref<readonly string[]>) =>
  (line: string): Effect.Effect<void> =>
    Ref.update(lines, (all) => [...all, line]);

describe("spike-demo", () => {
  it("is a function of its printer", () => {
    assert.isFunction(runDemo);
  });

  layer(DemoLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect("prints the two-user scenario", () =>
      Effect.gen(function* demo() {
        const lines = yield* Ref.make<readonly string[]>([]);

        yield* runDemo(collectInto(lines));

        const output = (yield* Ref.get(lines)).join("\n");

        for (const expected of [
          "bob via /acme.asset: 3 records",
          "alice via /acme.asset: 5 records",
          "-> 404 NotFound (identical to an unknown ID)",
          'bob filter "cost > 0" -> 400 UnknownField',
          "1. bob PATCH /acme.laptop/L {name} -> 200, version 2",
          "2. alice PATCH /acme.asset/L {cost} at version 1 -> 409 VersionConflict, current version 2",
          "-> 200, version 3",
          "4. bob PATCH /acme.asset/L {status} -> 403 NotAllowed",
          "-> 422 ValidationFailed",
          "bob via /acme.asset: v1 create",
        ]) {
          assert.include(output, expected);
        }

        assert.notInclude(
          output.split("bob via /acme.asset: v1")[1] ?? "",
          "cost"
        );
      })
    );
  });
});
