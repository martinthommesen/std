/**
 * `api-contract` (Contracts 10.1): the server and the shared `StdApi`
 * definition, which `/api/v1/openapi.json` is generated from, cannot drift.
 *
 * - The test client checks every `/api/v1` response of every suite against
 *   the definition (`packages/testing/src/api-contract.ts`): a documented
 *   status, and a body that decodes with that status's schemas. This file
 *   drives every documented endpoint to a success and to an error, so each
 *   is checked at least once.
 * - The server checks request bodies against the shared request schemas
 *   before anything else reads them (`request-schemas.ts`): a body the
 *   document refuses is `400 InvalidRequest`.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { API_PREFIX } from "@std/api/api";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import {
  checkApiExchange,
  API_ENDPOINTS,
  apiEndpointOf,
} from "../../testing/src/api-contract.ts";
import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { asArray, asObject, textOf, API, apiCallers } from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { ACME, addField } from "./schema-support.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
const MERGE_PATCH = "application/merge-patch+json";
const JSON_PATCH = "application/json-patch+json";

type Outcome = "success" | "error";

const codeOf = (response: TestResponse): JsonValue | undefined =>
  asObject(response.json).code;

const patchOptions = (
  caller: TestRequestOptions,
  contentType: string,
  body: JsonValue,
  ifMatch?: string
): TestRequestOptions => ({
  ...caller,
  headers:
    ifMatch === undefined
      ? { "content-type": contentType }
      : { "content-type": contentType, "if-match": ifMatch },
  rawBody: JSON.stringify(body),
});

describe("api-contract", () => {
  it("finds the documented endpoint of a request as the router does", () => {
    assert.strictEqual(
      apiEndpointOf("GET", "/api/v1/session/current")?.name,
      "session.current"
    );
    assert.strictEqual(
      apiEndpointOf("GET", "/api/v1/tableMetadata/acmeAsset?x=1")?.name,
      "tableMetadata.get"
    );
    assert.strictEqual(
      apiEndpointOf("GET", `/api/v1/acmeAsset/${RANDOM_ID}`)?.name,
      "records.get"
    );
    assert.isUndefined(apiEndpointOf("PUT", "/api/v1/acmeAsset"));
  });

  it.effect("refuses a body that does not match the documented schema", () =>
    Effect.gen(function* refusesDrift() {
      const undocumented = yield* checkApiExchange({
        json: { "@type": "Session", id: "current" },
        method: "GET",
        path: "/api/v1/session/current",
        status: 200,
        text: "{}",
      }).pipe(Effect.flip);

      assert.include(undocumented, "session.current");

      const status = yield* checkApiExchange({
        json: { code: "NotFound" },
        method: "GET",
        path: "/api/v1/openapi.json",
        status: 404,
        text: "{}",
      }).pipe(Effect.flip);

      assert.include(status, "does not document status 404");
    })
  );

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "every documented endpoint answers a success and an error as documented",
      () =>
        Effect.gen(function* everyEndpoint() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const seen = new Map<string, Set<Outcome>>();

          // One exchange; the client has checked it against the definition.
          const exchange = Effect.fn("V2Contract.exchange")(function* send(
            method: string,
            path: string,
            options: TestRequestOptions,
            status: number
          ) {
            const response = yield* http.request(method, path, options);

            assert.strictEqual(
              response.status,
              status,
              `${method} ${path}: ${response.text}`
            );

            const name = apiEndpointOf(method, path)?.name ?? "";
            const outcomes = seen.get(name) ?? new Set<Outcome>();

            outcomes.add(status < 400 ? "success" : "error");
            seen.set(name, outcomes);

            return response;
          });

          // Sessions.
          const signedIn = yield* exchange(
            "POST",
            "/api/v1/session",
            { body: { login: "bob", password: "bob-password" } },
            201
          );

          const token = textOf(asObject(signedIn.json).token);

          yield* exchange(
            "POST",
            "/api/v1/session",
            { body: { login: "bob", password: "wrong-password" } },
            401
          );
          yield* exchange("GET", "/api/v1/session/current", { token }, 200);
          yield* exchange("GET", "/api/v1/session/current", {}, 401);
          yield* exchange("DELETE", "/api/v1/session/current", { token }, 204);
          yield* exchange("DELETE", "/api/v1/session/current", { token }, 401);

          // Table metadata and the document.
          yield* exchange("GET", "/api/v1/tableMetadata", callers.bob, 200);
          yield* exchange("GET", "/api/v1/tableMetadata", {}, 401);

          for (const suffix of ["", "/schema.json", "/openapi.json"]) {
            yield* exchange(
              "GET",
              `/api/v1/tableMetadata/acmeAsset${suffix}`,
              callers.bob,
              200
            );
            yield* exchange(
              "GET",
              `/api/v1/tableMetadata/noSuchTable${suffix}`,
              callers.bob,
              404
            );
          }

          yield* exchange("GET", "/api/v1/openapi.json", {}, 200);
          yield* exchange(
            "GET",
            "/api/v1/openapi.json",
            { headers: { "std-schema-revision": "not a revision" } },
            400
          );

          // Change sets.
          const applied = yield* exchange(
            "POST",
            "/api/v1/applyChangeSet",
            {
              ...callers.admin,
              body: {
                operations: [
                  addField(ACME.asset, "contract_note", { kind: "text" }).op,
                ],
              },
            },
            201
          );

          // Nothing to change: no change set is recorded.
          yield* exchange(
            "POST",
            "/api/v1/applyChangeSet",
            { ...callers.admin, body: { operations: [] } },
            200
          );
          yield* exchange(
            "POST",
            "/api/v1/applyChangeSet",
            {
              ...callers.bob,
              body: {
                operations: [
                  addField(ACME.asset, "bob_note", { kind: "text" }).op,
                ],
              },
            },
            403
          );
          yield* exchange(
            "GET",
            new URL(textOf(asObject(applied.json).href)).pathname,
            callers.admin,
            200
          );
          yield* exchange(
            "GET",
            `/api/v1/applyChangeSet/${RANDOM_ID}`,
            callers.admin,
            404
          );

          // Collections and resources.
          yield* exchange("GET", API.asset, callers.alice, 200);
          yield* exchange(
            "GET",
            `${API.asset}?noSuchName=1`,
            callers.alice,
            400
          );

          const created = yield* exchange(
            "POST",
            API.asset,
            { ...callers.alice, body: { name: "Contract", status: "spare" } },
            201
          );

          yield* exchange(
            "POST",
            API.asset,
            { ...callers.alice, body: { status: "no such choice" } },
            422
          );

          const path = `${API.asset}/${textOf(asObject(created.json).id)}`;

          yield* exchange("GET", path, callers.alice, 200);
          yield* exchange(
            "GET",
            `${API.asset}/${RANDOM_ID}`,
            callers.alice,
            404
          );

          yield* exchange(
            "PATCH",
            path,
            patchOptions(callers.alice, MERGE_PATCH, { name: "C2" }, '"1"'),
            200
          );
          yield* exchange(
            "PATCH",
            path,
            patchOptions(
              callers.alice,
              JSON_PATCH,
              [{ op: "replace", path: "/name", value: "C3" }],
              '"2"'
            ),
            200
          );
          yield* exchange(
            "PATCH",
            path,
            patchOptions(callers.alice, MERGE_PATCH, { name: "C4" }),
            428
          );

          const history = yield* exchange(
            "GET",
            `${path}/history`,
            callers.alice,
            200
          );

          yield* exchange(
            "GET",
            `${API.asset}/${RANDOM_ID}/history`,
            callers.alice,
            404
          );

          const [first] = asArray(history.json);

          yield* exchange(
            "GET",
            `${path}/history/${textOf(asObject(first).id)}`,
            callers.alice,
            200
          );
          yield* exchange(
            "GET",
            `${path}/history/${RANDOM_ID}`,
            callers.alice,
            404
          );

          yield* exchange(
            "DELETE",
            path,
            { ...callers.alice, headers: { "if-match": '"1"' } },
            412
          );
          yield* exchange(
            "DELETE",
            path,
            { ...callers.alice, headers: { "if-match": '"3"' } },
            204
          );

          const dead = yield* seedDeadLetters(callers.admin);
          yield* exchange("GET", "/api/v1/deadDelivery", callers.admin, 200);
          yield* exchange("GET", "/api/v1/deadDelivery", callers.bob, 404);
          yield* exchange(
            "GET",
            `/api/v1/deadDelivery/${dead.firstId}`,
            callers.admin,
            200
          );
          yield* exchange(
            "GET",
            "/api/v1/deadDelivery/9223372036854775807",
            callers.admin,
            404
          );

          for (const [taskPath, deliveryId] of [
            ["retryDeadDelivery", dead.firstId],
            ["discardDeadDelivery", dead.secondId],
          ]) {
            const options = {
              ...callers.admin,
              body: { deliveryId: deliveryId ?? "" },
            };

            yield* exchange("POST", `/api/v1/${taskPath}`, options, 200);
            yield* exchange("POST", `/api/v1/${taskPath}`, options, 404);
          }

          const hubPath = `${API_PREFIX}/hub`;

          const hub = yield* exchange(
            "POST",
            hubPath,
            {
              ...callers.admin,
              body: {
                "@type": "Hub",
                callback: "https://example.com/events",
                query: "resource=acmeAsset",
              },
            },
            201
          );

          yield* exchange("POST", hubPath, {}, 401);
          const registeredHubPath = `${hubPath}/${textOf(asObject(hub.json).id)}`;
          yield* exchange("GET", registeredHubPath, callers.admin, 200);
          yield* exchange("GET", `${hubPath}/${RANDOM_ID}`, callers.admin, 404);
          yield* exchange("DELETE", registeredHubPath, callers.admin, 204);
          yield* exchange("DELETE", registeredHubPath, callers.admin, 404);

          for (const endpoint of API_ENDPOINTS) {
            assert.sameMembers(
              [...(seen.get(endpoint.name) ?? [])],
              ["success", "error"],
              endpoint.name
            );
          }
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "refuses a request body the shared request schemas refuse",
      () =>
        Effect.gen(function* requestSchemas() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;

          const refusals = [
            yield* http.request("POST", API.asset, {
              ...callers.alice,
              body: { "@type": 5, name: "Typed" },
            }),
            yield* http.request("POST", API.asset, {
              ...callers.alice,
              body: [{ name: "In a list" }],
            }),
            yield* http.request("POST", "/api/v1/session", {
              body: { login: 5, password: "bob-password" },
            }),
            yield* http.request("POST", "/api/v1/session", {
              body: {
                login: "bob",
                password: "bob-password",
                tokenDelivery: 1,
              },
            }),
          ];

          const created = yield* http.request("POST", API.asset, {
            ...callers.alice,
            body: { name: "Schemas", status: "spare" },
          });

          assert.strictEqual(created.status, 201, created.text);

          const path = `${API.asset}/${textOf(asObject(created.json).id)}`;

          refusals.push(
            yield* http.request(
              "PATCH",
              path,
              patchOptions(callers.alice, MERGE_PATCH, ["name"], '"1"')
            ),
            yield* http.request(
              "PATCH",
              path,
              patchOptions(
                callers.alice,
                JSON_PATCH,
                [{ op: "rename", path: "/name" }],
                '"1"'
              )
            ),
            yield* http.request(
              "PATCH",
              path,
              patchOptions(
                callers.alice,
                JSON_PATCH,
                [{ op: "replace", path: 7, value: "x" }],
                '"1"'
              )
            )
          );

          for (const refused of refusals) {
            assert.strictEqual(refused.status, 400, refused.text);
            assert.strictEqual(codeOf(refused), "InvalidRequest", refused.text);
            assert.strictEqual(
              textOf(asObject(refused.json).parameter),
              "body",
              refused.text
            );
          }

          const unchanged = yield* http.get(path, callers.alice);

          assert.strictEqual(textOf(asObject(unchanged.json).name), "Schemas");
        })
    );
  });
});
