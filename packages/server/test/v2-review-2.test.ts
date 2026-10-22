/**
 * `v2-review-2`: proving tests for the second review of `/api/v2`
 * (Contracts 6.4 and 10): a concrete representation through a parent
 * collection is stale like the concrete collection (R2-1); resources match
 * their `@schemaLocation`, typed references included (R2-3); history
 * navigation links (R2-4); and `OPTIONS`, `HEAD` and every other method by
 * resource shape (R2-5).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { readsTestLayer } from "./reads-support.ts";
import { ACME, addField, change } from "./schema-support.ts";
import {
  asArray,
  asObject,
  idsOf,
  rename,
  stale,
  statedRevision,
  textOf,
  V2,
  v2Callers,
  withQuery,
} from "./v2-support.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
const MERGE_PATCH = "application/merge-patch+json";

const codeOf = (response: TestResponse): JsonValue | undefined =>
  asObject(response.json).code;

const changedFields = (response: TestResponse): string[] =>
  asArray(asObject(response.json).changes).map((entry) =>
    textOf(asObject(entry).field)
  );

/**
 * A response's `Link` header as relation and URI.
 *
 * @param response - The response.
 * @returns Each relation's URI.
 */
const linksOf = (response: TestResponse): Map<string, string> => {
  const header = response.headers.get("link") ?? "";
  const links = new Map<string, string>();

  for (const part of header === "" ? [] : header.split(", <")) {
    const uriEnd = part.indexOf(">");
    const relStart = part.indexOf('rel="', uriEnd) + 'rel="'.length;

    links.set(
      part.slice(relStart, part.indexOf('"', relStart)),
      part.slice(part.startsWith("<") ? 1 : 0, uriEnd)
    );
  }

  return links;
};

const pathOf = (uri: string): string => new URL(uri).pathname;

const withoutDate = (response: TestResponse): [string, string][] =>
  [...response.headers.entries()].filter(([name]) => name !== "date");

