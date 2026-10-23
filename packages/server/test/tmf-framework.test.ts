/**
 * `tmf-framework` (Contracts 11.1): the generic TMF route machinery over
 * the test-only fixture mapping (`tmf-fixture.ts`), shaped as TMF621's
 * `troubleTicket`: list with filters, paging and `fields`, retrieve,
 * polymorphic create, merge-patch and JSON Patch, delete, `If-Match`, the
 * state map, local classes, and the TMF `Error` with declared statuses.
 * Every response is validated against TMF621's pinned document by the
 * test client (`tmf-oas-contract`).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { asArray, asObject, textOf, apiCallers } from "./api-support.ts";
import { FIXTURE_TICKETS, tmfTestLayer } from "./tmf-fixture.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

/**
 * Creates a ticket through the fixture API.
 * @param caller - The caller.
 * @param body - The TMF body.
 * @returns The created resource.
 */
const createTicket = (caller: TestRequestOptions, body: JsonObject) =>
  Effect.gen(function* createTicketWork() {
    const http = yield* TestHttpClient;

    const created = yield* http.request("POST", FIXTURE_TICKETS, {
      ...caller,
      body: { "@type": "TroubleTicket", ...body },
    });

    assert.strictEqual(created.status, 201, created.text);

    return asObject(created.json);
  });

const merge = (
  caller: TestRequestOptions,
  body: JsonValue,
  headers: Readonly<Record<string, string>> = {}
): TestRequestOptions => ({
  ...caller,
  headers: { "content-type": "application/merge-patch+json", ...headers },
  rawBody: JSON.stringify(body),
});

