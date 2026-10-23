/**
 * The per-table OpenAPI document accepts the traffic the server accepts
 * (Contracts 6.1, 6.3; decision 0017): real responses of list, get, create
 * and update, and the request bodies the server accepted, validate against
 * the caller's document with a JSON Schema 2020-12 validator.
 *
 * The cases the document must not refuse: the audit fields in every
 * record's values, a `fields` selection with a reference path, a whole
 * record sent back by a form with an unchanged field the caller may not
 * write, and an unchanged hidden choice key on an update.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { AccessRuleDraft } from "@std/definitions/definition";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Effect } from "effect";

import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { statedRevision, stale } from "./api-support.ts";
import { objectOf, signInAll } from "./authz-support.ts";
import { codeOf, readsTestLayer, recordPath } from "./reads-support.ts";
import { addChoice, addField, change, values } from "./schema-support.ts";

const TABLE = "acme.asset";
const RECORDS = "/api/v1/acmeAsset";
const DOCUMENT = "/api/v1/tableMetadata/acmeAsset/openapi.json";

/**
 * JSON Pointer escaping of one reference token (RFC 6901).
 *
 * @param part - The token.
 * @returns The escaped token.
 */
const token = (part: string): string =>
  part.replaceAll("~", "~0").replaceAll("/", "~1");

const pointer = (...parts: readonly string[]): string =>
  `doc#/${parts.map(token).join("/")}`;

const validatorOf = (document: JsonObject, failures: string[]) => {
  // Formats and OpenAPI's own keywords are annotations here; the document
  // is added whole so its `#/components/...` references resolve.
  const ajv = new Ajv2020({ strict: false, validateFormats: false });

  ajv.addSchema({ ...document, $id: "doc" });

  return (ref: string, value: JsonValue, what: string): void => {
    const validate = ajv.compile({ $ref: ref });

    if (validate(value)) {
      return;
    }

    for (const error of validate.errors ?? []) {
      failures.push(
        `${what}: ${ref}: ${error.instancePath} ${error.message ?? ""} ${JSON.stringify(error.params)}`
      );
    }
  };
};

const response = (path: string, method: string, status: string): string =>
  pointer(
    "paths",
    path,
    method,
    "responses",
    status,
    "content",
    "application/json",
    "schema"
  );

const body = (name: "ResourceCreate" | "ResourcePatch"): string =>
  pointer("components", "schemas", name);

const EMPLOYEE = "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b";

const fetchDocument = (session: string) =>
  Effect.gen(function* documentFor() {
    const http = yield* TestHttpClient;

    const doc = yield* http.get(DOCUMENT, {
      token: session,
    });

    assert.strictEqual(doc.status, 200, doc.text);

    return { json: objectOf(doc.json), text: doc.text };
  });

const versionOf = (id: string) =>
  Effect.gen(function* readVersion() {
    const [version] = yield* values(
      "SELECT version::text AS value FROM acme.asset WHERE id = $1::uuid",
      [id]
    );

    return version ?? "0";
  });

