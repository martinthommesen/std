import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import filePath from "node:path";

/**
 * `tmf-oas-contract` (Contracts 11.1, 11.6): the generic harness that
 * validates every response of a mapped TMF API against its pinned OpenAPI
 * document. The test HTTP client runs it on every exchange of every suite
 * (`packages/testing/src/tmf-oas-contract.ts`); this suite proves the
 * harness refuses what the document does not declare, and that a mapping's
 * declared statuses are its document's.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { TmfOperation } from "@std/tmf/mapping";
import { tmfStatusFor } from "@std/tmf/status";
import type { JsonValue } from "@std/values/json-value";
import { Cause, Effect, Exit, Schema } from "effect";
import { parse } from "yaml";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { isRfc3339DateTime } from "../../testing/src/rfc3339.ts";
import {
  contractAt,
  declaredStatusesOf,
  pinnedContracts,
  tmfExchangeProblem,
} from "../../testing/src/tmf-oas-contract.ts";
import type { TmfExchange } from "../../testing/src/tmf-oas-contract.ts";
import { asObject, textOf, apiCallers } from "./api-support.ts";
import {
  FIXTURE_API,
  FIXTURE_BASE,
  FIXTURE_RESOURCE,
  FIXTURE_TICKETS,
  tmfTestLayer,
} from "./tmf-fixture.ts";

const CONTRACT = contractAt("TMF621", FIXTURE_BASE);
const TICKET_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
const HREF = `https://std.test${FIXTURE_TICKETS}/${TICKET_ID}`;

const exchange = (
  method: string,
  path: string,
  status: number,
  json?: JsonValue
): TmfExchange => ({
  json,
  method,
  path,
  status,
  text: json === undefined ? "" : JSON.stringify(json),
});

const problemOf = (value: TmfExchange) => tmfExchangeProblem([CONTRACT], value);

const TICKET = {
  "@type": "TroubleTicket",
  description: "Mail is down",
  href: HREF,
  id: TICKET_ID,
  status: "acknowledged",
};

const OPERATIONS: readonly (readonly [TmfOperation, string, string])[] = [
  ["list", "get", "/troubleTicket"],
  ["create", "post", "/troubleTicket"],
  ["retrieve", "get", "/troubleTicket/{id}"],
  ["patch", "patch", "/troubleTicket/{id}"],
  ["delete", "delete", "/troubleTicket/{id}"],
];

// Pair the fixture routes with TMF688's contract deliberately. POST /topic
// returns 404, which that operation's explicit error declarations exclude.
const mismatchedContractFailures = Effect.fn("Test.mismatchedContractFailures")(
  function* mismatchedContractFailures(token: string) {
    const http = yield* TestHttpClient;
    const uncheckedPath = `${FIXTURE_BASE}/topic`;

    const requestFailure = yield* Effect.exit(
      http.request("POST", uncheckedPath, { token })
    );

    const fetchFailure = yield* Effect.exit(
      Effect.tryPromise(
        async () =>
          await http.fetch(`http://std.test${uncheckedPath}`, {
            headers: { authorization: `Bearer ${token}` },
            method: "POST",
          })
      )
    );

    return [requestFailure, fetchFailure] as const;
  },
  Effect.provide(
    TestHttpClient.layerWith({
      contracts: [contractAt("TMF688", FIXTURE_BASE)],
      tmfApis: [FIXTURE_API],
    })
  )
);

describe("tmf-oas-contract", () => {
  it("knows every pinned Open API's base path and document", () => {
    const specs = pinnedContracts().map((contract) => contract.spec);

    assert.includeMembers(specs, ["TMF621", "TMF688", "TMF632"]);
  });

  it("a mapping's declared statuses are exactly its pinned document's", () => {
    for (const [operation, method, template] of OPERATIONS) {
      assert.deepStrictEqual(
        FIXTURE_RESOURCE.declaredStatuses[operation],
        declaredStatusesOf(CONTRACT.file, method, template),
        operation
      );
    }
  });

  it("accepts a declared status with a body of its schema", () => {
    assert.isUndefined(
      problemOf(exchange("GET", FIXTURE_TICKETS, 200, [TICKET]))
    );
    assert.isUndefined(
      problemOf(exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 200, TICKET))
    );
    assert.isUndefined(
      problemOf(exchange("DELETE", `${FIXTURE_TICKETS}/${TICKET_ID}`, 204))
    );
    // A local class's own `@type` validates against the base schema.
    assert.isUndefined(
      problemOf(
        exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 200, {
          ...TICKET,
          "@baseType": "TroubleTicket",
          "@type": "LocalVipIncident",
          vipLevel: 2,
        })
      )
    );
  });

  it("refuses an undeclared status, a body off its schema, a missing required attribute and a path the document lacks", () => {
    const undeclared = problemOf(
      exchange("PATCH", `${FIXTURE_TICKETS}/${TICKET_ID}`, 422, {
        "@type": "Error",
        code: "ValidationFailed",
        reason: "Field values are invalid",
      })
    );

    assert.include(undeclared, "does not declare status 422");

    const badEnum = problemOf(
      exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 200, {
        ...TICKET,
        status: "open",
      })
    );

    assert.isString(badEnum);

    const noType = problemOf(
      exchange("GET", FIXTURE_TICKETS, 200, [
        { description: "x", href: HREF, id: TICKET_ID },
      ])
    );

    assert.isString(noType);

    const noHref = problemOf(
      exchange("GET", FIXTURE_TICKETS, 200, [
        { "@type": "TroubleTicket", id: TICKET_ID },
      ])
    );

    assert.isString(noHref);

    const badDate = problemOf(
      exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 200, {
        ...TICKET,
        creationDate: "yesterday",
      })
    );

    assert.isString(badDate);

    const badNote = problemOf(
      exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 200, {
        ...TICKET,
        note: [{ id: "1", text: "no @type" }],
      })
    );

    assert.isString(badNote);

    const errorWithoutCode = problemOf(
      exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 404, {
        "@type": "Error",
        reason: "missing code",
      })
    );

    assert.isString(errorWithoutCode);

    const noOperation = problemOf(
      exchange("GET", `${FIXTURE_BASE}/troubleTicketReport`, 200, [])
    );

    assert.include(noOperation, "no such operation");
  });

  it("default Error covers hub failures only when no explicit errors are declared", () => {
    const error = {
      "@type": "Error",
      code: "NotFound",
      reason: "Missing",
      status: "404",
    };

    assert.isUndefined(
      problemOf(exchange("GET", `${FIXTURE_BASE}/hub/${TICKET_ID}`, 404, error))
    );
    assert.isString(
      problemOf(
        exchange("GET", `${FIXTURE_BASE}/hub/${TICKET_ID}`, 404, {
          "@type": "Error",
        })
      )
    );
    assert.include(
      problemOf(
        exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 418, {
          ...error,
          status: "418",
        })
      ),
      "does not declare status 418"
    );
    assert.include(
      problemOf(
        exchange("DELETE", `${FIXTURE_BASE}/hub/${TICKET_ID}`, 429, error)
      ),
      "does not declare status 429"
    );
    assert.isUndefined(
      problemOf(
        exchange("POST", `${FIXTURE_BASE}/hub`, 429, {
          ...error,
          code: "TooManyRequests",
          status: "429",
        })
      )
    );
  });

  it.effect(
    "explicit main-resource errors reject a default-only status even when default Error is present",
    () =>
      Effect.gen(function* explicitErrors() {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() =>
            mkdtempSync(filePath.join(tmpdir(), "std-tmf-contract-"))
          ),
          (created) =>
            Effect.sync(() => {
              rmSync(created, { force: true, recursive: true });
            })
        );

        const specs = new URL("../../tmf/specs/", import.meta.url).pathname;

        const stored: unknown = parse(
          readFileSync(filePath.join(specs, CONTRACT.file), "utf-8")
        );

        const parsed = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
          stored
        );

        const paths = asObject(parsed.paths);
        const resource = asObject(paths["/troubleTicket/{id}"]);
        const operation = asObject(resource.get);

        // This pin lists explicit errors without a default. Add default Error
        // to a disposable copy to prove the precedence rule when both exist.
        const document = {
          ...parsed,
          paths: {
            ...paths,
            "/troubleTicket/{id}": {
              ...resource,
              get: {
                ...operation,
                responses: {
                  ...asObject(operation.responses),
                  default: { $ref: "#/components/responses/Error" },
                },
              },
            },
          },
        };

        const file = filePath.join(directory, "contract.json");
        writeFileSync(file, JSON.stringify(document));
        const contract = { ...CONTRACT, file: filePath.relative(specs, file) };

        const error = {
          "@type": "Error",
          code: "NotFound",
          reason: "Missing",
          status: "404",
        };

        assert.isUndefined(
          tmfExchangeProblem(
            [contract],
            exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 404, error)
          )
        );

        assert.include(
          tmfExchangeProblem(
            [contract],
            exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 418, {
              ...error,
              status: "418",
            })
          ),
          "does not declare status 418"
        );
      }).pipe(Effect.scoped)
  );

  it("checks date-times as RFC 3339 with calendar and time ranges", () => {
    for (const valid of [
      "2026-10-23T10:00:00.000Z",
      "2024-02-29T23:59:59+01:00",
      "2026-10-23t10:00:00z",
      "2016-12-31T23:59:60Z",
      "2017-01-01T00:59:60+01:00",
    ]) {
      assert.isTrue(isRfc3339DateTime(valid), valid);
    }

    for (const invalid of [
      "2026-99-99T99:99:99Z",
      "2026-02-29T10:00:00Z",
      "2026-04-31T10:00:00Z",
      "2026-10-23T24:00:00Z",
      "2026-10-23T10:60:00Z",
      "2026-10-23T10:00:60Z",
      "2026-10-23T10:00:00+24:00",
      "2026-10-23 10:00:00Z",
      "2026-10-23T10:00:00",
    ]) {
      assert.isFalse(isRfc3339DateTime(invalid), invalid);
    }

    const impossible = problemOf(
      exchange("GET", `${FIXTURE_TICKETS}/${TICKET_ID}`, 200, {
        ...TICKET,
        creationDate: "2026-99-99T99:99:99Z",
      })
    );

    assert.isString(impossible);
  });

  it("maps STD's statuses onto the declared ones", () => {
    const { patch } = FIXTURE_RESOURCE.declaredStatuses;
    const { retrieve } = FIXTURE_RESOURCE.declaredStatuses;

    assert.strictEqual(tmfStatusFor("VersionConflict", 412, patch), 409);
    assert.strictEqual(tmfStatusFor("ValidationFailed", 422, patch), 400);
    assert.strictEqual(tmfStatusFor("InvalidReference", 422, patch), 400);
    assert.strictEqual(tmfStatusFor("UnsupportedMediaType", 415, patch), 400);
    assert.strictEqual(tmfStatusFor("PatchTestFailed", 409, patch), 409);
    assert.strictEqual(tmfStatusFor("SchemaChanged", 409, retrieve), 400);
    assert.strictEqual(tmfStatusFor("NotFound", 404, retrieve), 404);
    assert.strictEqual(tmfStatusFor("SchemaBusy", 503, retrieve), 503);
    assert.strictEqual(tmfStatusFor("VersionConflict", 412, [400, 412]), 412);
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "every response of the fixture API validates against TMF621's document",
      () =>
        Effect.gen(function* everyResponse() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* apiCallers;

          // The client fails the test on any response the document does
          // not declare; these requests reach every operation and error.
          const created = yield* http.request("POST", FIXTURE_TICKETS, {
            ...alice,
            body: {
              "@type": "TroubleTicket",
              description: "Everything",
              note: [{ "@type": "Note", author: "Alice", text: "n" }],
              relatedParty: [
                {
                  "@type": "RelatedPartyRefOrPartyRoleRef",
                  partyOrPartyRole: {
                    "@type": "PartyRef",
                    id: (yield* AcmeFixture).alice.id,
                  },
                  role: "assignee",
                },
              ],
              severity: "Minor",
              troubleTicketCharacteristic: [
                { "@type": "IntegerCharacteristic", name: "seats", value: 3 },
              ],
            },
          });

          assert.strictEqual(created.status, 201, created.text);

          const id = textOf(asObject(created.json).id);
          const statuses: number[] = [created.status];

          for (const [method, path, caller] of [
            ["GET", FIXTURE_TICKETS, alice],
            ["GET", `${FIXTURE_TICKETS}?offset=0&limit=1`, alice],
            [
              "GET",
              `${FIXTURE_TICKETS}?status=acknowledged&fields=status`,
              alice,
            ],
            ["GET", `${FIXTURE_TICKETS}/${id}`, alice],
            ["HEAD", `${FIXTURE_TICKETS}/${id}`, alice],
            ["GET", `${FIXTURE_TICKETS}/${id}?fields=none`, bob],
            ["GET", `${FIXTURE_TICKETS}?priority=x`, bob],
            ["GET", `${FIXTURE_TICKETS}?status.gt=x`, alice],
            ["GET", `${FIXTURE_TICKETS}?limit=0`, alice],
            ["DELETE", FIXTURE_TICKETS, alice],
          ] as const) {
            statuses.push((yield* http.request(method, path, caller)).status);
          }

          const patched = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            {
              ...alice,
              headers: { "content-type": "application/merge-patch+json" },
              rawBody: JSON.stringify({ description: null }),
            }
          );

          statuses.push(patched.status);

          const deleted = yield* http.request(
            "DELETE",
            `${FIXTURE_TICKETS}/${id}`,
            alice
          );

          statuses.push(deleted.status);

          assert.deepStrictEqual(
            statuses,
            [201, 200, 200, 200, 200, 200, 200, 400, 400, 400, 405, 400, 204]
          );
        })
    );

    dbTest.effect(
      "mapped hub paths register, retrieve and unregister through request and fetch",
      () =>
        Effect.gen(function* mappedHubs() {
          const http = yield* TestHttpClient;
          const { admin, bob } = yield* apiCallers;

          const created = yield* http.request("POST", `${FIXTURE_BASE}/hub`, {
            ...admin,
            body: {
              "@type": "Hub",
              callback: "https://listener.test/callback",
              query: "description=Mail",
            },
          });

          assert.strictEqual(created.status, 201, created.text);
          const id = textOf(asObject(created.json).id);
          const path = `${FIXTURE_BASE}/hub/${id}`;
          assert.strictEqual(
            created.headers.get("location"),
            `http://localhost${path}`
          );
          const retrieved = yield* http.get(path, admin);
          assert.strictEqual(retrieved.status, 200, retrieved.text);
          assert.deepStrictEqual(retrieved.json, created.json);
          const hidden = yield* http.get(path, bob);
          assert.strictEqual(hidden.status, 404);

          const removed = yield* Effect.promise(
            async () =>
              await http.fetch(`http://std.test${path}`, {
                headers: { authorization: `Bearer ${admin.token ?? ""}` },
                method: "DELETE",
              })
          );

          assert.strictEqual(removed.status, 204);
          assert.strictEqual(
            yield* Effect.promise(async () => await removed.text()),
            ""
          );
          const missing = yield* http.get(path, admin);
          assert.strictEqual(missing.status, 404);
          assert.strictEqual(hidden.text, missing.text);
        })
    );

    dbTest.effect(
      "the client's fetch checks every exchange too: an undeclared status fails it",
      () =>
        Effect.gen(function* fetchChecked() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          const [viaRequest, viaFetch] = yield* mismatchedContractFailures(
            alice.token ?? ""
          );

          assert.isTrue(Exit.isFailure(viaRequest));
          assert.isTrue(Exit.isFailure(viaFetch));
          assert.include(
            Exit.isFailure(viaFetch) ? Cause.pretty(viaFetch.cause) : "",
            "does not declare status 404"
          );

          // A declared answer through fetch keeps normal Response semantics.
          const listed = yield* Effect.promise(
            async () =>
              await http.fetch(`http://std.test${FIXTURE_TICKETS}`, {
                headers: { authorization: `Bearer ${alice.token ?? ""}` },
              })
          );

          assert.strictEqual(listed.status, 200);
          assert.isArray(
            yield* Effect.promise(async () => await listed.json())
          );
        })
    );
  });
});
