/**
 * Stale requests on the read side (Contracts 6.2, 6.4): the request header
 * `STD-Schema-Revision`, `InvalidSchemaRevision`, `SchemaChanged` with kind
 * `unknown` for a revision this database never had, and relevant versus
 * irrelevant definition changes since the request's revision.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { Effect, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { codeOf, listPath, readsTestLayer } from "./reads-support.ts";
import { ACME, addField, change, values } from "./schema-support.ts";

const ChangedBodySchema = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      field: Schema.NullOr(Schema.String),
      kind: Schema.String,
      table: Schema.String,
    })
  ),
});

const decodeChanged = Schema.decodeUnknownEffect(ChangedBodySchema);

const FILTER_ON_STATUS = listPath("acme.asset", {
  condition: 'status = "lost"',
});

const SORT_BY_NAME = listPath("acme.asset", { sort: "name" });
const NAME_ONLY = listPath("acme.asset", { fields: "name", sort: "name" });

describe("stale-request", () => {
  it("writes the header as <revision>.<change set ID>", () => {
    assert.strictEqual(
      revisionHeaderValue({
        changeSetId: "019a0000-0000-7000-8000-000000000001",
        revision: 12,
      }),
      "12.019a0000-0000-7000-8000-000000000001"
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("checks the revision a request was built at", () =>
      Effect.gen(function* staleRequests() {
        const http = yield* TestHttpClient;
        const catalog = yield* Catalog;
        const token = yield* http.signIn("bob", "bob-password");

        const at = (revision: string, path = FILTER_ON_STATUS) =>
          http.get(path, {
            headers: { "std-schema-revision": revision },
            token,
          });

        const built = yield* catalog.refresh;
        const stated = revisionHeaderValue(built);

        assert.strictEqual((yield* at(stated)).status, 200);

        const malformed = yield* at("12.not-a-uuid");
        assert.strictEqual(malformed.status, 400);
        assert.strictEqual(yield* codeOf(malformed), "InvalidSchemaRevision");

        const ahead = yield* at(
          revisionHeaderValue({
            changeSetId: built.changeSetId,
            revision: built.revision + 1,
          })
        );

        assert.strictEqual(ahead.status, 409);
        assert.strictEqual(yield* codeOf(ahead), "SchemaChanged");

        const restored = yield* at(
          revisionHeaderValue({
            changeSetId: "019a0000-0000-7000-8000-00000000abcd",
            revision: built.revision,
          })
        );

        assert.strictEqual(restored.status, 409);
        // Every field in scope (the filter's and the default selection's)
        // counts as changed, with kind unknown.
        const unknown = (yield* decodeChanged(restored.json)).changes;
        assert.isTrue(unknown.every((entry) => entry.kind === "unknown"));
        assert.isTrue(unknown.some((entry) => entry.field === "status"));
        assert.isFalse(unknown.some((entry) => entry.field === "cost"));

        // A label change is not relevant.
        const status = built.field(ACME.status);
        assert.isDefined(status);

        yield* change([
          {
            changes: { label: "Condition" },
            id: ACME.status,
            op: "update",
            version: status?.version ?? 1,
          },
        ]);

        assert.strictEqual((yield* at(stated)).status, 200);

        // Making status required is relevant to a request naming status,
        // and to no other.
        const relabelled = yield* catalog.refresh;

        yield* change([
          {
            changes: { required: true },
            id: ACME.status,
            op: "update",
            version: relabelled.field(ACME.status)?.version ?? 1,
          },
        ]);

        const stale = yield* at(stated);
        assert.strictEqual(stale.status, 409);

        const { changes } = yield* decodeChanged(stale.json);
        assert.isTrue(
          changes.some(
            (entry) =>
              entry.field === "status" && entry.kind === "requiredChanged"
          )
        );

        // The default selection names status too (no `fields`).
        const byDefault = yield* at(stated, SORT_BY_NAME);
        assert.strictEqual(byDefault.status, 409);
        assert.isTrue(
          (yield* decodeChanged(byDefault.json)).changes.some(
            (entry) => entry.field === "status"
          )
        );

        // An explicit selection without status is not affected.
        assert.strictEqual((yield* at(stated, NAME_ONLY)).status, 200);
      }).pipe(Effect.orDie)
    );

    dbTest.effect("checks the fields of reference targets", () =>
      Effect.gen(function* targetFields() {
        const http = yield* TestHttpClient;
        const catalog = yield* Catalog;
        const token = yield* http.signIn("bob", "bob-password");

        const laptopRef = addField(ACME.asset, "laptop_ref", {
          kind: "reference",
          targetClassId: ACME.laptop,
        });

        yield* change([laptopRef.op]);

        const built = yield* catalog.refresh;
        const stated = revisionHeaderValue(built);

        const at = (query: Readonly<Record<string, string>>) =>
          http.get(listPath("acme.asset", query), {
            headers: { "std-schema-revision": stated },
            token,
          });

        const path = { fields: "name,laptopRef.serial" };
        const labelled = { fields: "name,dockedTo" };

        assert.strictEqual((yield* at(path)).status, 200);

        yield* change([
          {
            changes: { readOnly: true },
            id: ACME.serial,
            op: "update",
            version: built.field(ACME.serial)?.version ?? 1,
          },
        ]);

        const stale = yield* at(path);
        assert.strictEqual(stale.status, 409);
        assert.deepStrictEqual(
          (yield* decodeChanged(stale.json)).changes.map((entry) => [
            entry.field,
            entry.kind,
          ]),
          [["serial", "readOnlyChanged"]]
        );

        // A reference reads the target's display field: name.
        assert.strictEqual((yield* at(labelled)).status, 200);

        const relabel = yield* catalog.refresh;

        yield* change([
          {
            changes: { readOnly: true },
            id: ACME.name,
            op: "update",
            version: relabel.field(ACME.name)?.version ?? 1,
          },
        ]);

        const label = yield* at({ fields: "dockedTo" });
        assert.strictEqual(label.status, 409);
      }).pipe(Effect.orDie)
    );

    dbTest.effect("matches names only on the class they were used on", () =>
      Effect.gen(function* qualifiedNames() {
        const http = yield* TestHttpClient;
        const catalog = yield* Catalog;
        const token = yield* http.signIn("alice", "alice-password");
        const built = yield* catalog.refresh;
        const stated = revisionHeaderValue(built);

        const at = (fields: string) =>
          http.get(listPath("acme.monitor", { fields }), {
            headers: { "std-schema-revision": stated },
            token,
          });

        // r2_novel is added to laptops, which monitors never read (the
        // request used the name on monitors); r2_missing is added to
        // assets, which the request named through docked_to before it
        // existed.
        yield* change([
          addField(ACME.laptop, "r2_novel", { kind: "text" }).op,
          addField(ACME.asset, "r2_missing", { kind: "text" }).op,
        ]);

        const unrelated = yield* at("name,r2Novel,dockedTo.name");
        assert.strictEqual(unrelated.status, 400);
        assert.strictEqual(yield* codeOf(unrelated), "UnknownField");

        const added = yield* at("name,dockedTo.r2Missing");
        assert.strictEqual(added.status, 409);
        assert.deepStrictEqual(
          (yield* decodeChanged(added.json)).changes.map((entry) => [
            entry.table,
            entry.field,
            entry.kind,
          ]),
          [["acme.asset", "r2Missing", "fieldAdded"]]
        );
      }).pipe(Effect.orDie)
    );

    dbTest.effect("a rename in the journal matches the old name", () =>
      Effect.gen(function* journalRename() {
        const http = yield* TestHttpClient;
        const catalog = yield* Catalog;
        const token = yield* http.signIn("bob", "bob-password");
        const built = yield* catalog.refresh;
        const stated = revisionHeaderValue(built);

        // Planted history: at R+1 the field now called status was renamed
        // from condition (workstream 1A writes such journal entries).
        const [revision = ""] = yield* values(
          "UPDATE core.config_state SET revision = revision + 1, change_set_id = uuidv7() RETURNING revision::text AS value"
        );

        yield* values(
          `INSERT INTO core."schema_change" (id, class_id, version, created_at, created_by, updated_at, updated_by,
             requester_id, source, operations, state, first_revision, last_revision, committed_at, completed_at)
           SELECT change_set_id, $1::uuid, 1, now(), $2::uuid, now(), $2::uuid,
             $2::uuid, '{"kind":"api"}'::jsonb, $3::jsonb, 'completed', $4::int8, $4::int8, now(), now()
           FROM core.config_state RETURNING id::text AS value`,
          [
            PLATFORM_CLASS_IDS.schema_change,
            SYSTEM_USER_ID,
            JSON.stringify([
              {
                kind: "field",
                newName: "status",
                oldName: "condition",
                op: "update",
                targetId: ACME.status,
                version: 1,
              },
            ]),
            revision,
          ]
        );

        const at = (fields: string) =>
          http.get(listPath("acme.asset", { fields }), {
            headers: { "std-schema-revision": stated },
            token,
          });

        const renamed = yield* at("name,condition");
        assert.strictEqual(renamed.status, 409);
        assert.deepStrictEqual(
          (yield* decodeChanged(renamed.json)).changes.map((entry) => [
            entry.field,
            entry.kind,
          ]),
          [["status", "fieldRenamed"]]
        );

        assert.strictEqual((yield* at("name")).status, 200);
      }).pipe(Effect.orDie)
    );
  });
});
