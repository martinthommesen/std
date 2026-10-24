import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { API_PREFIX } from "@std/api/api";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { eventIdOf, recordEventType } from "../src/events/event-id.ts";
import { readEntries } from "../src/outbox/delivery-payload.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { asArray, asObject, textOf, apiCallers } from "./api-support.ts";
import { hubTestLayer, listener, register } from "./hub-support.ts";
import { nextOf } from "./paging.ts";
import { change, addAccessRule } from "./schema-support.ts";

const ASSET = `${API_PREFIX}/acmeAsset`;
const EVENTS = `${TMF688_PREFIX}/topic/record:acmeAsset/event`;

const resourceOf = (event: JsonValue | undefined) =>
  asObject(asObject(asObject(event).event).acmeAsset);

const createAsset = Effect.fn("EventTest.createAsset")(function* createAsset(
  admin: TestRequestOptions
) {
  const http = yield* TestHttpClient;

  const response = yield* http.request("POST", ASSET, {
    ...admin,
    body: { name: "version-1", status: "in_use" },
  });

  assert.strictEqual(response.status, 201, response.text);

  return textOf(asObject(response.json).id);
});

// Deliberately omit images and lookup rows to model history from an old writer.
const history = Effect.fn("EventTest.history")(function* history(
  id: string,
  size: number,
  field: string
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO core.change (id, class_id, version, created_at, created_by, updated_at, updated_by, operation_id, record_id, record_class_id, record_version, kind, actor_id, cause, schema_revision, occurred_at, fields)
    SELECT uuidv7(), c.class_id, 1, c.occurred_at + n * interval '1 millisecond', c.actor_id, c.occurred_at + n * interval '1 millisecond', c.actor_id, c.operation_id, c.record_id, c.record_class_id, n + 1, 'update', c.actor_id, c.cause, c.schema_revision, c.occurred_at + n * interval '1 millisecond', jsonb_build_object(${field}::text, jsonb_build_object('before', 'version-' || n, 'after', 'version-' || (n + 1)))
    FROM core.change c CROSS JOIN generate_series(1, ${size}) n WHERE c.record_id = ${id}::uuid AND c.record_version = 1`;
});

const markLookupPending = Effect.gen(function* markLookupPending() {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM core.platform_migration WHERE id = 22`;
});

const test = it.live;

