/**
 * The write side of Contracts 3 "Acceptance tests" on the two-user example
 * (3.3), through the HTTP API: ownership, child-rule-parent-endpoint,
 * child-fields, written-fields, references, history, history-endpoint,
 * referenced and invisible-404 (PATCH), plus If-Match handling and the
 * request-decoding versus validation distinction.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { objectOf } from "./authz-support.ts";
import { codeOf, readsTestLayer, recordPath } from "./reads-support.ts";
import {
  ASSET,
  create,
  entriesOf,
  history,
  LAPTOP,
  MONITOR,
  patch,
  remove,
  savedOf,
  versionOf,
} from "./writes-support.ts";

/** Sign-in for both fixture users. */
const tokens = Effect.gen(function* signInBoth() {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;

  return {
    alice: yield* http.signIn("alice", "alice-password"),
    bob: yield* http.signIn("bob", "bob-password"),
    fixture,
  };
});

describe("write-authorization", () => {
  it("names the endpoints", () => {
    assert.deepStrictEqual(
      [ASSET, LAPTOP, MONITOR],
      ["acme.asset", "acme.laptop", "acme.monitor"]
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("ownership", () =>
      Effect.gen(function* ownership() {
        const { alice, bob, fixture } = yield* tokens;
        const { L } = fixture.records;
        const before = yield* versionOf(L);

        const handOver = yield* patch(bob, LAPTOP, L, before ?? 0, {
          owner: fixture.alice.id,
        });

        assert.strictEqual(handOver.status, 403);
        assert.strictEqual(yield* codeOf(handOver), "NotAllowed");
        assert.strictEqual(yield* versionOf(L), before);
        assert.lengthOf(yield* entriesOf(L), 1);

        const forAlice = yield* create(bob, ASSET, {
          name: "for Alice",
          owner: fixture.alice.id,
        });

        assert.strictEqual(forAlice.status, 403);

        const forBob = yield* create(bob, ASSET, {
          name: "for Bob",
          owner: fixture.bob.id,
        });

        assert.strictEqual(forBob.status, 201);
        assert.strictEqual((yield* savedOf(forBob)).version, 1);
        assert.isString(alice);
      })
    );

    dbTest.effect("child-rule-parent-endpoint", () =>
      Effect.gen(function* childRule() {
        const { bob, fixture } = yield* tokens;
        const { L, M } = fixture.records;

        const onMonitor = yield* patch(
          bob,
          ASSET,
          M,
          (yield* versionOf(M)) ?? 0,
          { status: "spare" }
        );

        assert.strictEqual(onMonitor.status, 200);

        const onLaptop = yield* patch(
          bob,
          ASSET,
          L,
          (yield* versionOf(L)) ?? 0,
          { status: "spare" }
        );

        assert.strictEqual(onLaptop.status, 403);
        assert.strictEqual(yield* codeOf(onLaptop), "NotAllowed");
      })
    );

    dbTest.effect("child-fields", () =>
      Effect.gen(function* childFields() {
        const { bob, fixture } = yield* tokens;
        const { L } = fixture.records;
        const version = (yield* versionOf(L)) ?? 0;

        const serialViaAsset = yield* patch(bob, ASSET, L, version, {
          serial: "X",
        });

        assert.strictEqual(serialViaAsset.status, 400);
        assert.strictEqual(yield* codeOf(serialViaAsset), "UnknownField");

        const diskKey = yield* patch(bob, LAPTOP, L, version, {
          diskKey: "X",
        });

        const misspelled = yield* patch(bob, LAPTOP, L, version, {
          diskKee: "X",
        });

        assert.strictEqual(diskKey.status, 400);
        assert.strictEqual(yield* codeOf(diskKey), "UnknownField");
        assert.strictEqual(
          diskKey.text.replace("diskKey", "?"),
          misspelled.text.replace("diskKee", "?")
        );
        assert.strictEqual(yield* versionOf(L), version);
      })
    );

    dbTest.effect("written-fields", () =>
      Effect.gen(function* writtenFields() {
        const { bob, fixture } = yield* tokens;
        const { L, S } = fixture.records;
        const version = (yield* versionOf(L)) ?? 0;

        // serial is readable to Bob but not writable; unchanged it is
        // not written.
        const unchanged = yield* patch(bob, LAPTOP, L, version, {
          name: "L renamed",
          serial: "SN-L",
        });

        assert.strictEqual(unchanged.status, 200);
        assert.strictEqual(yield* versionOf(L), version + 1);

        const noOp = yield* patch(bob, LAPTOP, L, version + 1, {
          name: "L renamed",
        });

        assert.strictEqual(noOp.status, 200);
        assert.strictEqual(yield* versionOf(L), version + 1);

        // purchasedOn is hidden on lost S: an equal value and a different
        // one have the same effect.
        const sVersion = (yield* versionOf(S)) ?? 0;

        const equal = yield* patch(bob, ASSET, S, sVersion, {
          purchasedOn: "2023-03-10",
        });

        const different = yield* patch(bob, ASSET, S, sVersion, {
          purchasedOn: "2020-01-01",
        });

        assert.strictEqual(equal.status, different.status);
        assert.strictEqual(equal.text, different.text);
        assert.strictEqual(yield* versionOf(S), sVersion);
      })
    );

    dbTest.effect("references", () =>
      Effect.gen(function* references() {
        const { bob, fixture } = yield* tokens;
        const { AM, M } = fixture.records;
        const version = (yield* versionOf(M)) ?? 0;

        const hidden = yield* patch(bob, ASSET, M, version, {
          dockedTo: AM,
        });

        const missing = yield* patch(bob, ASSET, M, version, {
          dockedTo: randomUUID(),
        });

        assert.strictEqual(hidden.status, 422);
        assert.strictEqual(yield* codeOf(hidden), "InvalidReference");
        assert.strictEqual(hidden.text, missing.text);

        const created = yield* create(bob, ASSET, {
          dockedTo: AM,
          name: "dock",
          owner: fixture.bob.id,
        });

        assert.strictEqual(created.text, hidden.text);
        assert.strictEqual(yield* versionOf(M), version);
      })
    );

    dbTest.effect("history and history-endpoint", () =>
      Effect.gen(function* histories() {
        const { alice, bob, fixture } = yield* tokens;
        const { L } = fixture.records;
        const version = (yield* versionOf(L)) ?? 0;

        const costAndStatus = yield* patch(alice, ASSET, L, version, {
          cost: "1250.00",
          status: "repair",
        });

        assert.strictEqual(costAndStatus.status, 200);

        const serial = yield* patch(alice, LAPTOP, L, version + 1, {
          serial: "SN-L2",
        });

        assert.strictEqual(serial.status, 200);

        for (const table of [ASSET, LAPTOP]) {
          const seen = yield* history(bob, table, L);

          const statusEntry = seen.entries.find(
            (entry) => entry.version === version + 1
          );

          assert.deepStrictEqual(statusEntry?.changes, {
            status: { after: "repair", before: "in_use" },
          });
          assert.isTrue(
            seen.entries.every((entry) => !("cost" in entry.changes))
          );
          assert.deepStrictEqual(
            seen.entries.find((entry) => entry.version === version + 2)
              ?.changes,
            { serial: { after: "SN-L2", before: "SN-L" } }
          );
        }

        const aliceSees = yield* history(alice, ASSET, L);

        assert.deepStrictEqual(
          aliceSees.entries.find((entry) => entry.version === version + 1)
            ?.changes.cost,
          { after: "1250.00", before: "1200.00" }
        );
      })
    );

    dbTest.effect(
      "history and history-endpoint through /acme.monitor: versions, field protection, no cost key for Bob",
      () =>
        Effect.gen(function* monitorHistories() {
          const http = yield* TestHttpClient;
          const { alice, bob, fixture } = yield* tokens;
          const { AM, M } = fixture.records;

          const { values, version } = yield* savedOf(
            yield* http.get(recordPath(MONITOR, M), { token: alice })
          );

          const costAndStatus = yield* patch(alice, ASSET, M, version, {
            cost: "350.00",
            status: "repair",
          });

          assert.strictEqual(costAndStatus.status, 200, costAndStatus.text);

          const size = yield* patch(alice, MONITOR, M, version + 1, {
            sizeInches: 32,
          });

          assert.strictEqual(size.status, 200, size.text);

          const versions = Array.from(
            { length: version + 2 },
            (_, index) => index + 1
          );

          for (const table of [ASSET, MONITOR]) {
            const seen = yield* history(bob, table, M);

            assert.deepStrictEqual(
              seen.entries
                .map((entry) => entry.version)
                .toSorted((left, right) => left - right),
              versions,
              table
            );
            assert.deepStrictEqual(
              seen.entries.find((entry) => entry.version === version + 1)
                ?.changes,
              { status: { after: "repair", before: values.status ?? null } },
              table
            );
            // No rule lets an employee read `sizeInches` (rule 8 grants
            // only a laptop's serial): the entry is there, its change is not.
            assert.deepStrictEqual(
              seen.entries.find((entry) => entry.version === version + 2)
                ?.changes,
              {},
              table
            );
            assert.isTrue(
              seen.entries.every(
                (entry) =>
                  !("cost" in entry.changes || "sizeInches" in entry.changes)
              ),
              table
            );
          }

          for (const table of [ASSET, MONITOR]) {
            const aliceSees = yield* history(alice, table, M);

            assert.deepStrictEqual(
              aliceSees.entries
                .map((entry) => entry.version)
                .toSorted((left, right) => left - right),
              versions,
              table
            );
            assert.deepStrictEqual(
              aliceSees.entries.find((entry) => entry.version === version + 1)
                ?.changes.cost,
              { after: "350.00", before: values.cost ?? null },
              table
            );
            assert.deepStrictEqual(
              aliceSees.entries.find((entry) => entry.version === version + 2)
                ?.changes,
              {
                sizeInches: { after: 32, before: values.sizeInches ?? null },
              },
              table
            );
          }

          // Alice's monitor: Bob's history request is 404, as for a
          // record that does not exist.
          const hidden = yield* http.get(`${recordPath(MONITOR, AM)}/history`, {
            token: bob,
          });

          const missing = yield* http.get(
            `${recordPath(MONITOR, randomUUID())}/history`,
            { token: bob }
          );

          assert.strictEqual(hidden.status, 404);
          assert.strictEqual(hidden.text, missing.text);
        })
    );

    dbTest.effect("referenced", () =>
      Effect.gen(function* referenced() {
        const { alice, fixture } = yield* tokens;
        const { AM } = fixture.records;
        const version = (yield* versionOf(AM)) ?? 0;
        const response = yield* remove(alice, MONITOR, AM, version);

        assert.strictEqual(response.status, 409);
        assert.strictEqual(yield* codeOf(response), "Referenced");
        assert.strictEqual(yield* versionOf(AM), version);
      })
    );

    dbTest.effect("invisible-404", () =>
      Effect.gen(function* invisible() {
        const { bob, fixture } = yield* tokens;
        const { K } = fixture.records;
        const version = (yield* versionOf(K)) ?? 0;
        const random = randomUUID();

        for (const table of [LAPTOP, ASSET]) {
          const hidden = yield* patch(bob, table, K, version, { name: "x" });

          const unknown = yield* patch(bob, table, random, version, {
            name: "x",
          });

          assert.strictEqual(hidden.status, 404);
          assert.strictEqual(hidden.text, unknown.text);
        }

        const stale = yield* patch(bob, LAPTOP, K, version + 7, { name: "x" });

        assert.strictEqual(stale.status, 404, "never VersionConflict");
        assert.strictEqual(yield* versionOf(K), version);
      })
    );

    dbTest.effect(
      "If-Match: missing is 428, stale is 412 with the current version",
      () =>
        Effect.gen(function* ifMatch() {
          const { alice, fixture } = yield* tokens;
          const { K } = fixture.records;
          const version = (yield* versionOf(K)) ?? 0;

          const missing = yield* patch(alice, LAPTOP, K, undefined, {
            name: "K2",
          });

          assert.strictEqual(missing.status, 428);
          assert.strictEqual(yield* codeOf(missing), "VersionRequired");

          const stale = yield* patch(alice, ASSET, K, version - 1, {
            name: "K2",
          });

          assert.strictEqual(stale.status, 412);
          assert.strictEqual(yield* codeOf(stale), "VersionConflict");
          assert.strictEqual(objectOf(stale.json).currentVersion, version);
          assert.strictEqual(yield* versionOf(K), version);
        })
    );

    dbTest.effect(
      "undecodable requests are 400, invalid field values are 422",
      () =>
        Effect.gen(function* decoding() {
          const { alice, fixture } = yield* tokens;
          const http = yield* TestHttpClient;
          const { K } = fixture.records;
          const version = (yield* versionOf(K)) ?? 0;

          const malformed = yield* http.request(
            "PATCH",
            recordPath(LAPTOP, K),
            {
              headers: {
                "content-type": "application/json",
                "if-match": `"${version}"`,
              },
              token: alice,
            }
          );

          assert.strictEqual(malformed.status, 400);

          const invalid = yield* patch(alice, LAPTOP, K, version, {
            cost: 12.5,
            purchasedOn: null,
          });

          assert.strictEqual(invalid.status, 422);
          assert.strictEqual(yield* codeOf(invalid), "ValidationFailed");
          assert.deepStrictEqual(objectOf(invalid.json).fieldErrors, [
            { _tag: "Required", field: "purchasedOn" },
            {
              _tag: "InvalidValue",
              field: "cost",
              message:
                'Expected a string such as "12.50"; JSON numbers lose precision.',
              reason: "wrongJsonType",
            },
          ]);
        })
    );
  });
});