describe("per-table OpenAPI document", () => {
  it("escapes JSON Pointer tokens", () => {
    assert.strictEqual(
      pointer("paths", "/api/v1/x", "get"),
      "doc#/paths/~1api~1v1~1x/get"
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("validates the traffic the server accepts", () =>
      Effect.gen(function* traffic() {
        const http = yield* TestHttpClient;
        const { fixture, tokens } = yield* signInAll;
        const grade = addField(ACME.asset, "grade", { kind: "choice" });
        const scrap = addChoice(grade.id, "scrap", { order: 3 });

        yield* change([grade.op]);
        yield* change([addChoice(grade.id, "good", { order: 1 }).op, scrap.op]);

        // Bob's laptop L holds `scrap`, which is then hidden.
        const { L } = fixture.records;

        const set = yield* http.request("PATCH", recordPath(TABLE, L), {
          body: { grade: "scrap" },
          headers: { "if-match": `"${yield* versionOf(L)}"` },
          token: tokens.admin,
        });

        assert.strictEqual(set.status, 200, set.text);

        const scrapVersion =
          (yield* (yield* Catalog).refresh).get(scrap.id)?.version ?? 0;

        yield* change([
          {
            changes: { hidden: true },
            id: scrap.id,
            op: "update",
            version: scrapVersion,
          },
        ]);

        const failures: string[] = [];

        for (const who of ["bob", "admin"] as const) {
          const doc = yield* http.get(DOCUMENT, { token: tokens[who] });

          assert.strictEqual(doc.status, 200, doc.text);
          const documentOf = objectOf(doc.json);
          const check = validatorOf(documentOf, failures);

          const accepted = (sent: TestResponse, status: number): JsonValue => {
            assert.strictEqual(sent.status, status, `${who}: ${sent.text}`);

            return sent.json ?? null;
          };

          check(
            response(RECORDS, "get", "200"),
            accepted(yield* http.get(RECORDS, { token: tokens[who] }), 200),
            `${who} list`
          );
          check(
            response(RECORDS, "get", "200"),
            accepted(
              yield* http.get(
                `${RECORDS}?fields=name,grade,dockedTo,dockedTo.name`,
                { token: tokens[who] }
              ),
              200
            ),
            `${who} list with a path`
          );

          const one = `${RECORDS}/{id}`;

          const read = accepted(
            yield* http.get(recordPath(TABLE, L), { token: tokens[who] }),
            200
          );

          check(response(one, "get", "200"), read, `${who} get`);

          // A form sends the record back whole: `grade` keeps its hidden
          // key, and Bob may not write it (only unchanged is accepted).
          const SYSTEM = new Set([
            "createdBy",
            "creationDate",
            "href",
            "id",
            "lastUpdate",
            "revision",
            "updatedBy",
            "withheld",
          ]);

          // Through the parent collection the record also shows its
          // concrete class's attributes, which a write cannot name.
          const named = objectOf(
            objectOf(objectOf(documentOf.components).schemas).ResourcePatch
          );

          const form: JsonObject = {
            ...Object.fromEntries(
              Object.entries(objectOf(read)).filter(
                ([name]) =>
                  !SYSTEM.has(name) && name in objectOf(named.properties)
              )
            ),
            name: `${who} renamed`,
          };

          const updated = yield* http.request("PATCH", recordPath(TABLE, L), {
            body: form,
            headers: { "if-match": `"${yield* versionOf(L)}"` },
            token: tokens[who],
          });

          check(body("ResourcePatch"), form, `${who} update body`);
          check(
            response(one, "patch", "200"),
            accepted(updated, 200),
            `${who} update`
          );

          // Bob may create assets he owns, naming only fields rule 7 lets
          // him write; the admin also sets a choice.
          const created: JsonObject =
            who === "admin"
              ? { grade: "good", name: "admin's new asset" }
              : { name: "Bob's new asset", owner: fixture.bob.id };

          check(body("ResourceCreate"), created, `${who} create body`);
          check(
            response(RECORDS, "post", "201"),
            accepted(
              yield* http.request("POST", RECORDS, {
                body: created,
                token: tokens[who],
              }),
              201
            ),
            `${who} create`
          );
        }

        assert.deepStrictEqual(failures, []);
      })
    );

    dbTest.effect("states its revision and answers like the metadata", () =>
      Effect.gen(function* revisions() {
        const http = yield* TestHttpClient;
        const { tokens } = yield* signInAll;
        const before = yield* statedRevision;

        const { json: first, text } = yield* fetchDocument(tokens.admin);
        const info = objectOf(first.info);

        assert.strictEqual(info.version, before, text);
        assert.strictEqual(
          first["x-std-schema-revision"],
          Number(before.split(".")[0])
        );

        // An older stated revision is served; a malformed one and one the
        // database never had are refused as the metadata refuses them.
        yield* change([addField(ACME.asset, "later", { kind: "text" }).op]);

        const older = yield* http.get(
          DOCUMENT,
          stale(before, { token: tokens.admin })
        );

        assert.strictEqual(older.status, 200, older.text);

        const malformed = yield* http.get(
          DOCUMENT,
          stale("nope", { token: tokens.admin })
        );

        assert.strictEqual(malformed.status, 400, malformed.text);
        assert.strictEqual(yield* codeOf(malformed), "InvalidSchemaRevision");

        const never = yield* http.get(
          DOCUMENT,
          stale("999.00000000-0000-4000-8000-000000000000", {
            token: tokens.admin,
          })
        );

        assert.strictEqual(never.status, 409, never.text);
        assert.strictEqual(yield* codeOf(never), "SchemaChanged");

        // A missing table is UnknownTable naming the request's segment.
        const missing = yield* http.get(
          "/api/v1/tableMetadata/noSuchTable/openapi.json",
          { token: tokens.admin }
        );

        assert.strictEqual(missing.status, 404, missing.text);
        assert.strictEqual(yield* codeOf(missing), "UnknownTable");
        assert.include(missing.text, "noSuchTable");
      })
    );

    dbTest.effect(
      "accepts write-only fields, empty choice fields and input forms of big integers",
      () =>
        Effect.gen(function* inputForms() {
          const http = yield* TestHttpClient;
          const { fixture, tokens } = yield* signInAll;
          const { L } = fixture.records;
          const empty = addField(ACME.asset, "no_keys", { kind: "choice" });
          const shut = addField(ACME.asset, "all_hidden", { kind: "choice" });
          const big = addField(ACME.asset, "big", { kind: "bigInteger" });

          const closed = addChoice(shut.id, "closed", {
            hidden: true,
            order: 1,
          });

          // Bob may write `cost`, which rule 5 still hides from him.
          const writeCost: AccessRuleDraft = {
            actions: ["update"],
            active: true,
            classId: ACME.asset,
            condition: null,
            description: "employees may write cost without reading it",
            effect: "allow",
            id: randomUUID(),
            kind: "accessRule",
            name: null,
            owner: { layer: "local" },
            protected: false,
            roleIds: [EMPLOYEE],
            target: { fields: [ACME.cost], kind: "fields" },
          };

          yield* change([empty.op, shut.op, big.op]);
          yield* change([
            closed.op,
            { definition: writeCost, op: "createAccessRule" },
          ]);

          const failures: string[] = [];

          // A write-only field: accepted by the server and the document,
          // never named in it.
          const bob = yield* fetchDocument(tokens.bob);
          const checkBob = validatorOf(bob.json, failures);
          const costBody: JsonObject = { cost: "301.00" };

          const costWrite = yield* http.request("PATCH", recordPath(TABLE, L), {
            body: costBody,
            headers: { "if-match": `"${yield* versionOf(L)}"` },
            token: tokens.bob,
          });

          assert.strictEqual(costWrite.status, 200, costWrite.text);
          assert.notInclude(bob.text, '"cost"');
          checkBob(body("ResourcePatch"), costBody, "bob writes cost");

          // Choice fields without a writable key, and a big integer with
          // leading zeros: the server accepts them, so must the document.
          const admin = yield* fetchDocument(tokens.admin);
          const checkAdmin = validatorOf(admin.json, failures);

          const created: JsonObject = {
            allHidden: null,
            big: "0001",
            name: "input forms",
            noKeys: null,
          };

          const posted = yield* http.request("POST", RECORDS, {
            body: created,
            token: tokens.admin,
          });

          assert.strictEqual(posted.status, 201, posted.text);
          checkAdmin(body("ResourceCreate"), created, "admin create");
          checkAdmin(
            response(RECORDS, "post", "201"),
            posted.json ?? null,
            "admin create response"
          );

          assert.deepStrictEqual(failures, []);
        })
    );
  });
});
