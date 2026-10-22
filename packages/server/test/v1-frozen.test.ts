/**
 * `/api/v1` is frozen and deprecated from Step 3 (Contracts 10.1, 10.7):
 * every response under it carries `Deprecation` (RFC 9745) and a
 * `successor-version` link to `/api/v2`, and its OpenAPI document is the
 * one `v0.0.2` published, apart from the version string.
 */
import { createHash } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { OPENAPI_PATH } from "@std/api/api";
import { toV1DefinitionInvalid } from "@std/api/errors/definition-invalid-v1";
import { DefinitionInvalid } from "@std/definitions/problems";
import { isJsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import {
  V1_DEPRECATED_AT,
  V1_DEPRECATION,
  V1_SUCCESSOR_LINK,
} from "../src/http/v1-frozen.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";

/**
 * SHA-256 of `/api/v1/openapi.json` at `v0.0.2` with `info.version` set to
 * the empty string, serialized as `JSON.stringify` writes it. Computed from
 * `OpenApi.fromApi(StdApi)` at `v0.0.2`'s sources (`packages/api`,
 * `packages/definitions` and `packages/values` did not change between
 * `v0.0.2` and the Step 3 base, 64bb63b4).
 */
const V0_0_2_DOCUMENT_SHA256 =
  "6a7d752c573c3cb041c7ef318f82ea06b8277422fe721b5f49df2a320b963aad";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

const ASSET = "acme.asset";

const assertDeprecated = (response: TestResponse, what: string): void => {
  assert.strictEqual(response.headers.get("deprecation"), V1_DEPRECATION, what);
  assert.strictEqual(response.headers.get("link"), V1_SUCCESSOR_LINK, what);
};

describe("v1-frozen", () => {
  it("states the deprecation as an RFC 9745 date in whole seconds", () => {
    assert.isTrue(Number.isSafeInteger(V1_DEPRECATED_AT));
    assert.strictEqual(V1_DEPRECATION, `@${V1_DEPRECATED_AT}`);
    assert.strictEqual(V1_SUCCESSOR_LINK, '</api/v2>; rel="successor-version"');
  });

  it("shows apiNameClash to v1 clients as a v0.0.2 code", () => {
    const v1 = toV1DefinitionInvalid(
      new DefinitionInvalid({
        problems: [
          { code: "apiNameClash", definitionId: null, message: "clash" },
          { code: "duplicateName", definitionId: null, message: "dup" },
        ],
      })
    );

    assert.deepStrictEqual(
      v1.problems.map((found) => found.code),
      ["invalidName", "duplicateName"]
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "every /api/v1 response carries Deprecation and the successor link",
      () =>
        Effect.gen(function* everyResponse() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("bob", "bob-password");

          const responses = {
            badSignIn: yield* http.request("POST", "/api/v1/auth/sign-in", {
              body: { login: "bob", password: "wrong" },
            }),
            get: yield* http.get(recordPath(ASSET, RANDOM_ID), { token }),
            list: yield* http.get(listPath(ASSET), { token }),
            malformed: yield* http.request(
              "POST",
              "/api/v1/tables/acme.asset/records",
              { rawBody: "{", token }
            ),
            me: yield* http.get("/api/v1/auth/me", { token }),
            metadata: yield* http.get("/api/v1/meta/tables/acme.asset", {
              token,
            }),
            openApi: yield* http.get(OPENAPI_PATH),
            signIn: yield* http.request("POST", "/api/v1/auth/sign-in", {
              body: { login: "bob", password: "bob-password" },
            }),
            unauthenticated: yield* http.get(listPath(ASSET)),
            unknownRoute: yield* http.get("/api/v1/no/such/route", { token }),
          } satisfies Record<string, TestResponse>;

          for (const [what, response] of Object.entries(responses)) {
            assertDeprecated(response, what);
          }

          // Not v1: no deprecation.
          const other = yield* http.get("/api/v2/no-such-route", { token });

          assert.isNull(other.headers.get("deprecation"));
        })
    );

    dbTest.effect(
      "the v1 OpenAPI document is v0.0.2's apart from the version string",
      () =>
        Effect.gen(function* documentFrozen() {
          const http = yield* TestHttpClient;
          const response = yield* http.get(OPENAPI_PATH);
          const document = response.json;

          assert.strictEqual(response.status, 200);
          assert.isTrue(document !== undefined && isJsonObject(document));

          if (document === undefined || !isJsonObject(document)) {
            return;
          }

          const { info } = document;

          const unversioned = {
            ...document,
            info:
              info !== undefined && isJsonObject(info)
                ? { ...info, version: "" }
                : null,
          };

          assert.strictEqual(
            createHash("sha256")
              .update(JSON.stringify(unversioned))
              .digest("hex"),
            V0_0_2_DOCUMENT_SHA256
          );
        })
    );
  });
});
