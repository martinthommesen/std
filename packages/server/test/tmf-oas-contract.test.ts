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
import { TMF621_API } from "@std/tmf/tmf621";
import type { JsonValue } from "@std/values/json-value";
import { Cause, Effect, Exit } from "effect";

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
import { itilLayer } from "./itil-support.ts";
import {
  FIXTURE_BASE,
  FIXTURE_RESOURCE,
  FIXTURE_TICKETS,
  tmfTestLayer,
} from "./tmf-fixture.ts";
import {
  bodyOf,
  JSON_PATCH,
  SPECIFICATIONS as TMF621_SPECIFICATIONS,
  TICKETS as TMF621_TICKETS,
  ticketBody,
  tmf621As,
} from "./tmf621-support.ts";

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
      "the client's fetch checks every exchange too: an undeclared status fails it",
      () =>
        Effect.gen(function* fetchChecked() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          // Until workstream 3H wires the hubs, the hub seam answers 404,
          // which TMF621's hub operations declare only through `default`.
          const viaRequest = yield* Effect.exit(
            http.request("POST", `${FIXTURE_BASE}/hub`, {
              ...alice,
              body: { "@type": "Hub", callback: "https://listener.test/" },
            })
          );

          const viaFetch = yield* Effect.exit(
            Effect.tryPromise(
              async () =>
                await http.fetch(`http://std.test${FIXTURE_BASE}/hub`, {
                  body: JSON.stringify({
                    "@type": "Hub",
                    callback: "https://listener.test/",
                  }),
                  headers: {
                    authorization: `Bearer ${alice.token ?? ""}`,
                    "content-type": "application/json",
                  },
                  method: "POST",
                })
            )
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

describe("tmf-oas-contract-tmf621", () => {
  it("the shipped TMF621 mapping declares exactly its pinned document's statuses for both resources and the hubs", () => {
    const pinned = pinnedContracts().find(
      (contract) => contract.spec === "TMF621"
    );

    assert.strictEqual(pinned?.basePath, TMF621_API.basePath);

    const file = pinned?.file ?? "";

    for (const resource of TMF621_API.resources) {
      for (const [operation, method, template] of OPERATIONS) {
        assert.deepStrictEqual(
          resource.declaredStatuses[operation],
          declaredStatusesOf(
            file,
            method,
            template.replace("/troubleTicket", `/${resource.name}`)
          ),
          `${resource.name} ${operation}`
        );
      }
    }

    assert.deepStrictEqual(TMF621_API.hubStatuses, {
      create: declaredStatusesOf(file, "post", "/hub"),
      delete: declaredStatusesOf(file, "delete", "/hub/{id}"),
      retrieve: declaredStatusesOf(file, "get", "/hub/{id}"),
    });
  });

  layer(itilLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "every TMF621 operation's success and error responses validate against the pinned document",
      () =>
        Effect.gen(function* everyTmf621Response() {
          const http = yield* TestHttpClient;
          const admin = yield* tmf621As("admin");
          const agent = yield* tmf621As("agent");

          // The client fails the test on any response the document does
          // not declare or whose body is off its schema.
          const created = yield* admin.post(
            TMF621_TICKETS,
            ticketBody({ note: [{ text: "first" }] })
          );

          const id = textOf(bodyOf(created).id);
          const item = `${TMF621_TICKETS}/${id}`;

          const specification = yield* admin.post(TMF621_SPECIFICATIONS, {
            "@type": "TroubleTicketSpecification",
            name: "Contract sweep",
          });

          const specificationItem = `${TMF621_SPECIFICATIONS}/${textOf(bodyOf(specification).id)}`;

          const statuses = [
            created.status,
            specification.status,
            (yield* admin.get(TMF621_TICKETS)).status,
            (yield* admin.get(`${TMF621_TICKETS}?fields=severity&limit=2`))
              .status,
            (yield* admin.get(item)).status,
            (yield* admin.patch(item, { status: "inProgress" })).status,
            (yield* admin.patch(
              item,
              [{ op: "replace", path: "/name", value: "swept" }],
              { contentType: JSON_PATCH }
            )).status,
            (yield* admin.get(TMF621_SPECIFICATIONS)).status,
            (yield* admin.get(specificationItem)).status,
            (yield* admin.patch(specificationItem, {
              lifecycleStatus: "active",
            })).status,
            // Errors: 400, 401, 403, 404, 409, 501.
            (yield* admin.post(TMF621_TICKETS, { "@type": "TroubleTicket" }))
              .status,
            (yield* admin.get(`${TMF621_TICKETS}?status.gt=x`)).status,
            (yield* http.get(TMF621_TICKETS)).status,
            (yield* agent.del(item)).status,
            (yield* admin.get(`${TMF621_TICKETS}/${TICKET_ID}`)).status,
            (yield* admin.patch(item, { name: "x" }, { ifMatch: '"1"' }))
              .status,
            (yield* admin.del(item, { ifMatch: '"1"' })).status,
            (yield* admin.get(`${TMF621_TICKETS}?filter=$.x`)).status,
            (yield* admin.del(item)).status,
            (yield* admin.del(specificationItem)).status,
          ];

          assert.deepStrictEqual(
            statuses,
            [
              201, 201, 200, 200, 200, 200, 200, 200, 200, 200, 400, 400, 401,
              403, 404, 409, 409, 501, 204, 204,
            ]
          );
        })
    );
  });
});