describe("event history and paging regressions", () => {
  test("unauthorized changes cannot strand a visible older event or expose their IDs in continuation", () =>
    Effect.gen(function* unauthorizedCandidates() {
      const http = yield* TestHttpClient;
      const fixture = yield* AcmeFixture;
      const { admin, bob } = yield* apiCallers;

      const visible = yield* http.request("POST", ASSET, {
        ...admin,
        body: {
          name: "visible",
          owner: { id: fixture.bob.id },
          status: "in_use",
        },
      });

      const hidden = yield* http.request("POST", ASSET, {
        ...admin,
        body: {
          name: "hidden",
          owner: { id: fixture.alice.id },
          status: "in_use",
        },
      });

      const snapshot = yield* (yield* Catalog).refresh;
      const name = snapshot.fieldByName(ACME.asset, "name")?.id ?? "";
      yield* history(textOf(asObject(hidden.json).id), 1005, name);
      const page = yield* http.get(`${EVENTS}?limit=1`, bob);
      assert.lengthOf(asArray(page.json), 0);
      const next = nextOf(page.headers.get("link")) ?? "";
      assert.notInclude(next, textOf(asObject(hidden.json).id));
      assert.strictEqual((yield* http.get(next, admin)).status, 400);
      const follow = yield* http.get(next, bob);
      assert.strictEqual(follow.status, 200, follow.text);
      assert.strictEqual(
        resourceOf(asArray(follow.json)[0]).id,
        asObject(visible.json).id
      );
    }).pipe(Effect.provide(hubTestLayer)));

  test("the full-payload work budget falls back to authorized resource identity without failing the page", () =>
    Effect.gen(function* payloadBudget() {
      const http = yield* TestHttpClient;
      const { admin } = yield* apiCallers;
      const id = yield* createAsset(admin);
      const snapshot = yield* (yield* Catalog).refresh;
      yield* history(
        id,
        130,
        snapshot.fieldByName(ACME.asset, "name")?.id ?? ""
      );
      const page = yield* http.get(`${EVENTS}?limit=130`, admin);
      assert.strictEqual(page.status, 200, page.text);
      assert.lengthOf(asArray(page.json), 130);
      assert.property(resourceOf(asArray(page.json)[99]), "name");

      for (const event of asArray(page.json).slice(100)) {
        assert.sameMembers(Object.keys(resourceOf(event)), [
          "id",
          "href",
          "@type",
        ]);
        assert.strictEqual(resourceOf(event).id, id);
      }
    }).pipe(Effect.provide(hubTestLayer)));

  test("more than 1000 versions list and GET correct early and latest images with bounded reconstruction", () =>
    Effect.gen(function* longHistory() {
      const http = yield* TestHttpClient;
      const sql = yield* SqlClient.SqlClient;
      const log = yield* StatementLog;
      const { admin } = yield* apiCallers;
      const id = yield* createAsset(admin);
      const snapshot = yield* (yield* Catalog).refresh;
      const name = snapshot.fieldByName(ACME.asset, "name")?.id ?? "";
      yield* history(id, 1005, name);
      yield* markLookupPending;
      yield* log.clear;
      const page = yield* http.get(`${EVENTS}?limit=1`, admin);
      assert.strictEqual(page.status, 200, page.text);
      assert.strictEqual(
        resourceOf(asArray(page.json)[0]).name,
        "version-1006"
      );
      assert.lengthOf(
        (yield* log.texts).filter((text) =>
          text.includes('FROM core."change" AS "c"')
        ),
        1
      );
      assert.lengthOf(
        (yield* log.texts).filter((text) =>
          text.includes("WITH history AS MATERIALIZED")
        ),
        1
      );
      const entries = yield* readEntries(id, 1006);
      assert.isAtMost(entries.length, 3);

      const changes =
        yield* sql`SELECT id::text, kind, record_version::text AS version FROM core.change WHERE record_id = ${id}::uuid AND record_version IN (2, 1006) ORDER BY record_version`.pipe(
          Effect.flatMap(
            decodeRows(
              Schema.Struct({
                id: Schema.String,
                kind: Schema.Literals(["create", "update", "delete"]),
                version: Schema.String,
              })
            )
          )
        );

      for (const row of changes) {
        const eventId = eventIdOf(row.id, recordEventType(row.kind));
        yield* log.clear;
        const event = yield* http.get(`${EVENTS}/${eventId}`, admin);
        assert.strictEqual(event.status, 200, event.text);
        assert.strictEqual(
          resourceOf(event.json).name,
          `version-${row.version}`
        );
        const statements = yield* log.texts;
        assert.lengthOf(
          statements.filter((text) =>
            text.includes("core.record_event_id(c.id, c.kind)")
          ),
          1
        );
        // Version 2 can reuse the retained create image; the legacy tail cannot.
        const historyReductions = row.version === "2" ? 0 : 1;
        assert.lengthOf(
          statements.filter((text) =>
            text.includes("WITH history AS MATERIALIZED")
          ),
          historyReductions
        );

        const after = yield* http.get(
          `${EVENTS}?limit=1&after=${eventId}`,
          admin
        );

        assert.strictEqual(after.status, 200, after.text);
        assert.strictEqual(
          resourceOf(asArray(after.json)[0]).name,
          `version-${Number(row.version) - 1}`
        );
      }

      // A real save after the legacy tail captures both images atomically.
      yield* sql`UPDATE acme.asset SET version = 1006, name = 'version-1006' WHERE id = ${id}::uuid`;
      const callback = yield* listener();
      yield* register(admin.token ?? "", callback.origin);

      const saved = yield* http.request("PATCH", `${ASSET}/${id}`, {
        ...admin,
        body: { name: "version-1007" },
        headers: {
          "content-type": "application/merge-patch+json",
          "if-match": '"1006"',
        },
      });

      assert.strictEqual(saved.status, 200, saved.text);
      yield* log.clear;
      const current = yield* readEntries(id, 1007);
      assert.lengthOf(current, 2);
      assert.strictEqual(current.at(-1)?.image?.[name], "version-1007");
      assert.strictEqual(current[0]?.image?.[name], "version-1006");
      assert.lengthOf(
        (yield* log.texts).filter((text) =>
          text.includes('FROM core."change" AS "c"')
        ),
        1
      );
      yield* log.clear;
      yield* workerPass();
      assert.lengthOf(callback.calls, 1);
      assert.strictEqual(
        resourceOf(callback.calls[0]?.body).name,
        "version-1007"
      );
      assert.lengthOf(
        (yield* log.texts).filter((text) =>
          text.includes("WITH history AS MATERIALIZED")
        ),
        0
      );
    }).pipe(Effect.provide(hubTestLayer)));

  test("hidden-only candidates and filtered types fill further batches, and exhausted scans have opaque continuations", () =>
    Effect.gen(function* scanContinuation() {
      const http = yield* TestHttpClient;
      const sql = yield* SqlClient.SqlClient;
      const { admin } = yield* apiCallers;
      const id = yield* createAsset(admin);
      const snapshot = yield* (yield* Catalog).refresh;
      const name = snapshot.fieldByName(ACME.asset, "name")?.id ?? "";
      yield* history(id, 1005, name);

      const first = yield* http.get(
        `${EVENTS}?limit=1&eventType=RecordCreateEvent`,
        admin
      );

      assert.strictEqual(first.status, 200, first.text);
      assert.lengthOf(asArray(first.json), 0);
      assert.isNull(first.headers.get("x-total-count"));
      const next = nextOf(first.headers.get("link"));
      assert.isDefined(next);
      assert.include(next ?? "", "cursor%3A");
      const follow = yield* http.get(next ?? "", admin);
      assert.strictEqual(follow.status, 200, follow.text);
      assert.strictEqual(resourceOf(asArray(follow.json)[0]).name, "version-1");

      // Updates of an unreadable field must not hide the earlier create.
      yield* change([
        addAccessRule(
          ACME.asset,
          [BUILT_IN_ROLE_IDS.admin],
          { fields: [name] },
          { effect: "deny" }
        ).op,
      ]);
      const hidden = yield* http.get(`${EVENTS}?limit=1`, admin);
      assert.lengthOf(asArray(hidden.json), 0);
      assert.isDefined(nextOf(hidden.headers.get("link")));

      const older = yield* http.get(
        nextOf(hidden.headers.get("link")) ?? "",
        admin
      );

      assert.strictEqual(
        asObject(asArray(older.json)[0]).eventType,
        "RecordCreateEvent"
      );

      // Cursor state contains the hidden key only server-side, and is bounded.
      const [count] =
        yield* sql`SELECT count(*)::int AS count FROM core.event_cursor`.pipe(
          Effect.flatMap(decodeRows(Schema.Struct({ count: Schema.Int })))
        );

      assert.isAtLeast(count?.count ?? 0, 2);

      for (const after of [
        "broken",
        randomUUID(),
        "cursor:broken",
        `cursor:${randomUUID()}`,
      ]) {
        assert.strictEqual(
          (yield* http.get(`${EVENTS}?after=${after}`, admin)).status,
          400
        );
      }

      assert.strictEqual(
        (yield* http.get(`${next}&eventType=Other`, admin)).status,
        400
      );
    }).pipe(Effect.provide(hubTestLayer)));

  test("client lists seek newest first beyond 1000 rows and masked rows do not imply completion or false totals", () =>
    Effect.gen(function* clientPaging() {
      const http = yield* TestHttpClient;
      const sql = yield* SqlClient.SqlClient;
      const { admin } = yield* apiCallers;

      const topic = yield* http.request("POST", `${TMF688_PREFIX}/topic`, {
        ...admin,
        body: { name: "many events" },
      });

      const topicId = textOf(asObject(topic.json).id);
      const path = `${TMF688_PREFIX}/topic/${topicId}/event`;

      const created = yield* http.request("POST", path, {
        ...admin,
        body: {
          "@type": "Test",
          event: {},
          eventId: "first",
          eventType: "Test",
        },
      });

      assert.strictEqual(created.status, 201, created.text);
      yield* sql`WITH ids AS (SELECT uuidv7() AS id, n FROM generate_series(1, 1005) n), roots AS (INSERT INTO core.event_resource SELECT ids.id, r.class_id, r.version, r.created_at, r.created_by, r.updated_at, r.updated_by FROM core.event_resource r JOIN core.event e ON e.id = r.id CROSS JOIN ids WHERE e.topic = ${topicId}::uuid RETURNING id) INSERT INTO core.event (id, class_id, topic, payload) SELECT roots.id, ${EVENT_CLASS_IDS.event}::uuid, ${topicId}::uuid, jsonb_build_object('@type', 'Test', 'event', '{}'::jsonb, 'eventId', roots.id::text, 'eventType', 'Test') FROM roots`;

      const [newest] =
        yield* sql`SELECT id::text FROM core.event WHERE topic = ${topicId}::uuid ORDER BY id DESC LIMIT 1`.pipe(
          Effect.flatMap(decodeRows(Schema.Struct({ id: Schema.String })))
        );

      const page = yield* http.get(`${path}?limit=2`, admin);
      assert.strictEqual(page.status, 200, page.text);
      const ids = asArray(page.json).map((row) => textOf(asObject(row).id));
      assert.strictEqual(ids[0], newest?.id);
      assert.isTrue((ids[0] ?? "") > (ids[1] ?? ""));
      assert.isNull(page.headers.get("x-total-count"));

      const next = yield* http.get(
        nextOf(page.headers.get("link")) ?? "",
        admin
      );

      assert.notInclude(
        asArray(next.json).map((row) => textOf(asObject(row).id)),
        ids[1]
      );

      const snapshot = yield* (yield* Catalog).refresh;

      const payload =
        snapshot.fieldByName(EVENT_CLASS_IDS.event, "payload")?.id ?? "";

      yield* change([
        addAccessRule(
          EVENT_CLASS_IDS.event,
          [BUILT_IN_ROLE_IDS.admin],
          { fields: [payload] },
          { effect: "deny" }
        ).op,
      ]);
      const masked = yield* http.get(`${path}?limit=2`, admin);
      assert.lengthOf(asArray(masked.json), 0);
      assert.isNull(masked.headers.get("x-total-count"));
      assert.isDefined(nextOf(masked.headers.get("link")));
      // A completed scan counts authorized rows even when payloads are masked.
      yield* sql`DELETE FROM core.event WHERE topic = ${topicId}::uuid AND id <> ${newest?.id ?? ""}::uuid`;
      const end = yield* http.get(`${path}?limit=2`, admin);
      assert.strictEqual(end.headers.get("x-total-count"), "1");
      assert.isUndefined(nextOf(end.headers.get("link")));
    }).pipe(Effect.provide(hubTestLayer)));
});
