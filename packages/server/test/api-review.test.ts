/**
 * `v2-review`: proving tests for the review findings on `/api/v1`
 * (Contracts 6.4 and 10): polymorphic create staleness (F2), a merge into
 * a json field the caller cannot read (F3), `fields=!x` staleness (F4),
 * the JSON Patch envelope (F6), `405` per resource shape (F7), API names
 * (F8), the concrete representation (D1) and case-sensitive attribute
 * filters (D4).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Condition } from "@std/definitions/condition";
import type { Operation } from "@std/definitions/operation";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import {
  UNKNOWN_ID,
  MERGE_PATCH,
  JSON_PATCH,
  codeOf,
  changedFields,
  withoutDate,
  patchOptions,
  asArray,
  asObject,
  idsOf,
  rename,
  stale,
  statedRevision,
  textOf,
  API,
  apiCallers,
  withQuery,
} from "./api-support.ts";
import type { ApiCallers } from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { ACME, addAccessRule, addField, change } from "./schema-support.ts";

const changedKinds = (response: TestResponse): string[] =>
  asArray(asObject(response.json).changes).map(
    (entry) =>
      `${textOf(asObject(entry).field)}:${textOf(asObject(entry).kind)}`
  );

const allowOf = (response: TestResponse): string | null =>
  response.headers.get("allow");

const byId = (response: TestResponse): Map<string, JsonObject> =>
  new Map(
    asArray(response.json).map((item) => [
      textOf(asObject(item).id),
      asObject(item),
    ])
  );

const post = (
  caller: TestRequestOptions,
  body: JsonObject
): TestRequestOptions => ({ ...caller, body });

describe("api-review", () => {
  it("names the shapes under test", () => {
    assert.strictEqual(API.laptop, "/api/v1/acmeLaptop");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "F2: a stale polymorphic create through the parent or the child is 409 SchemaChanged and writes nothing",
      () =>
        Effect.gen(function* polymorphicStale() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { alice } = yield* AcmeFixture;

          const childAttr = addField(ACME.laptop, "child_attr", {
            kind: "text",
          });

          yield* change([childAttr.op]);

          const built = yield* statedRevision;

          const before = yield* http.get(API.laptop, callers.admin);

          yield* rename(childAttr.id, "child_attr_old");
          yield* change([
            addField(ACME.laptop, "child_attr", { kind: "text" }).op,
          ]);

          const body: JsonObject = {
            childAttr: "stale",
            name: "Stale laptop",
            owner: alice.id,
            status: "in_use",
          };

          const viaParent = yield* http.request(
            "POST",
            API.asset,
            post(stale(built, callers.admin), {
              ...body,
              "@type": "AcmeLaptop",
            })
          );

          assert.strictEqual(viaParent.status, 409, viaParent.text);
          assert.strictEqual(codeOf(viaParent), "SchemaChanged");
          assert.include(changedFields(viaParent), "childAttrOld");

          const viaChild = yield* http.request(
            "POST",
            API.laptop,
            post(stale(built, callers.admin), body)
          );

          assert.strictEqual(viaChild.status, 409, viaChild.text);
          assert.strictEqual(codeOf(viaChild), "SchemaChanged");
          assert.include(changedFields(viaChild), "childAttrOld");

          const after = yield* http.get(API.laptop, callers.admin);

          assert.deepStrictEqual(idsOf(after), idsOf(before));
        }),
      { timeout: 120_000 }
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "F3: a merge patch merges into a json field the caller may update but not read",
      () =>
        Effect.gen(function* unreadableMerge() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { records } = yield* AcmeFixture;
          const catalog = yield* Catalog;
          const built = yield* catalog.refresh;
          const employee = built.roleByName("employee")?.id ?? "";
          const cfg = addField(ACME.laptop, "cfg", { kind: "json" });

          const rule = (
            description: string,
            effect: "allow" | "deny",
            action: "read" | "update",
            condition?: Condition
          ): Operation => {
            const { op } = addAccessRule(ACME.laptop, [employee], {
              description,
              fields: [cfg.id],
            });

            return op.op === "createAccessRule"
              ? {
                  definition: {
                    ...op.definition,
                    actions: [action],
                    condition: condition ?? op.definition.condition,
                    effect,
                  },
                  op: "createAccessRule",
                }
              : op;
          };

          yield* change([
            cfg.op,
            rule("employees update cfg", "allow", "update"),
            rule("employees read cfg", "allow", "read"),
            rule("employees never read cfg of L", "deny", "read", {
              left: { path: [ACME.name] },
              op: "eq",
              right: { value: "L" },
            }),
          ]);

          const path = `${API.laptop}/${records.L}`;
          const current = asObject((yield* http.get(path, callers.admin)).json);

          const stored = yield* http.request(
            "PATCH",
            path,
            patchOptions(
              callers.admin,
              MERGE_PATCH,
              {
                cfg: { keep: "retained", remove: "old" },
              },
              `"${Number(current.revision)}"`
            )
          );

          assert.strictEqual(stored.status, 200, stored.text);
          assert.deepStrictEqual(asObject(stored.json).cfg, {
            keep: "retained",
            remove: "old",
          });

          const merged = yield* http.request(
            "PATCH",
            path,
            patchOptions(
              callers.bob,
              MERGE_PATCH,
              {
                cfg: { added: "new", remove: null },
              },
              `"${Number(asObject(stored.json).revision)}"`
            )
          );

          assert.strictEqual(merged.status, 200, merged.text);
          // Bob may not read cfg: the response withholds it (Contracts 6.6)
          // and never shows the stored value.
          assert.notProperty(asObject(merged.json), "cfg");
          assert.include(asArray(asObject(merged.json).withheld), "cfg");
          assert.notInclude(merged.text, "retained");

          const bobRead = yield* http.get(path, callers.bob);

          assert.include(asArray(asObject(bobRead.json).withheld), "cfg");
          assert.notInclude(bobRead.text, "retained");

          const after = asObject((yield* http.get(path, callers.admin)).json);

          assert.deepStrictEqual(after.cfg, { added: "new", keep: "retained" });
        }),
      { timeout: 120_000 }
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "F4: fields=!x is stale for the rest of the default selection, and for x itself",
      () =>
        Effect.gen(function* exclusionStale() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const noteA = addField(ACME.asset, "note_a", { kind: "text" });
          const noteB = addField(ACME.asset, "note_b", { kind: "text" });

          yield* change([noteA.op, noteB.op]);

          const first = yield* statedRevision;

          const list = (fields: string, revision: string) =>
            http.get(
              withQuery(API.asset, [["fields", fields]]),
              stale(revision, callers.alice)
            );

          assert.strictEqual((yield* list("!noteB", first)).status, 200);

          yield* rename(noteA.id, "note_a2");

          const unrelated = yield* list("!noteB", first);

          assert.strictEqual(unrelated.status, 409, unrelated.text);
          assert.strictEqual(codeOf(unrelated), "SchemaChanged");
          assert.include(changedFields(unrelated), "noteA2");

          assert.strictEqual((yield* list("name", first)).status, 200);

          const second = yield* statedRevision;

          assert.strictEqual((yield* list("!noteB", second)).status, 200);

          yield* rename(noteB.id, "note_b2");

          // Contracts 6.4: a rename is relevant to a request that names
          // the field, and `!noteB` names it; the caller can name `noteB2`.
          const excluded = yield* list("!noteB", second);

          assert.strictEqual(excluded.status, 409, excluded.text);
          assert.strictEqual(codeOf(excluded), "SchemaChanged");
          assert.include(changedKinds(excluded), "noteB2:fieldRenamed");

          assert.strictEqual((yield* list("name", second)).status, 200);
        }),
      { timeout: 120_000 }
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "F6: a JSON Patch may test id and @type, and may not replace revision",
      () =>
        Effect.gen(function* patchEnvelope() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;

          const created = yield* http.request(
            "POST",
            API.asset,
            post(callers.alice, { name: "Envelope", status: "spare" })
          );

          assert.strictEqual(created.status, 201, created.text);

          const asset = asObject(created.json);
          const path = `${API.asset}/${textOf(asset.id)}`;

          const replaced = yield* http.request(
            "PATCH",
            path,
            patchOptions(
              callers.alice,
              JSON_PATCH,
              [
                { op: "test", path: "/id", value: textOf(asset.id) },
                { op: "replace", path: "/status", value: "x" },
              ],
              '"1"'
            )
          );

          assert.strictEqual(replaced.status, 200, replaced.text);
          assert.strictEqual(asObject(replaced.json).status, "x");

          const typed = yield* http.request(
            "PATCH",
            path,
            patchOptions(
              callers.alice,
              JSON_PATCH,
              [{ op: "test", path: "/@type", value: textOf(asset["@type"]) }],
              '"2"'
            )
          );

          assert.strictEqual(typed.status, 200, typed.text);

          const revision = yield* http.request(
            "PATCH",
            path,
            patchOptions(
              callers.alice,
              JSON_PATCH,
              [{ op: "replace", path: "/revision", value: 9 }],
              '"2"'
            )
          );

          assert.strictEqual(revision.status, 422, revision.text);
          assert.strictEqual(codeOf(revision), "ValidationFailed");
          assert.include(revision.text, "ReadOnlyField");
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "F7: a 405 names the methods of the resource shape",
      () =>
        Effect.gen(function* methodsPerResource() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { records } = yield* AcmeFixture;

          const existing = yield* http.request(
            "POST",
            `${API.asset}/${records.L}`,
            callers.bob
          );

          assert.strictEqual(existing.status, 405, existing.text);
          assert.strictEqual(
            allowOf(existing),
            "GET, HEAD, PATCH, DELETE, OPTIONS"
          );

          const random = yield* http.request(
            "POST",
            `${API.asset}/${UNKNOWN_ID}`,
            callers.bob
          );

          // Bob cannot see Alice's K: it must look like a record that does
          // not exist.
          const hidden = yield* http.request(
            "POST",
            `${API.asset}/${records.K}`,
            callers.bob
          );

          assert.strictEqual(random.status, 405);
          assert.strictEqual(hidden.status, 405);
          assert.strictEqual(random.text, existing.text);
          assert.strictEqual(hidden.text, random.text);
          assert.deepStrictEqual(withoutDate(hidden), withoutDate(random));
          assert.deepStrictEqual(withoutDate(existing), withoutDate(random));

          const expectations = [
            ["PATCH", "/api/v1/session/current", "GET, HEAD, DELETE, OPTIONS"],
            ["GET", "/api/v1/session", "POST, OPTIONS"],
            ["HEAD", "/api/v1/session", "POST, OPTIONS"],
            ["POST", "/api/v1/tableMetadata", "GET, HEAD, OPTIONS"],
            ["PATCH", API.asset, "GET, HEAD, POST, OPTIONS"],
            ["PUT", API.asset, "GET, HEAD, POST, OPTIONS"],
            ["PROPFIND", API.asset, "GET, HEAD, POST, OPTIONS"],
            ["POST", `${API.asset}/${records.L}/history`, "GET, HEAD, OPTIONS"],
          ] as const;

          for (const [method, path, allow] of expectations) {
            const response = yield* http.request(method, path, callers.bob);

            assert.strictEqual(response.status, 405, `${method} ${path}`);
            assert.strictEqual(allowOf(response), allow, `${method} ${path}`);
          }
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "D1: a parent collection shows the concrete type's attributes the caller may read",
      () =>
        Effect.gen(function* concrete() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { records } = yield* AcmeFixture;

          const asAlice = byId(yield* http.get(API.asset, callers.alice));

          assert.strictEqual(asAlice.get(records.L)?.serial, "SN-L");
          assert.strictEqual(asAlice.get(records.K)?.serial, "SN-K");
          assert.strictEqual(asAlice.get(records.L)?.diskKey, "L-DISK-KEY");
          assert.strictEqual(asAlice.get(records.M)?.sizeInches, 24);

          const asBob = byId(yield* http.get(API.asset, callers.bob));

          assert.strictEqual(asBob.get(records.L)?.serial, "SN-L");
          assert.notProperty(asBob.get(records.L) ?? {}, "diskKey");

          const identity = new Set([
            "@baseType",
            "@schemaLocation",
            "@type",
            "href",
            "id",
            "revision",
          ]);

          const named = yield* http.get(
            withQuery(API.asset, [["fields", "name"]]),
            callers.alice
          );

          for (const item of asArray(named.json)) {
            const keys = Object.keys(asObject(item));

            assert.include(keys, "name");
            assert.deepStrictEqual(
              keys.filter((key) => key !== "name" && !identity.has(key)),
              []
            );
          }
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "D4: an attribute filter compares text case-sensitively, condition does not",
      () =>
        Effect.gen(function* caseSensitivity() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { records } = yield* AcmeFixture;

          const lower = yield* http.get(
            withQuery(API.asset, [["name", "k"]]),
            callers.alice
          );

          assert.strictEqual(lower.status, 200, lower.text);
          assert.deepStrictEqual(idsOf(lower), []);

          const exact = yield* http.get(
            withQuery(API.asset, [["name", "K"]]),
            callers.alice
          );

          assert.deepStrictEqual(idsOf(exact), [records.K]);

          const condition = yield* http.get(
            withQuery(API.asset, [["condition", 'name = "k"']]),
            callers.alice
          );

          assert.deepStrictEqual(idsOf(condition), [records.K]);
        }),
      { timeout: 120_000 }
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "F8: API names drop doubled and trailing underscores and a clash is refused",
      () =>
        Effect.gen(function* apiNames() {
          const http = yield* TestHttpClient;
          const callers: ApiCallers = yield* apiCallers;

          yield* change([
            addField(ACME.asset, "due__date", { kind: "date" }).op,
            addField(ACME.asset, "foo_", { kind: "text" }).op,
          ]);

          const created = yield* http.request(
            "POST",
            API.asset,
            post(callers.alice, {
              dueDate: "2026-03-04",
              foo: "bar",
              name: "Named",
              status: "spare",
            })
          );

          assert.strictEqual(created.status, 201, created.text);

          const read = asObject(
            (yield* http.get(
              `${API.asset}/${textOf(asObject(created.json).id)}`,
              callers.alice
            )).json
          );

          assert.strictEqual(read.dueDate, "2026-03-04");
          assert.strictEqual(read.foo, "bar");
          assert.notProperty(read, "due__date");
          assert.notProperty(read, "foo_");

          const refused = yield* Effect.flip(
            change([addField(ACME.asset, "due_date", { kind: "date" }).op])
          );

          assert.strictEqual(refused._tag, "DefinitionInvalid");
          assert.include(JSON.stringify(refused), "apiNameClash");
        }),
      { timeout: 120_000 }
    );
  });
});
