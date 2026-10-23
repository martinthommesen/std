/**
 * `v2-openapi` (Contracts 10.1): the served document is derived from the
 * shared `StdApi` definition, has separate request and response schemas,
 * names every error subtype, and a request valid against the shared schemas
 * is accepted by the server.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Resource, ResourceCreate, ResourcePatch } from "@std/api/resource";
import { TmfError, TmfErrorSubtypes } from "@std/api/tmf-error";
import { Effect, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { v2OpenApi } from "../src/http/api/openapi.ts";
import { TMF_ERROR_TAGS } from "../src/http/api/tmf-error.ts";
import { asObject, textOf, API, apiCallers } from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

describe("api-openapi", () => {
  it("has a shared subtype for every error tag the server answers", () => {
    assert.sameMembers(Object.keys(TmfErrorSubtypes), [...TMF_ERROR_TAGS]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "serves the document derived from the shared definition",
      () =>
        Effect.gen(function* servedDocument() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;

          const response = yield* http.get(
            "/api/v1/openapi.json",
            callers.alice
          );

          assert.strictEqual(response.status, 200, response.text);
          assert.deepStrictEqual(response.json, v2OpenApi);

          const schemas = asObject(
            asObject(asObject(response.json).components).schemas
          );

          for (const tag of TMF_ERROR_TAGS) {
            assert.property(schemas, tag);
          }

          const create = asObject(schemas.ResourceCreate);
          const patch = asObject(schemas.ResourcePatch);

          for (const request of [create, patch]) {
            const required = request.required ?? [];

            assert.notInclude(required, "id");
            assert.notInclude(required, "href");
          }

          assert.include(asObject(schemas.Resource).required ?? [], "id");
        })
    );

    dbTest.effect("accepts a request valid against the shared schemas", () =>
      Effect.gen(function* validRequests() {
        const http = yield* TestHttpClient;
        const callers = yield* apiCallers;

        const body = yield* Schema.decodeEffect(ResourceCreate)({
          name: "Doc",
          status: "spare",
        });

        const created = yield* http.request("POST", API.asset, {
          ...callers.alice,
          body,
        });

        assert.strictEqual(created.status, 201, created.text);

        const resource = yield* Schema.decodeUnknownEffect(Resource)(
          created.json
        );

        const patchBody = yield* Schema.decodeEffect(ResourcePatch)({
          name: "Doc 2",
        });

        const patched = yield* http.request(
          "PATCH",
          `${API.asset}/${resource.id}`,
          {
            ...callers.alice,
            headers: {
              "content-type": "application/merge-patch+json",
              "if-match": '"1"',
            },
            rawBody: JSON.stringify(patchBody),
          }
        );

        assert.strictEqual(patched.status, 200, patched.text);

        const patchedResource = yield* Schema.decodeUnknownEffect(Resource)(
          patched.json
        );

        assert.strictEqual(patchedResource.id, resource.id);
        assert.strictEqual(textOf(asObject(patched.json).name), "Doc 2");
      })
    );

    dbTest.effect(
      "answers errors that decode against the shared TmfError",
      () =>
        Effect.gen(function* errorBodies() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;

          const missing = yield* http.get(
            `${API.asset}/${RANDOM_ID}`,
            callers.alice
          );

          assert.strictEqual(missing.status, 404);

          const missingError = yield* Schema.decodeUnknownEffect(TmfError)(
            missing.json
          );

          assert.strictEqual(missingError.code, "NotFound");

          const invalid = yield* http.request("POST", API.asset, {
            ...callers.alice,
            body: { status: "no such choice" },
          });

          assert.strictEqual(invalid.status, 422, invalid.text);

          const invalidError = yield* Schema.decodeUnknownEffect(TmfError)(
            invalid.json
          );

          assert.strictEqual(invalidError.code, "ValidationFailed");
        })
    );
  });
});
