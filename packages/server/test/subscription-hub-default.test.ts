import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { effectiveJson } from "@std/definitions/effective-json";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { definitionAt } from "../src/catalog/definition-revisions.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { apiCallers, asArray, asObject } from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { values } from "./schema-support.ts";

const APPLY = "/api/v1/applyChangeSet";

const HUB = {
  api: "generic",
  callback: "https://listener.example/events",
  eventTypes: ["RecordCreateEvent"],
  origin: "https://std.example",
  query: null,
  queryFieldIds: [],
  resource: "acmeAsset",
  topicId: null,
};

const test = it.effect;

describe("subscription hub defaults", () => {
  test("public creates and updates roundtrip absent, null and configured hubs through catalog, history and doctor", () =>
    Effect.gen(function* subscriptionRoundtrip() {
      const http = yield* TestHttpClient;
      const { admin, bob } = yield* apiCallers;
      const fixture = yield* AcmeFixture;

      for (const supplied of [{}, { hub: null }, { hub: HUB }]) {
        const id = randomUUID();

        const definition: JsonObject = {
          classId: ACME.asset,
          condition: null,
          deadLetter: "block",
          enabled: true,
          id,
          identityId: fixture.alice.id,
          kind: "subscription",
          maxAttempts: 10,
          name: `s_${id.replaceAll("-", "")}`,
          operations: ["create", "update", "delete"],
          owner: { layer: "local" },
          protected: false,
          ...supplied,
        };

        const created = yield* http.request("POST", APPLY, {
          ...admin,
          body: { operations: [{ definition, op: "createSubscription" }] },
        });

        assert.strictEqual(created.status, 201, created.text);

        const catalog = yield* Catalog;

        const initial = (yield* catalog.refresh).getKind("subscription", id);

        assert.isDefined(initial);

        if (initial === undefined) {
          throw new Error("Created subscription missing");
        }

        const expected = supplied.hub ?? null;
        assert.deepStrictEqual(initial.hub, expected);
        const revision = Number(asObject(created.json).schemaRevision);
        const historical = yield* definitionAt(id, revision);
        assert.isDefined(historical);
        assert.deepStrictEqual(
          historical === undefined
            ? undefined
            : effectiveJson(historical.definition),
          effectiveJson(initial)
        );

        const report = yield* runDoctor();
        assert.strictEqual(report.exitCode, 0, JSON.stringify(report.findings));

        // An update that omits hub keeps the configured callback, while null clears it.
        for (const [version, changes, expectedHub] of [
          [1, { enabled: false }, expected],
          [2, { enabled: true, hub: HUB }, HUB],
          [3, { hub: null }, null],
        ] as const) {
          const updated = yield* http.request("POST", APPLY, {
            ...admin,
            body: { operations: [{ changes, id, op: "update", version }] },
          });

          // Every update changes a configured property and records one version.
          assert.strictEqual(updated.status, 201, updated.text);

          const current = (yield* catalog.refresh).getKind("subscription", id);

          assert.deepStrictEqual(current?.hub, expectedHub);
          const doctor = yield* runDoctor();
          assert.strictEqual(
            doctor.exitCode,
            0,
            JSON.stringify(doctor.findings)
          );
        }

        const read = yield* http.get(`/api/v1/coreSubscription/${id}`, admin);

        assert.strictEqual(read.status, 200, read.text);
        assert.strictEqual(asObject(read.json).id, id);

        const history = yield* http.get(
          `/api/v1/coreSubscription/${id}/history`,
          admin
        );

        assert.strictEqual(history.status, 200, history.text);
        assert.lengthOf(asArray(history.json), 4);
        const old = yield* definitionAt(id, revision);
        assert.deepStrictEqual(old, historical);

        const before = yield* values(
          "SELECT revision::text AS value FROM core.config_state"
        );

        for (const invalid of [false, "", 5, [], {}, { ...HUB, callback: 5 }]) {
          const malformed = yield* http.request("POST", APPLY, {
            ...admin,
            body: {
              operations: [
                {
                  definition: {
                    ...definition,
                    hub: invalid,
                    id: randomUUID(),
                  },
                  op: "createSubscription",
                },
              ],
            },
          });

          assert.strictEqual(malformed.status, 400, malformed.text);
          assert.strictEqual(asObject(malformed.json).code, "InvalidRequest");
        }

        for (const invalid of [
          false,
          "",
          5,
          [],
          {},
          { ...HUB, callback: 5 },
          {
            ...HUB,
            attributeCondition: {
              left: { path: [randomUUID()] },
              op: "eq",
              right: { value: "missing field" },
            },
          },
          {
            ...HUB,
            standardCondition: {
              left: { path: [randomUUID()] },
              op: "eq",
              right: { value: "missing field" },
            },
          },
        ]) {
          const refused = yield* http.request("POST", APPLY, {
            ...admin,
            body: {
              operations: [
                { changes: { hub: invalid }, id, op: "update", version: 4 },
              ],
            },
          });

          assert.strictEqual(refused.status, 422, refused.text);
          assert.strictEqual(asObject(refused.json).code, "DefinitionInvalid");
        }

        const unauthorized = yield* http.request("POST", APPLY, {
          ...bob,
          body: {
            operations: [
              { changes: { hub: HUB }, id, op: "update", version: 4 },
            ],
          },
        });

        assert.strictEqual(unauthorized.status, 422, unauthorized.text);
        assert.strictEqual(
          asObject(unauthorized.json).code,
          "DefinitionInvalid"
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT revision::text AS value FROM core.config_state"
          ),
          before
        );
      }
    }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive));

  test("reads inherited omitted-hub revisions without rewriting historical JSON or treating real hub drift as a default", () =>
    Effect.gen(function* inheritedRevision() {
      const http = yield* TestHttpClient;
      const { admin } = yield* apiCallers;
      const fixture = yield* AcmeFixture;
      const sql = yield* SqlClient.SqlClient;
      const id = randomUUID();

      const created = yield* http.request("POST", APPLY, {
        ...admin,
        body: {
          operations: [
            {
              definition: {
                classId: ACME.asset,
                condition: null,
                deadLetter: "block",
                enabled: true,
                id,
                identityId: fixture.alice.id,
                kind: "subscription",
                maxAttempts: 10,
                name: `s_${id.replaceAll("-", "")}`,
                operations: ["create"],
                owner: { layer: "local" },
                protected: false,
              },
              op: "createSubscription",
            },
          ],
        },
      });

      assert.strictEqual(created.status, 201, created.text);
      // Reproduce exactly the JSON written by the selected base and by pre-hub releases.
      yield* sql`UPDATE core.definition_revision SET effective = effective - 'hub' WHERE definition_id = ${id}::uuid`;

      const stored = yield* values(
        "SELECT effective::text AS value FROM core.definition_revision WHERE definition_id = $1::uuid",
        [id]
      );

      const revision = Number(asObject(created.json).schemaRevision);
      const old = yield* definitionAt(id, revision);
      assert.isTrue(old?.definition.kind === "subscription");

      if (old?.definition.kind === "subscription") {
        assert.strictEqual(old.definition.hub, null);
      }

      const doctor = yield* runDoctor();
      assert.strictEqual(doctor.exitCode, 0, JSON.stringify(doctor.findings));
      yield* runUpgrade();
      assert.deepStrictEqual(
        yield* values(
          "SELECT effective::text AS value FROM core.definition_revision WHERE definition_id = $1::uuid",
          [id]
        ),
        stored
      );

      yield* sql`UPDATE core.subscription SET hub = ${JSON.stringify(HUB)}::jsonb WHERE id = ${id}::uuid`;
      const drift = yield* runDoctor();
      assert.strictEqual(drift.exitCode, 1);
      assert.isTrue(
        drift.findings.some(
          (finding) =>
            finding.code === "definitionRevisionStale" && finding.subject === id
        )
      );
      yield* sql`UPDATE core.subscription SET hub = NULL WHERE id = ${id}::uuid`;
    }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive));
});
