import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Schema } from "effect";

import { startListener } from "../src/listener.ts";

const test = it.effect;

const EVENT_ID = "f70a6ef7-83a0-5bc2-8885-26bb5277041b";
const TICKET_ID = "019a52fe-0000-7000-8000-000000000001";

const NOTIFICATION = {
  "@type": "TroubleTicketAttributeValueChangeEvent",
  event: {
    troubleTicket: {
      "@type": "TroubleTicket",
      description: null,
      id: TICKET_ID,
      note: [
        { id: "note-1", text: "Both notes arrive whole." },
        { id: "note-2", text: "Second." },
      ],
      status: "inProgress",
    },
  },
  eventId: EVENT_ID,
  eventTime: "2026-10-24T12:00:00Z",
  eventType: "TroubleTicketAttributeValueChangeEvent",
};

const post = (origin: string, body: Schema.Json, key: string = EVENT_ID) =>
  Effect.promise(
    async () =>
      await fetch(`${origin}/listener?source=tmf621`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "idempotency-key": key },
        method: "POST",
      })
  );

const receipts = (origin: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${origin}/receipts`);
    assert.strictEqual(response.status, 200);

    return await response.json();
  });

describe("listener HTTP interface", () => {
  test("retains one first body across concurrent duplicate deliveries with changed eventTime", () =>
    Effect.gen(function* concurrentDuplicates() {
      const origin = yield* startListener(0);
      const accepted = yield* post(origin, NOTIFICATION);
      assert.strictEqual(accepted.status, 202);
      assert.deepStrictEqual(
        yield* Effect.promise(async () => await accepted.json()),
        { duplicate: false, eventId: EVENT_ID }
      );

      const repeated = yield* Effect.all(
        [
          post(origin, {
            ...NOTIFICATION,
            eventTime: "2026-10-24T12:01:00Z",
          }),
          post(origin, {
            ...NOTIFICATION,
            eventTime: "2026-10-24T12:02:00Z",
          }),
        ],
        { concurrency: "unbounded" }
      );

      for (const response of repeated) {
        assert.strictEqual(response.status, 202);
        assert.deepStrictEqual(
          yield* Effect.promise(async () => await response.json()),
          { duplicate: true, eventId: EVENT_ID }
        );
      }

      assert.deepStrictEqual(yield* receipts(origin), [
        {
          duplicates: 2,
          idempotencyKey: EVENT_ID,
          notification: NOTIFICATION,
        },
      ]);
    }));

  test("keeps distinct event IDs for different event types of the same ticket", () =>
    Effect.gen(function* distinctEventTypes() {
      const origin = yield* startListener(0);
      const resolvedId = "459b25d8-301f-5f40-a037-945bda62cac9";

      const resolved = {
        ...NOTIFICATION,
        "@type": "TroubleTicketResolvedEvent",
        eventId: resolvedId,
        eventType: "TroubleTicketResolvedEvent",
      };

      assert.strictEqual((yield* post(origin, NOTIFICATION)).status, 202);
      assert.strictEqual(
        (yield* post(origin, resolved, resolvedId)).status,
        202
      );
      assert.deepStrictEqual(yield* receipts(origin), [
        {
          duplicates: 0,
          idempotencyKey: EVENT_ID,
          notification: NOTIFICATION,
        },
        { duplicates: 0, idempotencyKey: resolvedId, notification: resolved },
      ]);
    }));

  test("rejects malformed bodies, mismatched types and wrong keys without accepting a receipt", () =>
    Effect.gen(function* invalidNotifications() {
      const origin = yield* startListener(0);

      for (const body of [
        {},
        { ...NOTIFICATION, eventId: "not-a-uuid" },
        { ...NOTIFICATION, "@type": "TroubleTicketResolvedEvent" },
        { ...NOTIFICATION, event: { troubleTicket: { id: "invalid" } } },
      ]) {
        assert.strictEqual((yield* post(origin, body)).status, 400);
      }

      assert.strictEqual(
        (yield* post(origin, NOTIFICATION, "wrong-key")).status,
        400
      );

      const malformed = yield* Effect.promise(
        async () =>
          await fetch(`${origin}/listener`, {
            body: "{broken",
            method: "POST",
          })
      );

      assert.strictEqual(malformed.status, 400);
      assert.deepStrictEqual(yield* receipts(origin), []);
      assert.strictEqual(
        (yield* Effect.promise(async () => await fetch(`${origin}/other`)))
          .status,
        404
      );
    }));

  test("a new listener has no receipts from an earlier scope", () =>
    Effect.gen(function* newListener() {
      yield* Effect.scoped(
        Effect.gen(function* previousListener() {
          const origin = yield* startListener(0);
          assert.strictEqual((yield* post(origin, NOTIFICATION)).status, 202);
        })
      );
      const origin = yield* startListener(0);
      assert.deepStrictEqual(yield* receipts(origin), []);
      const accepted = yield* post(origin, NOTIFICATION);
      assert.deepStrictEqual(
        yield* Effect.promise(async () => await accepted.json()),
        { duplicate: false, eventId: EVENT_ID }
      );
    }));
});
