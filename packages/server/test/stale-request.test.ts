/**
 * Stale requests on the read side (Contracts 6.2, 6.4): the request header
 * `STD-Schema-Revision`, `InvalidSchemaRevision`, `SchemaChanged` with kind
 * `unknown` for a revision this database never had, and relevant versus
 * irrelevant definition changes since the request's revision.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { listPath, readsTestLayer, tagOf } from "./reads-support.ts";
import { ACME, change } from "./schema-support.ts";

const ChangedBodySchema = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      field: Schema.NullOr(Schema.String),
      kind: Schema.String,
    })
  ),
});

const decodeChanged = Schema.decodeUnknownEffect(ChangedBodySchema);

const FILTER_ON_STATUS = listPath("acme.asset", { filter: 'status = "lost"' });
const SORT_BY_NAME = listPath("acme.asset", { sort: "name" });

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
        assert.strictEqual(yield* tagOf(malformed), "InvalidSchemaRevision");

        const ahead = yield* at(
          revisionHeaderValue({
            changeSetId: built.changeSetId,
            revision: built.revision + 1,
          })
        );

        assert.strictEqual(ahead.status, 409);
        assert.strictEqual(yield* tagOf(ahead), "SchemaChanged");

        const restored = yield* at(
          revisionHeaderValue({
            changeSetId: "019a0000-0000-7000-8000-00000000abcd",
            revision: built.revision,
          })
        );

        assert.strictEqual(restored.status, 409);
        assert.deepStrictEqual(
          (yield* decodeChanged(restored.json)).changes.map(
            (entry) => entry.kind
          ),
          ["unknown"]
        );

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

        assert.strictEqual((yield* at(stated, SORT_BY_NAME)).status, 200);
      }).pipe(Effect.orDie)
    );
  });
});