describe("v2-review-2", () => {
  it("reads Link headers", () => {
    const links = linksOf({
      headers: new Headers({
        link: '<https://x/a>; rel="self", <https://x/a/history>; rel="version-history"',
      }),
      json: null,
      status: 200,
      text: "",
    });

    assert.strictEqual(links.get("version-history"), "https://x/a/history");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "R2-1: a child record through its parent collection is stale when the child's selection changed",
      () =>
        Effect.gen(function* concreteStale() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const childNote = addField(ACME.laptop, "child_note", {
            kind: "text",
          });

          yield* change([childNote.op]);

          const laptop = `${V2.laptop}/${records.L}`;
          const before = yield* http.get(laptop, callers.admin);

          const populated = yield* http.request("PATCH", laptop, {
            ...callers.admin,
            headers: {
              "content-type": MERGE_PATCH,
              "if-match": before.headers.get("etag") ?? "",
            },
            rawBody: JSON.stringify({ childNote: "kept" }),
          });

          assert.strictEqual(populated.status, 200, populated.text);

          const stated = yield* statedRevision;

          yield* rename(childNote.id, "child_note_old");

          for (const path of [
            laptop,
            `${V2.asset}/${records.L}`,
            V2.asset,
            withQuery(V2.asset, [["@type", "AcmeLaptop"]]),
          ]) {
            const response = yield* http.get(
              path,
              stale(stated, callers.admin)
            );

            assert.strictEqual(
              response.status,
              409,
              `${path}: ${response.text}`
            );
            assert.strictEqual(codeOf(response), "SchemaChanged", path);
            assert.include(changedFields(response), "childNoteOld", path);
          }

          // Only the classes of records on the page are checked: a page of
          // plain assets is not stale for a laptop field.
          const plain = yield* http.get(
            withQuery(V2.asset, [["status", "lost"]]),
            stale(stated, callers.admin)
          );

          assert.strictEqual(plain.status, 200, plain.text);
          assert.deepStrictEqual(idsOf(plain), [records.S]);

          // Visibility first: Alice's laptop is as missing to Bob as an
          // unknown ID, stale or not.
          const hidden = yield* http.get(
            `${V2.asset}/${records.K}`,
            stale(stated, callers.bob)
          );

          const missing = yield* http.get(
            `${V2.asset}/${RANDOM_ID}`,
            stale(stated, callers.bob)
          );

          assert.strictEqual(hidden.status, 404, hidden.text);
          assert.strictEqual(hidden.text, missing.text);
        }),
      { timeout: 120_000 }
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "R2-3: every resource matches its @schemaLocation, which defines only reference types the caller knows",
      () =>
        Effect.gen(function* schemaLocations() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          for (const [who, caller] of Object.entries(callers)) {
            const ajv = new Ajv2020({ strict: false, validateFormats: false });

            const validators = new Map<
              string,
              ReturnType<Ajv2020["compile"]>
            >();

            const tables = yield* http.get("/api/v2/tableMetadata", caller);

            const knownRefs = new Set([
              "EntityRef",
              ...asArray(tables.json).map(
                (table) => `${textOf(asObject(table).resourceType)}Ref`
              ),
            ]);

            const validatorOf = Effect.fn("V2Review2.validatorOf")(
              function* validatorOf(location: string) {
                const cached = validators.get(location);

                if (cached !== undefined) {
                  return cached;
                }

                const schema = yield* http.get(pathOf(location), caller);

                assert.strictEqual(schema.status, 200, schema.text);

                const document = asObject(schema.json);

                for (const name of Object.keys(asObject(document.$defs))) {
                  assert.isTrue(knownRefs.has(name), `${who}: ${name}`);
                }

                const validate = ajv.compile(document);

                validators.set(location, validate);

                return validate;
              }
            );

            const listed = yield* http.get(V2.asset, caller);

            const viaParent = yield* http.get(
              `${V2.asset}/${records.L}`,
              caller
            );

            const resources: JsonObject[] = [
              ...asArray(listed.json).map((item) => asObject(item)),
              ...(viaParent.status === 200 ? [asObject(viaParent.json)] : []),
            ];

            assert.isAbove(resources.length, 0, who);

            for (const resource of resources) {
              const validate = yield* validatorOf(
                textOf(resource["@schemaLocation"])
              );

              assert.isTrue(
                validate(resource),
                `${who}: ${JSON.stringify(validate.errors)} ${JSON.stringify(resource)}`
              );
            }

            // The owner is a typed reference, and its schema says so.
            const owner = asObject(asObject(resources[0]).owner);

            assert.strictEqual(textOf(owner["@type"]), "CoreUserRef", who);
          }
        }),
      { timeout: 120_000 }
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "R2-4: resources and history entries link the caller's own history",
      () =>
        Effect.gen(function* historyLinks() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const created = yield* http.request("POST", V2.asset, {
            ...callers.alice,
            body: { name: "Linked", status: "spare" },
          });

          assert.strictEqual(created.status, 201, created.text);

          const createdHref = textOf(asObject(created.json).href);
          const createdLinks = linksOf(created);

          assert.strictEqual(
            createdLinks.get("version-history"),
            `${createdHref}/history`
          );

          const createdHistory = yield* http.get(
            `${pathOf(createdHref)}/history`,
            callers.alice
          );

          assert.strictEqual(
            createdLinks.get("latest-version"),
            textOf(asObject(asArray(createdHistory.json).at(-1)).href)
          );

          const laptop = `${V2.laptop}/${records.L}`;

          for (const caller of [callers.bob, callers.admin]) {
            const resource = yield* http.get(laptop, caller);
            const href = textOf(asObject(resource.json).href);
            const links = linksOf(resource);

            const history = yield* http.get(`${laptop}/history`, caller);

            const hrefs = asArray(history.json).map((entry) =>
              textOf(asObject(entry).href)
            );

            assert.isAbove(hrefs.length, 0);
            assert.strictEqual(links.get("version-history"), `${href}/history`);
            assert.strictEqual(links.get("latest-version"), hrefs.at(-1));
            assert.strictEqual(
              linksOf(history).get("latest-version"),
              hrefs.at(-1)
            );

            for (const [index, entryHref] of hrefs.entries()) {
              const entry = yield* http.get(pathOf(entryHref), caller);
              const entryLinks = linksOf(entry);

              assert.strictEqual(entry.status, 200, entry.text);
              assert.strictEqual(entryLinks.get("self"), entryHref);
              assert.strictEqual(
                entryLinks.get("version-history"),
                `${href}/history`
              );
              assert.strictEqual(
                entryLinks.get("latest-version"),
                hrefs.at(-1)
              );
              assert.strictEqual(
                entryLinks.get("predecessor-version"),
                hrefs[index - 1]
              );
              assert.strictEqual(
                entryLinks.get("successor-version"),
                hrefs[index + 1]
              );
            }
          }

          // A record Bob cannot see links nothing: its 404s are those of
          // an unknown ID, entry by entry.
          const aliceHistory = yield* http.get(
            `${V2.laptop}/${records.K}/history`,
            callers.alice
          );

          const [aliceEntry] = asArray(aliceHistory.json);

          const probes = [
            [`${V2.laptop}/${records.K}`, `${V2.laptop}/${RANDOM_ID}`],
            [
              pathOf(textOf(asObject(aliceEntry).href)),
              `${V2.laptop}/${RANDOM_ID}/history/${RANDOM_ID}`,
            ],
          ] as const;

          for (const [hidden, missing] of probes) {
            const asBob = yield* http.get(hidden, callers.bob);
            const unknown = yield* http.get(missing, callers.bob);

            assert.strictEqual(asBob.status, 404, asBob.text);
            assert.isNull(asBob.headers.get("link"));
            assert.strictEqual(asBob.text, unknown.text);
            assert.deepStrictEqual(withoutDate(asBob), withoutDate(unknown));
          }
        }),
      { timeout: 120_000 }
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "R2-5: OPTIONS, HEAD and other methods answer by resource shape, revealing nothing",
      () =>
        Effect.gen(function* byResourceRoute() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const options = yield* http.request("OPTIONS", V2.asset, callers.bob);

          assert.strictEqual(options.status, 204, options.text);
          assert.strictEqual(options.text, "");
          assert.strictEqual(
            options.headers.get("allow"),
            "GET, HEAD, POST, OPTIONS"
          );

          const byId = (method: string, id: string) =>
            http.request(method, `${V2.asset}/${id}`, callers.bob);

          for (const method of ["OPTIONS", "PUT", "PROPFIND"]) {
            const visible = yield* byId(method, records.L);
            const hidden = yield* byId(method, records.K);
            const missing = yield* byId(method, RANDOM_ID);

            assert.strictEqual(
              visible.headers.get("allow"),
              "GET, HEAD, PATCH, DELETE, OPTIONS",
              method
            );
            assert.strictEqual(
              visible.status,
              method === "OPTIONS" ? 204 : 405
            );
            assert.deepStrictEqual(withoutDate(hidden), withoutDate(visible));
            assert.deepStrictEqual(withoutDate(missing), withoutDate(visible));
            assert.strictEqual(hidden.text, visible.text);
            assert.strictEqual(missing.text, visible.text);
          }

          const signIn = yield* http.request("OPTIONS", "/api/v2/session");

          assert.strictEqual(signIn.status, 204);
          assert.strictEqual(signIn.headers.get("allow"), "POST, OPTIONS");

          const anonymous = yield* http.request("OPTIONS", V2.asset);

          assert.strictEqual(anonymous.status, 401);

          const laptop = `${V2.laptop}/${records.L}`;
          const got = yield* http.get(laptop, callers.bob);
          const head = yield* http.request("HEAD", laptop, callers.bob);

          assert.strictEqual(head.status, 200);
          assert.strictEqual(head.text, "");
          assert.strictEqual(head.headers.get("etag"), got.headers.get("etag"));
          assert.strictEqual(
            head.headers.get("content-type"),
            got.headers.get("content-type")
          );
          assert.strictEqual(head.headers.get("link"), got.headers.get("link"));

          const hiddenHead = yield* http.request(
            "HEAD",
            `${V2.laptop}/${records.K}`,
            callers.bob
          );

          const missingHead = yield* http.request(
            "HEAD",
            `${V2.laptop}/${RANDOM_ID}`,
            callers.bob
          );

          assert.strictEqual(hiddenHead.status, 404);
          assert.strictEqual(hiddenHead.text, "");
          assert.deepStrictEqual(
            withoutDate(hiddenHead),
            withoutDate(missingHead)
          );

          for (const path of [
            V2.asset,
            "/api/v2/tableMetadata",
            "/api/v2/session/current",
            `${laptop}/history`,
          ]) {
            const response = yield* http.request("HEAD", path, callers.bob);

            assert.strictEqual(response.status, 200, path);
            assert.strictEqual(response.text, "", path);
          }

          const caller: TestRequestOptions = callers.bob;

          const headOfSession = yield* http.request(
            "HEAD",
            "/api/v2/session",
            caller
          );

          assert.strictEqual(headOfSession.status, 405);
          assert.strictEqual(
            headOfSession.headers.get("allow"),
            "POST, OPTIONS"
          );
        }),
      { timeout: 120_000 }
    );
  });
});
