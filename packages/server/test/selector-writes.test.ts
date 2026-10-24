import { assert, describe, it, layer } from "@effect/vitest";
import { TMF621_BASE_PATH } from "@std/tmf/tmf621";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import {
  contractAt,
  declaredStatusesOf,
} from "../../testing/src/tmf-oas-contract.ts";
import {
  API,
  apiCallers,
  asObject,
  patchOptions,
  textOf,
  withQuery,
} from "./api-support.ts";
import { itilLayer } from "./itil-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  createFixtureTicket,
  FIXTURE_TICKETS,
  mergeOptions,
  tmfTestLayer,
} from "./tmf-fixture.ts";
import {
  bodyOf,
  SPECIFICATIONS,
  TICKETS,
  ticketBody,
  tmf621As,
} from "./tmf621-support.ts";

const conflictBody = (field: string) => ({
  "@baseType": "Error",
  "@schemaLocation": "/api/v1/openapi.json#/components/schemas/FieldsConflict",
  "@type": "FieldsConflict",
  code: "FieldsConflict",
  field,
  message: "fields includes and excludes the same attribute",
  reason: "fields includes and excludes the same attribute",
  status: "409",
});

describe("selector write responses", () => {
  it("the pinned TMF621 create and patch operations declare 409 on both resources", () => {
    const { file } = contractAt("TMF621", TMF621_BASE_PATH);

    for (const resource of ["troubleTicket", "troubleTicketSpecification"]) {
      assert.include(declaredStatusesOf(file, "post", `/${resource}`), 409);
      assert.include(
        declaredStatusesOf(file, "patch", `/${resource}/{id}`),
        409
      );
    }
  });

  layer(readsTestLayer(), { excludeTestServices: true })((genericTests) => {
    genericTests.effect(
      "generic record and definition writes reject both fields marker orders with exact 409",
      () =>
        Effect.gen(function* genericWriteConflicts() {
          const http = yield* TestHttpClient;
          const { admin } = yield* apiCallers;

          for (const [collection, body] of [
            [API.asset, { name: "selector_asset", status: "spare" }],
            [
              API.laptop,
              {
                name: "selector_laptop",
                purchasedOn: "2026-01-01",
                serial: "selector-original",
              },
            ],
            ["/api/v1/coreRole", { label: "Selector", name: "selector_role" }],
          ] as const) {
            const created = yield* http.request("POST", collection, {
              ...admin,
              body,
            });

            assert.strictEqual(created.status, 201, created.text);
            const path = `${collection}/${textOf(asObject(created.json).id)}`;

            for (const [fields, suffix] of [
              ["name,!name", "included"],
              ["!name,name", "excluded"],
            ] as const) {
              const namedBody = {
                ...body,
                name: `selector_refused_${suffix}`,
              };

              const refusedBody =
                collection === API.laptop
                  ? { ...namedBody, serial: `selector-${suffix}` }
                  : namedBody;

              const post = yield* http.request(
                "POST",
                withQuery(collection, [["fields", fields]]),
                {
                  ...admin,
                  body: refusedBody,
                }
              );

              assert.strictEqual(
                post.status,
                409,
                `${collection}: ${post.text}`
              );
              assert.deepStrictEqual(post.json, conflictBody("name"));

              const current = yield* http.get(path, admin);
              assert.strictEqual(current.status, 200, current.text);

              for (const contentType of collection === "/api/v1/coreRole"
                ? ["application/merge-patch+json"]
                : [
                    "application/merge-patch+json",
                    "application/json-patch+json",
                  ]) {
                const patched = yield* http.request(
                  "PATCH",
                  withQuery(path, [["fields", fields]]),
                  patchOptions(
                    admin,
                    contentType,
                    contentType === "application/json-patch+json"
                      ? [
                          {
                            op: "add",
                            path: "/name",
                            value: `selector_patch_${suffix}`,
                          },
                        ]
                      : { name: `selector_patch_${suffix}` },
                    current.headers.get("etag") ?? ""
                  )
                );

                assert.strictEqual(patched.status, 409, patched.text);
                assert.deepStrictEqual(patched.json, conflictBody("name"));
              }
            }
          }
        })
    );
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((mappedTests) => {
    mappedTests.effect(
      "mapped create and patch responses reject both fields marker orders with exact declared 409",
      () =>
        Effect.gen(function* mappedWriteConflicts() {
          const http = yield* TestHttpClient;

          const alice = {
            token: yield* http.signIn("alice", "alice-password"),
          };

          const ticket = yield* createFixtureTicket(alice, {
            description: "Selector proof",
          });

          for (const fields of [
            "description,!description",
            "!description,description",
          ]) {
            const post = yield* http.request(
              "POST",
              withQuery(FIXTURE_TICKETS, [["fields", fields]]),
              { ...alice, body: { description: "Refused selector" } }
            );

            assert.strictEqual(post.status, 409, post.text);
            assert.deepStrictEqual(post.json, conflictBody("description"));

            for (const contentType of [
              "application/merge-patch+json",
              "application/json-patch+json",
            ]) {
              const patch = yield* http.request(
                "PATCH",
                withQuery(`${FIXTURE_TICKETS}/${textOf(ticket.id)}`, [
                  ["fields", fields],
                ]),
                contentType === "application/merge-patch+json"
                  ? mergeOptions(alice, { description: "Refused selector" })
                  : patchOptions(alice, contentType, [
                      {
                        op: "add",
                        path: "/description",
                        value: "Refused selector",
                      },
                    ])
              );

              assert.strictEqual(patch.status, 409, patch.text);
              assert.deepStrictEqual(patch.json, conflictBody("description"));
            }
          }
        })
    );
  });

  it.effect(
    "shipped TMF621 create and patch responses reject both fields marker orders with exact declared 409",
    () =>
      Effect.gen(function* shippedWriteConflicts() {
        const admin = yield* tmf621As("admin");

        for (const [collection, body, field] of [
          [TICKETS, ticketBody(), "description"],
          [
            SPECIFICATIONS,
            { "@type": "TroubleTicketSpecification", name: "Selector proof" },
            "name",
          ],
        ] as const) {
          const created = yield* admin.post(collection, body);
          assert.strictEqual(created.status, 201, created.text);
          const path = `${collection}/${textOf(bodyOf(created).id)}`;

          for (const fields of [`${field},!${field}`, `!${field},${field}`]) {
            const post = yield* admin.post(
              withQuery(collection, [["fields", fields]]),
              body
            );

            assert.strictEqual(post.status, 409, post.text);
            assert.deepStrictEqual(post.json, conflictBody(field));

            for (const contentType of [
              "application/merge-patch+json",
              "application/json-patch+json",
            ]) {
              const patch = yield* admin.patch(
                withQuery(path, [["fields", fields]]),
                contentType === "application/merge-patch+json"
                  ? { [field]: "Refused selector" }
                  : [
                      {
                        op: "add",
                        path: `/${field}`,
                        value: "Refused selector",
                      },
                    ],
                { contentType, ifMatch: created.headers.get("etag") ?? "" }
              );

              assert.strictEqual(patch.status, 409, patch.text);
              assert.deepStrictEqual(patch.json, conflictBody(field));
            }
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
