/** Served date-time models and wire values (TMF630 P1 §2.8; Contracts 6.5, 10.4). */
import { assert, describe, it } from "@effect/vitest";
import { ChangeEntry } from "@std/api/resource";
import { EventCreate, TmfEvent } from "@std/api/tmf688";
import type { JsonValue } from "@std/values/json-value";
import { DateTime, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import { HelpdeskFixture } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { apiOpenApi } from "../src/http/api/openapi.ts";
import { isRfc3339DateTime } from "../src/http/tmf/rfc3339.ts";
import { asArray, asObject, textOf, withQuery } from "./api-support.ts";
import { itilLayer } from "./itil-support.ts";
import { TICKETS, ticketBody, tmf621As } from "./tmf621-support.ts";

const GENERIC = "/api/v1/helpdeskTicket";

// Contracts 6.5: output is UTC with exactly three fractional digits.
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const assertTimestamp = (value: JsonValue | undefined): void => {
  const text = textOf(value);
  assert.isTrue(isRfc3339DateTime(text), text);
  assert.match(text, CANONICAL);
};

describe("datetime-models", () => {
  it("declares RFC 3339 formats for known shared date-time members", () => {
    const schemas = asObject(asObject(apiOpenApi.components).schemas);

    for (const { model, fields } of [
      { fields: ["creationDate", "lastUpdate"], model: "Resource" },
      { fields: ["creationDate", "occurredAt"], model: "ChangeEntry" },
      { fields: ["expiresAt"], model: "Session" },
      { fields: ["finishedAt"], model: "DeadDelivery" },
    ]) {
      const properties = asObject(asObject(schemas[model]).properties);

      for (const name of fields) {
        assert.strictEqual(
          asObject(properties[name]).type,
          "string",
          `${model}.${name}`
        );
        assert.strictEqual(
          asObject(properties[name]).format,
          "date-time",
          `${model}.${name}`
        );
      }
    }

    for (const model of [EventCreate, TmfEvent]) {
      const document = Schema.toJsonSchemaDocument(model);

      const schema = Schema.decodeUnknownSync(
        Schema.Record(Schema.String, Schema.Json)
      )(document.schema);

      const properties = asObject(schema.properties);
      assert.strictEqual(asObject(properties.eventTime).type, "string");
      assert.strictEqual(asObject(properties.eventTime).format, "date-time");
    }
  });

  it.effect(
    "serves date-time formats for known shared and table model members",
    () =>
      Effect.gen(function* models() {
        const admin = yield* tmf621As("admin");
        const document = yield* admin.get("/api/v1/openapi.json");
        assert.strictEqual(document.status, 200, document.text);
        assert.deepStrictEqual(document.json, apiOpenApi);

        for (const path of [
          "/api/v1/tableMetadata/helpdeskTicket/schema.json",
          "/api/v1/tableMetadata/helpdeskTicket/openapi.json",
        ]) {
          const response = yield* admin.get(path);
          assert.strictEqual(response.status, 200, response.text);
          const body = asObject(response.json);
          const tableSchemas = asObject(asObject(body.components).schemas);

          const resource = path.endsWith("/schema.json")
            ? body
            : asObject(tableSchemas.Resource);

          const properties = asObject(resource.properties);

          for (const field of [
            "creationDate",
            "lastUpdate",
            "requestedResolutionAt",
            "expectedResolutionAt",
            "resolvedAt",
            "statusChangedAt",
          ]) {
            assert.strictEqual(
              asObject(properties[field]).format,
              "date-time",
              `${path}: ${field}`
            );
          }

          if (path.endsWith("/openapi.json")) {
            const history = asObject(
              asObject(tableSchemas.ChangeEntry).properties
            );

            assert.strictEqual(
              asObject(history.creationDate).format,
              "date-time"
            );
            assert.strictEqual(
              asObject(history.occurredAt).format,
              "date-time"
            );
          }
        }

        const http = yield* TestHttpClient;
        const { admin: user } = yield* HelpdeskFixture;

        const session = yield* http.request("POST", "/api/v1/session", {
          body: {
            login: user.login,
            password: user.password,
            tokenDelivery: "body",
          },
        });

        assert.strictEqual(session.status, 201, session.text);
        assertTimestamp(asObject(session.json).expiresAt);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "generic and shipped TMF dates normalize offsets and refuse invalid instants without changing precision policy",
    () =>
      Effect.gen(function* wireDates() {
        const admin = yield* tmf621As("admin");

        for (const { input, canonical } of [
          {
            canonical: "2026-10-20T08:15:30.123Z",
            input: "2026-10-20T10:15:30.123+02:00",
          },
          {
            canonical: "2026-10-20T08:15:30.500Z",
            input: "2026-10-19t23:45:30.5000-08:30",
          },
        ]) {
          for (const mapped of [false, true]) {
            const collection = mapped ? TICKETS : GENERIC;

            const field = mapped
              ? "requestedResolutionDate"
              : "requestedResolutionAt";

            const created = yield* admin.post(
              collection,
              mapped
                ? ticketBody({ [field]: input })
                : {
                    description: "Date-time wire proof",
                    shortDescription: "Dates",
                    [field]: input,
                  }
            );

            assert.strictEqual(created.status, 201, created.text);
            const resource = asObject(created.json);
            assert.strictEqual(resource[field], canonical);
            assertTimestamp(resource.creationDate);
            assertTimestamp(resource.lastUpdate);
            const path = `${collection}/${textOf(resource.id)}`;
            const read = yield* admin.get(path);
            assert.strictEqual(read.status, 200, read.text);
            assert.strictEqual(asObject(read.json)[field], canonical);

            const listed = yield* admin.get(
              withQuery(collection, [[field, input]])
            );

            assert.strictEqual(listed.status, 200, listed.text);

            const item = asObject(
              asArray(listed.json).find(
                (value) => asObject(value).id === resource.id
              )
            );

            assert.strictEqual(item[field], canonical);
            assertTimestamp(item.creationDate);
            assertTimestamp(item.lastUpdate);

            for (const invalid of [
              "2026-10-20T08:15:30",
              "2026-02-30T08:15:30Z",
              "2026-10-20T24:00:00Z",
              "2026-10-20T08:15:30+24:00",
              "2026-10-20T08:15:30.1234Z",
              "2016-12-31T23:59:60Z",
            ]) {
              const refused = yield* admin.patch(
                path,
                { [field]: invalid },
                {
                  ifMatch: read.headers.get("etag") ?? "",
                }
              );

              assert.strictEqual(
                refused.status,
                mapped ? 400 : 422,
                refused.text
              );
              assert.strictEqual(
                asObject(refused.json).code,
                "ValidationFailed"
              );
              assert.include(
                JSON.stringify(asObject(refused.json).fieldErrors),
                field
              );
            }

            const unchanged = yield* admin.get(path);
            assert.strictEqual(unchanged.status, 200, unchanged.text);
            assert.deepStrictEqual(unchanged.json, read.json);
            assert.strictEqual(
              unchanged.headers.get("etag"),
              read.headers.get("etag")
            );
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "history lists and entries emit matching UTC timestamps and parse offset filters through history",
    () =>
      Effect.gen(function* historyDates() {
        const admin = yield* tmf621As("admin");
        const created = yield* admin.post(TICKETS, ticketBody());
        assert.strictEqual(created.status, 201, created.text);
        const path = `${GENERIC}/${textOf(asObject(created.json).id)}/history`;
        const history = yield* admin.get(path);
        assert.strictEqual(history.status, 200, history.text);
        assert.isNotEmpty(asArray(history.json));

        for (const value of asArray(history.json)) {
          const entry = yield* Schema.decodeUnknownEffect(ChangeEntry)(value);
          assertTimestamp(entry.creationDate);
          assertTimestamp(entry.occurredAt);
          assert.strictEqual(entry.creationDate, entry.occurredAt);
          const single = yield* admin.get(new URL(textOf(entry.href)).pathname);
          assert.strictEqual(single.status, 200, single.text);
          assert.deepStrictEqual(single.json, value);
        }

        const first = asObject(asArray(history.json)[0]);
        const creationDate = textOf(first.creationDate);

        const offsetDate = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(creationDate), { hours: 2 })
        ).replace("Z", "+02:00");

        for (const parameter of ["creationDate", "since"]) {
          const utc = yield* admin.get(
            withQuery(path, [[parameter, creationDate]])
          );

          const offset = yield* admin.get(
            withQuery(path, [[parameter, offsetDate]])
          );

          assert.strictEqual(utc.status, 200, utc.text);
          assert.strictEqual(offset.status, 200, offset.text);
          assert.deepStrictEqual(offset.json, utc.json);

          const expected =
            parameter === "since"
              ? asArray(history.json)
              : asArray(history.json).filter(
                  (value) => asObject(value).creationDate === creationDate
                );

          assert.deepStrictEqual(utc.json, expected);
          assert.isNotEmpty(asArray(offset.json));

          for (const invalid of [
            "2026-02-30T00:00:00Z",
            "2026-10-20T08:15:30",
            "2026-10-20T08:15:30.1234Z",
            "2016-12-31T23:59:60Z",
          ]) {
            const refused = yield* admin.get(
              withQuery(path, [[parameter, invalid]])
            );

            assert.strictEqual(refused.status, 400, refused.text);
            assert.strictEqual(asObject(refused.json).code, "InvalidRequest");
            assert.strictEqual(asObject(refused.json).parameter, parameter);
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
