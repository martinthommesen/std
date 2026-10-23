/**
 * The shared API definition: a resource (Contracts 10.2) and the TMF
 * `Error` of the read-side errors (Contracts 10.6).
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  API_PREFIX,
  OPENAPI_PATH,
  SCHEMA_REVISION_HEADER,
} from "../src/api.ts";
import { Resource } from "../src/resource.ts";
import { TmfErrorSubtypes } from "../src/tmf-error.ts";

describe("records", () => {
  it("serves every route under /api/v1", () => {
    assert.strictEqual(API_PREFIX, "/api/v1");
    assert.strictEqual(OPENAPI_PATH, "/api/v1/openapi.json");
    assert.strictEqual(SCHEMA_REVISION_HEADER, "std-schema-revision");
  });

  it.effect("decodes a resource with its own attributes", () =>
    Effect.gen(function* resource() {
      const decoded = yield* Schema.decodeUnknownEffect(Resource)({
        "@baseType": "HelpdeskTicket",
        "@type": "HelpdeskIncident",
        assignee: { "@type": "CoreUserRef", id: "u1", name: "Alice Smith" },
        dueDate: "2026-10-23",
        href: "https://std.example/api/v1/helpdeskIncident/r1",
        id: "r1",
        revision: 7,
        withheld: ["internalCost"],
      });

      assert.strictEqual(decoded.id, "r1");
      assert.deepStrictEqual(decoded.withheld, ["internalCost"]);
    })
  );

  it.effect("decodes a TMF Error by its code and refuses another", () =>
    Effect.gen(function* errors() {
      const body = {
        "@type": "NotFound",
        code: "NotFound",
        reason: "The resource does not exist",
      };

      const decoded = yield* Schema.decodeUnknownEffect(
        TmfErrorSubtypes.NotFound
      )(body);

      assert.strictEqual(decoded.code, "NotFound");

      const refused = yield* Schema.decodeUnknownEffect(
        TmfErrorSubtypes.UnknownField
      )(body).pipe(Effect.flip);

      assert.isDefined(refused);
    })
  );
});
