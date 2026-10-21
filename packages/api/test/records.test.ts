/**
 * The shared API definition: record JSON (Contracts 6.6) and the read-side
 * errors (Contracts 3.8).
 */
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { SCHEMA_REVISION_HEADER } from "../src/api.ts";
import { NotFound } from "../src/errors/not-found.ts";
import { UnknownField } from "../src/errors/unknown-field.ts";
import { RecordListSchema, RecordResponseSchema } from "../src/records.ts";

describe("records", () => {
  it("decodes the record JSON of Contracts 6.6", () => {
    const body = {
      record: {
        class: "helpdesk.incident",
        id: "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f",
        labels: { assignee: "Alice Smith", priority: "High" },
        values: {
          active: true,
          assignee: "01920c4e-0000-7000-8000-000000000001",
          description: null,
          due: "2026-10-23",
          estimate: "12.50",
          number: "INC-1001",
          opened_at: "2026-10-20T08:15:30.123Z",
          priority: "2",
        },
        version: 7,
        withheld: ["salary"],
      },
      schemaRevision: 1240,
    };

    const decoded = Schema.decodeUnknownSync(RecordResponseSchema)(body);

    assert.deepStrictEqual(decoded, body);
  });

  it("lists carry a cursor and an optional count", () => {
    const decode = Schema.decodeUnknownSync(RecordListSchema);

    assert.strictEqual(
      decode({ nextCursor: null, records: [], schemaRevision: 3 }).count,
      undefined
    );
    assert.strictEqual(
      decode({ count: 0, nextCursor: null, records: [], schemaRevision: 3 })
        .count,
      0
    );
  });

  it("names the revision header in lower case", () => {
    assert.strictEqual(SCHEMA_REVISION_HEADER, "std-schema-revision");
  });

  it("errors are tagged and carry nothing but what the request named", () => {
    assert.strictEqual(new NotFound()._tag, "NotFound");
    assert.deepStrictEqual(
      Schema.encodeSync(UnknownField)(new UnknownField({ field: "cost" })),
      { _tag: "UnknownField", field: "cost" }
    );
  });
});
