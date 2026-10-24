import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import {
  EVENT_CLASS_IDS,
  EVENT_PAYLOAD_FIELD_ID,
} from "@std/definitions/event-ids";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { Cause, DateTime, Effect, Exit, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { withoutBody } from "../src/http/api/methods.ts";
import { jsonAnswerWithMetadata } from "../src/http/representation.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { asArray, asObject, textOf, UNKNOWN_ID } from "./api-support.ts";
import { edgeRequest, edgeServer } from "./http-edge-support.ts";
import { hubTestLayer } from "./hub-support.ts";
import { addAccessRule, change } from "./schema-support.ts";
import { patch } from "./writes-support.ts";

const PAYLOAD = {
  "@type": "StoredEvent",
  event: { message: "first" },
  eventId: "stored-date",
  eventTime: "2020-01-01T00:00:00Z",
  eventType: "Stored",
};

// The alias remains Effect-aware and lets Sonar recognize the test file.
const test = it.effect;

const storedEvent = Effect.gen(function* storedEvent() {
  const http = yield* TestHttpClient;
  const token = yield* http.signIn("ada", "ada-password");

  const topic = yield* http.request("POST", `${TMF688_PREFIX}/topic`, {
    body: { name: "modification provenance" },
    token,
  });

  assert.strictEqual(topic.status, 201, topic.text);
  const topicId = textOf(asObject(topic.json).id);
  const path = `${TMF688_PREFIX}/topic/${topicId}/event/${PAYLOAD.eventId}`;

  const created = yield* http.request(
    "POST",
    `${TMF688_PREFIX}/topic/${topicId}/event`,
    {
      body: PAYLOAD,
      token,
    }
  );

  assert.strictEqual(created.status, 201, created.text);
  assert.isNull(created.headers.get("last-modified"));
  const sql = yield* SqlClient.SqlClient;

  const [row] =
    yield* sql`SELECT id::text AS id FROM core.event WHERE topic = ${topicId}::uuid`.pipe(
      Effect.flatMap(decodeRows(Schema.Struct({ id: Schema.String })))
    );

  assert.isDefined(row);

  if (row === undefined) {
    return yield* Effect.die(new Error("Stored event is missing"));
  }

  return { http, path, recordId: row.id, token, topicId };
});

describe("client-event-last-modified", () => {
  test("omits unknown provenance and preserves response metadata", () =>
    Effect.gen(function* unknownDate() {
      const response = yield* jsonAnswerWithMetadata(
        { value: "stored" },
        200,
        {},
        {
          "cache-control": "no-store",
          etag: '"kept"',
        }
      );

      assert.isUndefined(response.headers["last-modified"]);
      assert.strictEqual(response.headers.etag, '"kept"');
      assert.strictEqual(response.headers["cache-control"], "no-store");
    }));

  it.effect(
    "formats HTTP dates at second precision and clamps future evidence to Date",
    () =>
      Effect.gen(function* datePrecision() {
        yield* TestClock.setTime(
          DateTime.makeUnsafe("2026-10-24T12:00:00.123Z").epochMilliseconds
        );

        for (const [source, expected] of [
          ["1900-01-01T00:00:00.000Z", "Mon, 01 Jan 1900 00:00:00 GMT"],
          ["2024-01-01T00:00:00.100Z", "Mon, 01 Jan 2024 00:00:00 GMT"],
          ["2024-01-01T00:00:00.999Z", "Mon, 01 Jan 2024 00:00:00 GMT"],
          ["2026-10-24T12:00:00.123Z", "Sat, 24 Oct 2026 12:00:00 GMT"],
          ["9999-12-31T23:59:59.999Z", "Sat, 24 Oct 2026 12:00:00 GMT"],
        ] as const) {
          const response = yield* jsonAnswerWithMetadata({ source }, 200, {
            modifiedAt: DateTime.makeUnsafe(source),
          });

          assert.strictEqual(
            response.headers.date,
            "Sat, 24 Oct 2026 12:00:00 GMT"
          );
          assert.strictEqual(response.headers["last-modified"], expected);
          assert.deepStrictEqual(
            withoutBody(response).headers,
            response.headers
          );
        }
      })
  );

  it.effect("rejects pre-1900 modification evidence with HTTP context", () =>
    Effect.gen(function* unrepresentableDate() {
      yield* TestClock.setTime(
        DateTime.makeUnsafe("2026-10-24T12:00:00Z").epochMilliseconds
      );

      for (const source of [
        "0001-01-01T00:00:00.000Z",
        "1899-12-31T23:59:59.999Z",
      ]) {
        const exit = yield* jsonAnswerWithMetadata({}, 200, {
          modifiedAt: DateTime.makeUnsafe(source),
        }).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));

        if (Exit.isFailure(exit)) {
          const message = Cause.pretty(exit.cause);
          assert.include(message, "Last-Modified");
          assert.include(message, "HTTP-date");
          assert.include(message, "1900..9999");
          assert.include(message, source);
        }
      }
    })
  );

  it.effect("rejects an origination clock outside HTTP-date years", () =>
    Effect.gen(function* unrepresentableClock() {
      for (const source of [
        "1899-12-31T23:59:59.999Z",
        "+010000-01-01T00:00:00.000Z",
      ]) {
        yield* TestClock.setTime(DateTime.makeUnsafe(source).epochMilliseconds);

        const exit = yield* jsonAnswerWithMetadata({}, 200, {
          modifiedAt: DateTime.makeUnsafe("2024-01-01T00:00:00Z"),
        }).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));

        if (Exit.isFailure(exit)) {
          assert.include(
            Cause.pretty(exit.cause),
            `Cannot serialize Date as HTTP-date: year must be 1900..9999; received ${source}`
          );
        }
      }
    })
  );

  it.live(
    "keeps pre-1900 storage readable but refuses its HTTP date over TCP",
    () =>
      Effect.gen(function* historicalAuditDate() {
        const { http, path, recordId, token } = yield* storedEvent;
        const origin = yield* edgeServer;
        const sql = yield* SqlClient.SqlClient;

        for (const source of [
          "0001-01-01T00:00:00.000Z",
          "1899-12-31T23:59:59.999Z",
          "1900-01-01T00:00:00.000Z",
        ]) {
          yield* sql`UPDATE core.event_resource SET updated_at = ${source}::timestamptz WHERE id = ${recordId}::uuid`;

          const stored = yield* http.get(`/api/v1/coreEvent/${recordId}`, {
            token,
          });

          assert.strictEqual(stored.status, 200, stored.text);
          assert.strictEqual(asObject(stored.json).lastUpdate, source);

          const response = yield* edgeRequest(origin, path, {
            headers: { authorization: `Bearer ${token}` },
            method: "GET",
          });

          if (source.startsWith("1900")) {
            assert.strictEqual(response.status, 200, response.text);
            assert.strictEqual(
              response.headers["last-modified"],
              "Mon, 01 Jan 1900 00:00:00 GMT"
            );
          } else {
            assert.strictEqual(response.status, 500, response.text);
            assert.strictEqual(response.text, "");
            assert.isUndefined(response.headers["last-modified"]);
          }
        }
      }).pipe(Effect.provide(hubTestLayer))
  );

  it.live(
    "uses the stored audit date, stays stable across reads and projections, and follows generic payload saves",
    () =>
      Effect.gen(function* storedDates() {
        const { http, path, recordId, token, topicId } = yield* storedEvent;

        const stored = yield* http.get(`/api/v1/coreEvent/${recordId}`, {
          token,
        });

        const auditTime = textOf(asObject(stored.json).lastUpdate);
        const first = yield* http.get(path, { token });
        assert.strictEqual(first.status, 200, first.text);
        assert.strictEqual(
          first.headers.get("last-modified"),
          new Date(auditTime).toUTCString()
        );
        assert.notStrictEqual(
          first.headers.get("last-modified"),
          "Wed, 01 Jan 2020 00:00:00 GMT"
        );
        assert.strictEqual(asObject(first.json).eventTime, PAYLOAD.eventTime);
        assert.isFalse(Object.hasOwn(asObject(first.json), "modifiedAt"));
        assert.isFalse(Object.hasOwn(asObject(first.json), "lastUpdate"));
        assert.strictEqual(first.headers.get("etag"), null);
        assert.strictEqual(stored.headers.get("etag"), '"1"');

        for (const selection of [
          "",
          "?fields=eventType",
          "?fields=none",
          "?fields=!event",
        ]) {
          const read = yield* http.get(`${path}${selection}`, { token });
          assert.strictEqual(read.status, 200, read.text);
          assert.strictEqual(
            read.headers.get("last-modified"),
            first.headers.get("last-modified")
          );
          assert.strictEqual(read.headers.get("cache-control"), "no-store");
          assert.strictEqual(asObject(read.json).id, PAYLOAD.eventId);

          if (selection === "") {
            assert.strictEqual(read.text, first.text);
          } else {
            assert.isFalse(Object.hasOwn(asObject(read.json), "event"));
          }
        }

        // Seed an earlier audit instant so the real save demonstrably crosses
        // an HTTP second without a timing-dependent sleep.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE core.event_resource SET updated_at = '2024-01-01T00:00:00.100Z'::timestamptz WHERE id = ${recordId}::uuid`;
        assert.strictEqual(
          (yield* http.get(path, { token })).headers.get("last-modified"),
          "Mon, 01 Jan 2024 00:00:00 GMT"
        );

        const saved = yield* patch(token, "core.event", recordId, 1, {
          payload: {
            ...PAYLOAD,
            event: { message: "changed through generic API" },
          },
        });

        assert.strictEqual(saved.status, 200, saved.text);
        assert.strictEqual(saved.headers.get("etag"), '"2"');
        assert.isNull(saved.headers.get("last-modified"));
        const changed = yield* http.get(path, { token });
        assert.strictEqual(changed.status, 200, changed.text);
        assert.deepStrictEqual(asObject(changed.json).event, {
          message: "changed through generic API",
        });
        assert.strictEqual(
          changed.headers.get("last-modified"),
          new Date(textOf(asObject(saved.json).lastUpdate)).toUTCString()
        );
        assert.notStrictEqual(
          changed.headers.get("last-modified"),
          "Mon, 01 Jan 2024 00:00:00 GMT"
        );
        assert.strictEqual(
          (yield* http.get(`${path}?fields=none`, { token })).headers.get(
            "last-modified"
          ),
          changed.headers.get("last-modified")
        );

        for (const other of [
          `${TMF688_PREFIX}/topic/${topicId}`,
          `${TMF688_PREFIX}/topic/${topicId}/event`,
          `/api/v1/coreEvent/${recordId}`,
        ]) {
          assert.isNull(
            (yield* http.get(other, { token })).headers.get("last-modified"),
            other
          );
        }

        const events = yield* http.get(
          `${TMF688_PREFIX}/topic/record:acmeLaptop/event`,
          { token }
        );

        const generated = textOf(asObject(asArray(events.json)[0]).id);
        assert.notStrictEqual(generated, "");
        assert.isNull(
          (yield* http.get(
            `${TMF688_PREFIX}/topic/record:acmeLaptop/event/${generated}`,
            { token }
          )).headers.get("last-modified")
        );
      }).pipe(Effect.provide(hubTestLayer))
  );

  for (const gate of ["payload", "event", "topic"] as const) {
    it.live(
      `keeps hidden ${gate} indistinguishable from missing without a date`,
      () =>
        Effect.gen(function* hiddenDate() {
          const { http, path, token } = yield* storedEvent;
          assert.strictEqual((yield* http.get(path, { token })).status, 200);
          yield* change([
            addAccessRule(
              gate === "topic" ? EVENT_CLASS_IDS.topic : EVENT_CLASS_IDS.event,
              [BUILT_IN_ROLE_IDS.admin],
              gate === "payload" ? { fields: [EVENT_PAYLOAD_FIELD_ID] } : {},
              { effect: "deny" }
            ).op,
          ]);
          const hidden = yield* http.get(`${path}?fields=none`, { token });

          const missing = yield* http.get(
            `${TMF688_PREFIX}/topic/${UNKNOWN_ID}/event/missing?fields=none`,
            { token }
          );

          assert.strictEqual(hidden.status, 404, hidden.text);
          assert.strictEqual(missing.status, 404, missing.text);
          assert.deepStrictEqual(hidden.json, missing.json);
          assert.isNull(hidden.headers.get("last-modified"));
          assert.isNull(missing.headers.get("last-modified"));
          assert.strictEqual(hidden.headers.get("cache-control"), "no-store");
        }).pipe(Effect.provide(hubTestLayer))
    );
  }

  it.live(
    "sends the date over TCP, clamps a future stored date, fails on invalid storage and keeps HEAD unsupported",
    () =>
      Effect.gen(function* wireDate() {
        const { path, recordId, token } = yield* storedEvent;
        const origin = yield* edgeServer;
        const headers = { authorization: `Bearer ${token}` };
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE core.event_resource SET updated_at = '2024-01-01T00:00:00.999Z'::timestamptz WHERE id = ${recordId}::uuid`;

        const response = yield* edgeRequest(origin, path, {
          headers,
          method: "GET",
        });

        assert.strictEqual(response.status, 200, response.text);
        assert.strictEqual(
          response.headers["last-modified"],
          "Mon, 01 Jan 2024 00:00:00 GMT"
        );
        assert.strictEqual(response.headers["cache-control"], "no-store");
        assert.strictEqual(
          response.headers["content-length"],
          String(Buffer.byteLength(response.text))
        );
        assert.isUndefined(response.headers.etag);

        yield* sql`UPDATE core.event_resource SET updated_at = '9999-12-31T23:59:59.999Z'::timestamptz WHERE id = ${recordId}::uuid`;

        const future = yield* edgeRequest(origin, path, {
          headers,
          method: "GET",
        });

        assert.strictEqual(future.status, 200, future.text);
        assert.isDefined(future.headers.date);
        assert.strictEqual(
          future.headers["last-modified"],
          future.headers.date
        );

        const head = yield* edgeRequest(origin, path, {
          headers,
          method: "HEAD",
        });

        assert.strictEqual(head.status, 405);
        assert.strictEqual(head.text, "");
        assert.isUndefined(head.headers["last-modified"]);
        assert.strictEqual(head.headers["cache-control"], "no-store");

        // PostgreSQL permits infinity; STD's persisted date codec must reject it.
        yield* sql`UPDATE core.event_resource SET updated_at = 'infinity'::timestamptz WHERE id = ${recordId}::uuid`;

        const invalid = yield* edgeRequest(origin, path, {
          headers,
          method: "GET",
        });

        assert.strictEqual(invalid.status, 500, invalid.text);
        assert.isUndefined(invalid.headers["last-modified"]);
        // Existing TMF defect responses bypass its no-store response mapping;
        // preserve that behavior here rather than expanding LM1 into middleware.
        assert.isUndefined(invalid.headers["cache-control"]);
      }).pipe(Effect.provide(hubTestLayer))
  );
});
