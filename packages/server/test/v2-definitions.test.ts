/**
 * `v2-definitions` (Contracts 1.4, 1.5, 10.5): definitions are written
 * through `/api/v2` as change sets: `applyChangeSet` with several
 * operations and its journal, and generic writes to definition tables
 * (`coreRole`, `coreAccessRule`, `coreRecordRule`), each one change set.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { readsTestLayer } from "./reads-support.ts";
import { ACME, addField } from "./schema-support.ts";
import { asArray, asObject, textOf, V2, v2Callers } from "./v2-support.ts";

const APPLY = "/api/v2/applyChangeSet";
const ROLES = "/api/v2/coreRole";
const ACCESS_RULES = "/api/v2/coreAccessRule";
const MERGE_PATCH = "application/merge-patch+json";

const codeOf = (response: TestResponse): JsonValue | undefined =>
  asObject(response.json).code;

describe("v2-definitions", () => {
  it("names the definition collections", () => {
    assert.strictEqual(ROLES, "/api/v2/coreRole");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "applyChangeSet applies operations as one change set and serves its journal",
      () =>
        Effect.gen(function* applyChangeSet() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const note = addField(ACME.asset, "v2_note", { kind: "text" });

          const applied = yield* http.request("POST", APPLY, {
            ...callers.admin,
            body: { operations: [note.op] },
          });

          assert.strictEqual(applied.status, 201, applied.text);

          const answer = asObject(applied.json);
          const href = textOf(answer.href);

          assert.strictEqual(answer.state, "completed");
          assert.strictEqual(applied.headers.get("location"), href);

          const journal = yield* http.get(
            new URL(href).pathname,
            callers.admin
          );

          assert.strictEqual(journal.status, 200, journal.text);
          assert.strictEqual(asObject(journal.json).id, answer.id);

          // The field is live: a v2 list names it.
          const listed = yield* http.get(
            `${V2.asset}?fields=v2Note`,
            callers.admin
          );

          assert.strictEqual(listed.status, 200, listed.text);

          // Bob may not apply a change set, and gets the journal as missing.
          const byBob = yield* http.request("POST", APPLY, {
            ...callers.bob,
            body: {
              operations: [
                addField(ACME.asset, "bobs_note", { kind: "text" }).op,
              ],
            },
          });

          assert.strictEqual(byBob.status, 403, byBob.text);

          const bobsJournal = yield* http.get(
            new URL(href).pathname,
            callers.bob
          );

          assert.strictEqual(bobsJournal.status, 404, bobsJournal.text);

          const malformed = yield* http.request("POST", APPLY, {
            ...callers.admin,
            body: { operations: [{ op: "noSuchOperation" }] },
          });

          assert.strictEqual(malformed.status, 400, malformed.text);
          assert.strictEqual(codeOf(malformed), "InvalidRequest");
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "a write to a definition table is a change set: create, update and delete a role and a rule naming it",
      () =>
        Effect.gen(function* definitionWrites() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const name = `auditor_${randomUUID().slice(0, 8)}`;

          const created = yield* http.request("POST", ROLES, {
            ...callers.admin,
            body: { label: "Auditor", name },
          });

          assert.strictEqual(created.status, 201, created.text);

          const role = asObject(created.json);
          const rolePath = `${ROLES}/${textOf(role.id)}`;

          assert.strictEqual(role["@type"], "CoreRole");
          assert.strictEqual(role.name, name);

          const rule = yield* http.request("POST", ACCESS_RULES, {
            ...callers.admin,
            body: {
              actions: ["read"],
              effect: "allow",
              roleIds: [textOf(role.id)],
              tableId: ACME.asset,
              target: "records",
            },
          });

          assert.strictEqual(rule.status, 201, rule.text);

          // The rule names the role, which bumps the role's version.
          const current = yield* http.get(rolePath, callers.admin);

          assert.strictEqual(current.status, 200, current.text);

          const relabelled = yield* http.request("PATCH", rolePath, {
            ...callers.admin,
            headers: {
              "content-type": MERGE_PATCH,
              "if-match": current.headers.get("etag") ?? "",
            },
            rawBody: JSON.stringify({ label: "Auditors" }),
          });

          assert.strictEqual(relabelled.status, 200, relabelled.text);
          assert.strictEqual(asObject(relabelled.json).label, "Auditors");

          const jsonPatch = yield* http.request("PATCH", rolePath, {
            ...callers.admin,
            headers: {
              "content-type": "application/json-patch+json",
              "if-match": relabelled.headers.get("etag") ?? "",
            },
            rawBody: JSON.stringify([
              { op: "replace", path: "/label", value: "x" },
            ]),
          });

          assert.strictEqual(jsonPatch.status, 415, jsonPatch.text);

          const stale = yield* http.request("PATCH", rolePath, {
            ...callers.admin,
            headers: { "content-type": MERGE_PATCH, "if-match": '"1"' },
            rawBody: JSON.stringify({ label: "Stale" }),
          });

          assert.strictEqual(stale.status, 412, stale.text);
          assert.strictEqual(codeOf(stale), "VersionConflict");

          const readOnly = yield* http.request("POST", ROLES, {
            ...callers.admin,
            body: { label: "Retired", name: `${name}_2`, state: "retired" },
          });

          // The state is set by retiring, never on create.
          assert.strictEqual(readOnly.status, 422, readOnly.text);
          assert.strictEqual(codeOf(readOnly), "ValidationFailed");

          const unknown = yield* http.request("POST", ROLES, {
            ...callers.admin,
            body: { label: "x", name: `${name}_3`, noSuchAttribute: 1 },
          });

          assert.strictEqual(unknown.status, 400, unknown.text);
          assert.strictEqual(codeOf(unknown), "UnknownField");

          // Bob may not write definitions.
          const byBob = yield* http.request("POST", ROLES, {
            ...callers.bob,
            body: { label: "Bob", name: `${name}_bob` },
          });

          assert.include([403, 404], byBob.status, byBob.text);

          const ruleDeleted = yield* http.request(
            "DELETE",
            `${ACCESS_RULES}/${textOf(asObject(rule.json).id)}`,
            {
              ...callers.admin,
              headers: { "if-match": rule.headers.get("etag") ?? "" },
            }
          );

          assert.strictEqual(ruleDeleted.status, 204, ruleDeleted.text);

          const byName = encodeURIComponent(`name = "${name}"`);

          const roles = yield* http.get(
            `${ROLES}?condition=${byName}`,
            callers.admin
          );

          assert.strictEqual(asArray(roles.json).length, 1);
        }),
      { timeout: 120_000 }
    );
  });
});
