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
import type { ChoiceDraft } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { objectOf, signInAll } from "./authz-support.ts";
import { readsTestLayer, recordPath } from "./reads-support.ts";
import { ACME, addField, change, values } from "./schema-support.ts";

const local = { owner: { layer: "local" }, protected: false } as const;
const TABLE = "acme.asset";
const RECORDS = `/api/v1/tables/${TABLE}/records`;

const choice = (fieldId: string, key: string, order: number): ChoiceDraft => ({
  ...local,
  fieldId,
  hidden: false,
  id: randomUUID(),
  key,
  kind: "choice",
  label: key,
  order,
});

const createChoice = (definition: ChoiceDraft): Operation => ({
  definition,
  op: "createChoice",
});

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

/** A validator for the caller's document. */
interface DocumentValidator {
  /** Errors of a value against the schema at a pointer, or none. */
  readonly errors: (ref: string, value: JsonValue) => string[];
}

const validatorOf = (document: JsonObject): DocumentValidator => {
  // Formats and OpenAPI's own keywords are annotations here; the document
  // is added whole so its `#/components/...` references resolve.
  const ajv = new Ajv2020({ strict: false, validateFormats: false });

  ajv.addSchema({ ...document, $id: "doc" });

  return {
    errors: (ref, value) => {
      const validate = ajv.compile({ $ref: ref });

      return validate(value)
        ? []
        : (validate.errors ?? []).map(
            (error) =>
              `${ref}: ${error.instancePath} ${error.message ?? ""} ${JSON.stringify(error.params)}`
          );
    },
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

const body = (name: "CreateBody" | "UpdateBody"): string =>
  pointer("components", "schemas", name);

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
        const scrap = choice(grade.id, "scrap", 3);

        yield* change([grade.op]);
        yield* change([
          createChoice(choice(grade.id, "good", 1)),
          createChoice(scrap),
        ]);

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
        let documentOf: JsonObject = {};

        const check = (ref: string, value: JsonValue, what: string) => {
          for (const error of validatorOf(documentOf).errors(ref, value)) {
            failures.push(`${what}: ${error}`);
          }
        };

        for (const who of ["bob", "admin"] as const) {
          const doc = yield* http.get(
            `/api/v1/meta/tables/${TABLE}/openapi.json`,
            {
              token: tokens[who],
            }
          );

          assert.strictEqual(doc.status, 200, doc.text);
          documentOf = objectOf(doc.json);

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
                `${RECORDS}?fields=name,grade,docked_to,docked_to.name&labels=true`,
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
          const AUDIT = new Set([
            "created_at",
            "created_by",
            "updated_at",
            "updated_by",
          ]);

          const record = objectOf(objectOf(read).record);

          const form: JsonObject = {
            ...Object.fromEntries(
              Object.entries(objectOf(record.values)).filter(
                ([name]) => !AUDIT.has(name)
              )
            ),
            name: `${who} renamed`,
          };

          const updated = yield* http.request("PATCH", recordPath(TABLE, L), {
            body: form,
            headers: { "if-match": `"${yield* versionOf(L)}"` },
            token: tokens[who],
          });

          check(body("UpdateBody"), form, `${who} update body`);
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

          check(body("CreateBody"), created, `${who} create body`);
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
  });
});
