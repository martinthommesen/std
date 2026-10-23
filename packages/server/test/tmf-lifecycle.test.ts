/**
 * `tmf-lifecycle` (Contracts 1.6, 6.4, 11.1; decision 0033): mapped
 * attributes name fields by stable ID, local attributes by their fields'
 * API names, through every lifecycle step of the fields behind them:
 *
 * - a retired mapped field stays readable, and writing it is
 *   `DefinitionRetired`;
 * - a purged mapped field is gone: absent, and writing or filtering on it
 *   is `UnknownField`;
 * - a local attribute renamed, and its old name reused by a new field: a
 *   request stating the revision it was built at is `SchemaChanged` for
 *   the old name, on reads and writes, as on `/api/v2`; a request stating
 *   none is resolved at the current revision.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { addField, change, freshId } from "./schema-support.ts";
import { FF, FIXTURE_TICKETS, tmfTestLayer, VIP } from "./tmf-fixture.ts";
import {
  asArray,
  asObject,
  rename,
  statedRevision,
  textOf,
  v2Callers,
} from "./v2-support.ts";

const REVISION_HEADER = "std-schema-revision";

const versionOf = (id: string) =>
  Effect.gen(function* readVersion() {
    return (yield* (yield* Catalog).refresh).get(id)?.version ?? 0;
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

describe("tmf-lifecycle", () => {
  it("names the purger role it needs", () => {
    assert.isString(BUILT_IN_ROLE_IDS.schema_purger);
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a retired mapped field stays readable and writing it is DefinitionRetired; once purged it is UnknownField",
      () =>
        Effect.gen(function* retiredAndPurged() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;

          const created = yield* http.request("POST", FIXTURE_TICKETS, {
            ...alice,
            body: {
              "@type": "TroubleTicket",
              description: "Lifecycle",
              statusChangeReason: "first",
            },
          });

          assert.strictEqual(created.status, 201, created.text);

          const path = `${FIXTURE_TICKETS}/${textOf(asObject(created.json).id)}`;
          const field = FF.statusReason.id;

          yield* change([
            { id: field, op: "retire", version: yield* versionOf(field) },
          ]);

          const retired = yield* http.get(path, alice);

          assert.strictEqual(
            asObject(retired.json).statusChangeReason,
            "first"
          );

          const written = yield* http.request(
            "PATCH",
            path,
            merge(alice, { statusChangeReason: "second" })
          );

          assert.strictEqual(written.status, 400, written.text);
          assert.strictEqual(asObject(written.json).code, "ValidationFailed");
          assert.deepStrictEqual(
            asArray(asObject(written.json).fieldErrors).map(
              (error) => asObject(error)._tag
            ),
            ["DefinitionRetired"]
          );

          const version = yield* versionOf(field);

          yield* applyChangeSet({
            operations: [
              {
                confirm: { id: field, version },
                id: field,
                op: "purge",
                version,
              },
            ],
            requester: {
              roleIds: [BUILT_IN_ROLE_IDS.schema_purger],
              userId: freshId(),
            },
          });

          const purged = yield* http.get(path, alice);

          assert.strictEqual(purged.status, 200, purged.text);
          assert.notProperty(asObject(purged.json), "statusChangeReason");

          for (const refused of [
            yield* http.request(
              "PATCH",
              path,
              merge(alice, { statusChangeReason: "third" })
            ),
            yield* http.get(
              `${FIXTURE_TICKETS}?statusChangeReason=first`,
              alice
            ),
          ]) {
            assert.strictEqual(refused.status, 400, refused.text);
            assert.strictEqual(asObject(refused.json).code, "UnknownField");
          }
        })
    );

    dbTest.effect(
      "a revision this database never had is SchemaChanged, as on the generic API, also for a request that names no local attribute",
      () =>
        Effect.gen(function* unknownRevision() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;

          const [revision = "0", changeSet = ""] =
            (yield* statedRevision).split(".");

          const future = {
            [REVISION_HEADER]: `${Number(revision) + 100}.${changeSet}`,
          };

          const generic = yield* http.get("/api/v2/tmffxTicket", {
            ...alice,
            headers: future,
          });

          assert.strictEqual(asObject(generic.json).code, "SchemaChanged");

          for (const path of [
            FIXTURE_TICKETS,
            `${FIXTURE_TICKETS}?severity=nothing-matches`,
            `${FIXTURE_TICKETS}?fields=description`,
          ]) {
            const answer = yield* http.get(path, { ...alice, headers: future });

            assert.strictEqual(answer.status, 400, `${path}: ${answer.text}`);
            assert.strictEqual(
              asObject(answer.json).code,
              "SchemaChanged",
              path
            );
          }

          const created = yield* http.request("POST", FIXTURE_TICKETS, {
            ...alice,
            body: { "@type": "TroubleTicket", description: "x" },
            headers: future,
          });

          assert.strictEqual(created.status, 409, created.text);
          assert.strictEqual(asObject(created.json).code, "SchemaChanged");
        })
    );

    dbTest.effect(
      "a local attribute renamed and its name reused: SchemaChanged for a request stating the older revision, the current field without one",
      () =>
        Effect.gen(function* renamedAndReused() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;

          const created = yield* http.request("POST", FIXTURE_TICKETS, {
            ...alice,
            body: { "@type": "TmffxVip", description: "VIP", vipLevel: 1 },
          });

          assert.strictEqual(created.status, 201, created.text);

          const path = `${FIXTURE_TICKETS}/${textOf(asObject(created.json).id)}`;
          const before = yield* statedRevision;

          yield* rename(FF.vipLevel.id, "vip_tier");
          yield* change([
            addField(VIP.id, "vip_level", { kind: "integer" }).op,
          ]);

          const old = { [REVISION_HEADER]: before };

          const write = yield* http.request(
            "PATCH",
            path,
            merge(alice, { vipLevel: 42 }, old)
          );

          assert.strictEqual(write.status, 409, write.text);
          assert.strictEqual(asObject(write.json).code, "SchemaChanged");

          const read = yield* http.get(path, { ...alice, headers: old });

          assert.strictEqual(read.status, 400, read.text);
          assert.strictEqual(asObject(read.json).code, "SchemaChanged");

          // Every JSON Patch operation's path and source is checked before
          // evaluation: a `test`, a `copy` source, a replacement that
          // changes nothing.
          for (const operations of [
            [{ op: "test", path: "/vipLevel", value: 1 }],
            [{ from: "/vipLevel", op: "copy", path: "/urgency" }],
            [{ op: "replace", path: "/vipLevel", value: 1 }],
          ]) {
            const patched = yield* http.request("PATCH", path, {
              ...alice,
              headers: {
                "content-type": "application/json-patch+json",
                ...old,
              },
              rawBody: JSON.stringify(operations),
            });

            assert.strictEqual(patched.status, 409, patched.text);
            assert.strictEqual(asObject(patched.json).code, "SchemaChanged");
          }

          // An explicit selection is checked for what it selects only.
          const unrelated = yield* http.get(`${path}?fields=description`, {
            ...alice,
            headers: old,
          });

          assert.strictEqual(unrelated.status, 200, unrelated.text);

          const listed = yield* http.get(
            `${FIXTURE_TICKETS}?@type=TmffxVip&fields=description`,
            { ...alice, headers: old }
          );

          assert.strictEqual(listed.status, 200, listed.text);

          const current = yield* http.request(
            "PATCH",
            path,
            merge(alice, { vipLevel: 42 })
          );

          assert.strictEqual(current.status, 200, current.text);
          assert.strictEqual(asObject(current.json).vipTier, 1);
          assert.strictEqual(asObject(current.json).vipLevel, 42);
        })
    );
  });
});