describe("tmf-framework", () => {
  it("the fixture serves its tickets under a TMF API base path", () => {
    assert.isTrue(FIXTURE_TICKETS.startsWith("/tmf-api/"));
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "creates, reads, lists, patches and deletes a resource through the record service",
      () =>
        Effect.gen(function* crud() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          const created = yield* createTicket(alice, {
            description: "Mail is down",
            name: "Mail",
            severity: "Major",
            status: "acknowledged",
            troubleTicketCharacteristic: [
              { "@type": "StringCharacteristic", name: "site", value: "HQ" },
            ],
          });

          assert.strictEqual(created["@type"], "TroubleTicket");
          assert.strictEqual(created.status, "acknowledged");
          assert.strictEqual(created.description, "Mail is down");
          assert.match(
            textOf(created.href),
            /\/troubleTicket\/[0-9a-f-]{36}$/u
          );
          assert.isUndefined(created.priority);

          const id = textOf(created.id);
          const read = yield* http.get(`${FIXTURE_TICKETS}/${id}`, alice);

          assert.strictEqual(read.status, 200, read.text);
          assert.deepStrictEqual(asObject(read.json), created);
          assert.strictEqual(read.headers.get("etag"), '"1"');

          const listed = yield* http.get(
            `${FIXTURE_TICKETS}?fields=severity`,
            alice
          );

          assert.strictEqual(listed.status, 200, listed.text);
          assert.strictEqual(listed.headers.get("x-result-count"), "1");
          assert.deepStrictEqual(asArray(listed.json), [
            {
              "@type": "TroubleTicket",
              href: created.href ?? null,
              id,
              severity: "Major",
            },
          ]);

          const patched = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            merge(alice, { status: "pending" })
          );

          assert.strictEqual(patched.status, 200, patched.text);
          assert.strictEqual(asObject(patched.json).status, "pending");
          assert.strictEqual(patched.headers.get("etag"), '"2"');

          const deleted = yield* http.request(
            "DELETE",
            `${FIXTURE_TICKETS}/${id}`,
            alice
          );

          assert.strictEqual(deleted.status, 204, deleted.text);

          const gone = yield* http.get(`${FIXTURE_TICKETS}/${id}`, alice);

          assert.strictEqual(gone.status, 404, gone.text);
        })
    );

    dbTest.effect(
      "a stale If-Match is VersionConflict with the declared 409 and the current ETag; none applies to the locked version",
      () =>
        Effect.gen(function* versions() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          const created = yield* createTicket(alice, {
            description: "Printer jam",
          });

          const id = textOf(created.id);

          const fresh = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            merge(alice, { severity: "Minor" }, { "if-match": '"1"' })
          );

          assert.strictEqual(fresh.status, 200, fresh.text);

          const stale = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            merge(alice, { severity: "Major" }, { "if-match": '"1"' })
          );

          assert.strictEqual(stale.status, 409, stale.text);
          assert.strictEqual(asObject(stale.json).code, "VersionConflict");
          assert.strictEqual(stale.headers.get("etag"), '"2"');

          const latest = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            merge(alice, { severity: "Critical" })
          );

          assert.strictEqual(latest.status, 200, latest.text);
          assert.strictEqual(latest.headers.get("etag"), '"3"');
        })
    );

    dbTest.effect(
      "polymorphism: a body's ticketType creates the incident class, and a local child class renders its own @type, the mapped @baseType and its own attribute",
      () =>
        Effect.gen(function* polymorphism() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          const incident = yield* createTicket(alice, {
            description: "Incident",
            ticketType: "incident",
            urgency: 2,
          });

          assert.strictEqual(incident["@type"], "TroubleTicket");
          assert.notProperty(incident, "@baseType");
          assert.strictEqual(incident.urgency, 2);

          const generic = yield* http.get(
            `/api/v1/tmffxIncident/${textOf(incident.id)}`,
            alice
          );

          assert.strictEqual(generic.status, 200, generic.text);

          const vip = yield* createTicket(alice, {
            "@type": "TmffxVip",
            description: "VIP",
            urgency: 1,
            vipLevel: 3,
          });

          assert.strictEqual(vip["@type"], "TmffxVip");
          assert.strictEqual(vip["@baseType"], "TroubleTicket");
          assert.strictEqual(vip.vipLevel, 3);
          assert.strictEqual(vip.urgency, 1);

          // A local attribute can be selected like a mapped one.
          const selected = yield* http.get(
            `${FIXTURE_TICKETS}?@type=TmffxVip&fields=vipLevel`,
            alice
          );

          assert.deepStrictEqual(asArray(selected.json), [
            {
              "@baseType": "TroubleTicket",
              "@type": "TmffxVip",
              href: vip.href ?? null,
              id: vip.id ?? null,
              vipLevel: 3,
            },
          ]);

          const listed = yield* http.get(
            `${FIXTURE_TICKETS}?@type=TmffxVip`,
            alice
          );

          assert.deepStrictEqual(
            asArray(listed.json).map((item) => textOf(asObject(item).id)),
            [textOf(vip.id)]
          );

          const wrongBase = yield* http.request("POST", FIXTURE_TICKETS, {
            ...alice,
            body: {
              "@baseType": "Other",
              "@type": "TmffxVip",
              description: "x",
            },
          });

          assert.strictEqual(wrongBase.status, 400, wrongBase.text);

          const changedType = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${textOf(vip.id)}`,
            merge(alice, { "@type": "TroubleTicket" })
          );

          assert.strictEqual(changedType.status, 400, changedType.text);
          assert.strictEqual(
            asObject(changedType.json).code,
            "ValidationFailed"
          );

          const sameType = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${textOf(vip.id)}`,
            merge(alice, { "@type": "TmffxVip", vipLevel: 4 })
          );

          assert.strictEqual(sameType.status, 200, sameType.text);
          assert.strictEqual(asObject(sameType.json).vipLevel, 4);
        })
    );

    dbTest.effect(
      "filters map onto the condition AST: a state map's filter selects what its rendering shows, and paging and sort follow /api/v1",
      () =>
        Effect.gen(function* filters() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          const states = ["pending", "held", "inProgress", "pending"];

          for (const [index, status] of states.entries()) {
            const created = yield* createTicket(alice, {
              description: `Filter ${index}`,
              name: `F${index}`,
              severity: "FilterSeverity",
            });

            const patched = yield* http.request(
              "PATCH",
              `${FIXTURE_TICKETS}/${textOf(created.id)}`,
              merge(alice, { status })
            );

            assert.strictEqual(patched.status, 200, patched.text);
          }

          for (const status of ["pending", "held", "inProgress"]) {
            const listed = yield* http.get(
              `${FIXTURE_TICKETS}?severity=FilterSeverity&status=${status}`,
              alice
            );

            const rendered = asArray(listed.json).map(
              (item) => asObject(item).status
            );

            assert.strictEqual(listed.status, 200, listed.text);
            assert.isAbove(rendered.length, 0);
            assert.isTrue(
              rendered.every((value) => value === status),
              status
            );
            assert.strictEqual(
              listed.headers.get("x-total-count"),
              String(states.filter((each) => each === status).length)
            );
          }

          const either = yield* http.get(
            `${FIXTURE_TICKETS}?severity=FilterSeverity&status=held,inProgress&sort=-name`,
            alice
          );

          assert.deepStrictEqual(
            asArray(either.json).map((item) => asObject(item).name),
            ["F2", "F1"]
          );

          const page = yield* http.get(
            `${FIXTURE_TICKETS}?severity=FilterSeverity&sort=name&offset=1&limit=2`,
            alice
          );

          assert.deepStrictEqual(
            asArray(page.json).map((item) => asObject(item).name),
            ["F1", "F2"]
          );
          assert.strictEqual(page.headers.get("x-total-count"), "4");
          assert.include(page.headers.get("link") ?? "", 'rel="next"');

          const unknownState = yield* http.get(
            `${FIXTURE_TICKETS}?severity=FilterSeverity&status=nonsense`,
            alice
          );

          assert.deepStrictEqual(asArray(unknownState.json), []);

          const unsortable = yield* http.get(
            `${FIXTURE_TICKETS}?sort=note`,
            alice
          );

          assert.strictEqual(unsortable.status, 400, unsortable.text);

          const arrayFilter = yield* http.get(
            `${FIXTURE_TICKETS}?troubleTicketCharacteristic=x`,
            alice
          );

          assert.strictEqual(arrayFilter.status, 400, arrayFilter.text);
          assert.strictEqual(asObject(arrayFilter.json).code, "InvalidFilter");
        })
    );

    dbTest.effect(
      "errors are TMF Errors with statuses the document declares",
      () =>
        Effect.gen(function* errors() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          const missing = yield* http.request("POST", FIXTURE_TICKETS, {
            ...alice,
            body: { "@type": "TroubleTicket", name: "No description" },
          });

          assert.strictEqual(missing.status, 400, missing.text);
          assert.strictEqual(asObject(missing.json).code, "ValidationFailed");
          assert.strictEqual(asObject(missing.json).status, "400");

          const unknown = yield* http.request("POST", FIXTURE_TICKETS, {
            ...alice,
            body: { "@type": "TroubleTicket", description: "x", nope: 1 },
          });

          assert.strictEqual(unknown.status, 400, unknown.text);
          assert.strictEqual(asObject(unknown.json).code, "UnknownField");

          const notFound = yield* http.get(
            `${FIXTURE_TICKETS}/${RANDOM_ID}`,
            alice
          );

          assert.strictEqual(notFound.status, 404, notFound.text);

          // An ID that is no UUID is the same NotFound on every operation.
          for (const method of ["GET", "PATCH", "DELETE"]) {
            const malformed = yield* http.request(
              method,
              `${FIXTURE_TICKETS}/not-a-uuid`,
              method === "PATCH"
                ? {
                    ...alice,
                    headers: { "content-type": "application/merge-patch+json" },
                    rawBody: "{}",
                  }
                : alice
            );

            assert.strictEqual(malformed.status, 404, malformed.text);
            assert.strictEqual(malformed.text, notFound.text);
          }

          const put = yield* http.request(
            "PUT",
            `${FIXTURE_TICKETS}/${RANDOM_ID}`,
            alice
          );

          assert.strictEqual(put.status, 405, put.text);
          assert.strictEqual(
            put.headers.get("allow"),
            "GET, HEAD, PATCH, DELETE"
          );

          const media = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${RANDOM_ID}`,
            {
              ...alice,
              headers: { "content-type": "text/plain" },
              rawBody: "{}",
            }
          );

          assert.strictEqual(media.status, 400, media.text);

          const jsonPath = yield* http.get(
            `${FIXTURE_TICKETS}?filter=$.x`,
            alice
          );

          assert.strictEqual(jsonPath.status, 501, jsonPath.text);

          const anonymous = yield* http.get(FIXTURE_TICKETS);

          assert.strictEqual(anonymous.status, 401, anonymous.text);
        })
    );

    dbTest.effect(
      "a JSON Patch writes the exact resulting json value; only a merge-patch merges",
      () =>
        Effect.gen(function* exactJson() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;

          const created = yield* createTicket(alice, {
            customData: { keep: 1, remove: 2 },
            description: "Json",
          });

          const path = `${FIXTURE_TICKETS}/${textOf(created.id)}`;

          const patchWith = (contentType: string, body: JsonValue) =>
            http.request("PATCH", path, {
              ...alice,
              headers: { "content-type": contentType },
              rawBody: JSON.stringify(body),
            });

          const removed = yield* patchWith("application/json-patch+json", [
            { op: "remove", path: "/customData/remove" },
          ]);

          assert.strictEqual(removed.status, 200, removed.text);
          assert.deepStrictEqual(asObject(removed.json).customData, {
            keep: 1,
          });

          const replaced = yield* patchWith("application/json-patch+json", [
            { op: "replace", path: "/customData", value: { only: 3 } },
          ]);

          assert.deepStrictEqual(asObject(replaced.json).customData, {
            only: 3,
          });

          const merged = yield* patchWith("application/merge-patch+json", {
            customData: { added: 4 },
          });

          assert.deepStrictEqual(asObject(merged.json).customData, {
            added: 4,
            only: 3,
          });
        })
    );
  });
});
