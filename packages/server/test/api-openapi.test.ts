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

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { apiOpenApi } from "../src/http/api/openapi.ts";
import { TMF_ERROR_TAGS } from "../src/http/api/tmf-error.ts";
import {
  patchOptions,
  MERGE_PATCH,
  UNKNOWN_ID,
  asObject,
  textOf,
  API,
} from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";

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
          const { alice: user } = yield* AcmeFixture;

          const alice = {
            token: yield* http.signIn(user.login, user.password),
          };

          const response = yield* http.get("/api/v1/openapi.json", alice);

          assert.strictEqual(response.status, 200, response.text);
          assert.deepStrictEqual(response.json, apiOpenApi);

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
        const { alice: user } = yield* AcmeFixture;
        const alice = { token: yield* http.signIn(user.login, user.password) };

        const body = yield* Schema.decodeEffect(ResourceCreate)({
          name: "Doc",
          status: "spare",
        });

        const created = yield* http.request("POST", API.asset, {
          ...alice,
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
          patchOptions(alice, MERGE_PATCH, patchBody, '"1"')
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
          const { alice: user } = yield* AcmeFixture;

          const alice = {
            token: yield* http.signIn(user.login, user.password),
          };

          const missing = yield* http.get(`${API.asset}/${UNKNOWN_ID}`, alice);

          assert.strictEqual(missing.status, 404);

          const missingError = yield* Schema.decodeUnknownEffect(TmfError)(
            missing.json
          );

          assert.strictEqual(missingError.code, "NotFound");

          const invalid = yield* http.request("POST", API.asset, {
            ...alice,
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
