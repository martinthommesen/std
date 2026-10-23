/**
 * `json-patch-race` (Contracts 10.5): a patch is evaluated against the
 * version the save locked.
 *
 * - Through the record service, as the TMF APIs call it without a version
 *   (`expectedVersion` null, Contracts 11.1): two concurrent patches, each
 *   testing the same value and replacing it, end with exactly one success
 *   and one `PatchTestFailed` that wrote nothing; a copy whose source a
 *   concurrent save changes copies the value of the version it applies to.
 * - Through `/api/v1`, where `If-Match` is required: two concurrent JSON
 *   Patches based on one revision end with exactly one success, and the
 *   other is `412 VersionConflict` with nothing written.
 *
 * The row is held by a third transaction until both saves wait on its lock
 * (observed in `pg_stat_activity`), so they really race.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { PatchTestFailed } from "@std/api/errors/patch-test-failed";
import { PatchTestFailed as PatchTestFailedError } from "@std/api/errors/patch-test-failed";
import type { DefinitionId } from "@std/definitions/ids";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject } from "@std/values/json-value";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";

import {
  ACME,
  AcmeFixture,
  seedRecord,
} from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Actor } from "../src/auth/actor.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import { updateRecord } from "../src/records/save-pipeline.ts";
import type { LockedImage } from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { asObject, textOf, API, apiCallers } from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { waitUntil } from "./support.ts";

const SaveServices = Layer.mergeAll(
  WriteAccess.allowAll,
  SaveHooks.none,
  WriteOnlyValues.scrypt
);

const lockWaiters = Effect.gen(function* lockWaiters() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql.unsafe<{ readonly waiting: string }>(
    `SELECT count(*)::text AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
  );

  return Number(rows[0]?.waiting ?? "0");
});

/**
 * Holds a record's root row in another transaction until `release`.
 *
 * @param id - The record.
 * @returns The holder's fiber and the release signal.
 */
const holdRow = (id: DefinitionId) =>
  Effect.gen(function* holdRowLock() {
    const { request } = yield* Transactions;
    const held = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();

    const holder = yield* request(
      Effect.gen(function* lockRow() {
        const sql = yield* SqlClient.SqlClient;

        yield* sql.unsafe(
          `SELECT id FROM acme.asset WHERE id = $1::uuid FOR UPDATE`,
          [id]
        );
        yield* Deferred.succeed(held, true);
        yield* Deferred.await(release);
      })
    ).pipe(Effect.forkChild);

    yield* Deferred.await(held);

    return { holder, release };
  });

const valuesOf = (projection: JsonObject): JsonObject => {
  const { values } = projection;

  return values !== undefined && isJsonObject(values) ? values : {};
};

/**
 * A patch as the TMF APIs evaluate it: `test` the status is `spare`, then
 * replace it, on the locked record's values.
 *
 * @param locked - The locked record.
 * @returns The update body, or `PatchTestFailed`.
 */
export const testThenReplace = ({
  projection,
}: LockedImage): Effect.Effect<JsonObject, PatchTestFailed> =>
  valuesOf(projection).status === "spare"
    ? Effect.succeed({ status: "in_use" })
    : Effect.fail(new PatchTestFailedError({ operation: 0 }));

/**
 * A patch that copies `name` into `status` on the locked record.
 *
 * @param locked - The locked record.
 * @returns The update body.
 */
const copyName = ({
  projection,
}: LockedImage): Effect.Effect<JsonObject, PatchTestFailed> =>
  Effect.succeed({ status: valuesOf(projection).name ?? null });

describe("json-patch-race", () => {
  it("testThenReplace refuses a status that is not spare", () => {
    const outcome = Effect.runSyncExit(
      testThenReplace({
        projection: { values: { status: "in_use" } },
        storedJson: new Map(),
      })
    );

    assert.isTrue(Exit.isFailure(outcome));
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "two concurrent test-and-replace patches without a version: exactly one applies",
      () =>
        Effect.gen(function* raceWithoutVersion() {
          const { alice } = yield* AcmeFixture;
          const actor = Actor.of({ roleIds: [], userId: alice.id });

          const id = yield* seedRecord(alice.id, ACME.asset, {
            name: "R",
            status: "spare",
          });

          const patch = updateRecord({
            body: { status: null },
            endpointClassId: ACME.asset,
            evaluate: testThenReplace,
            expectedVersion: null,
            id,
          }).pipe(
            Effect.provideService(Actor, actor),
            Effect.provide(SaveServices)
          );

          const { holder, release } = yield* holdRow(id);
          const first = yield* Effect.exit(patch).pipe(Effect.forkChild);
          const second = yield* Effect.exit(patch).pipe(Effect.forkChild);

          yield* waitUntil(lockWaiters.pipe(Effect.map((count) => count >= 2)));
          yield* Deferred.succeed(release, true);
          yield* Fiber.join(holder);

          const exits = [yield* Fiber.join(first), yield* Fiber.join(second)];
          const succeeded = exits.filter((exit) => Exit.isSuccess(exit));

          const failures = exits.flatMap((exit) =>
            Exit.isFailure(exit) ? [String(exit.cause)] : []
          );

          assert.lengthOf(succeeded, 1);
          assert.lengthOf(failures, 1);
          assert.include(failures[0] ?? "", "PatchTestFailed");
          assert.strictEqual(succeeded[0]?.value.version, 2);
        })
    );

    dbTest.effect(
      "a copy whose source a concurrent save changes copies the version it applies to",
      () =>
        Effect.gen(function* copyRace() {
          const { alice } = yield* AcmeFixture;
          const actor = Actor.of({ roleIds: [], userId: alice.id });

          const id = yield* seedRecord(alice.id, ACME.asset, {
            name: "before",
          });

          const save = (input: Parameters<typeof updateRecord>[0]) =>
            updateRecord(input).pipe(
              Effect.provideService(Actor, actor),
              Effect.provide(SaveServices)
            );

          const { holder, release } = yield* holdRow(id);

          const rename = yield* save({
            body: { name: "after" },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id,
          }).pipe(Effect.forkChild);

          yield* waitUntil(lockWaiters.pipe(Effect.map((count) => count >= 1)));

          const copy = yield* save({
            body: { status: null },
            endpointClassId: ACME.asset,
            evaluate: copyName,
            expectedVersion: null,
            id,
          }).pipe(Effect.forkChild);

          yield* waitUntil(lockWaiters.pipe(Effect.map((count) => count >= 2)));
          yield* Deferred.succeed(release, true);
          yield* Fiber.join(holder);

          const renamed = yield* Fiber.join(rename);
          const copied = yield* Fiber.join(copy);
          const values = asObject(asObject(copied.record).values);

          assert.strictEqual(renamed.version, 2);
          assert.strictEqual(copied.version, 3);
          assert.strictEqual(values.status, "after");
        })
    );

    dbTest.effect(
      "two concurrent JSON Patches on one revision through /api/v1: one applies, the other is 412",
      () =>
        Effect.gen(function* raceWithVersion() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;

          const created = yield* http.request("POST", API.asset, {
            ...callers.alice,
            body: { name: "H", status: "spare" },
          });

          const id = textOf(asObject(created.json).id);

          const patch = http.request("PATCH", `${API.asset}/${id}`, {
            ...callers.alice,
            headers: {
              "content-type": "application/json-patch+json",
              "if-match": '"1"',
            },
            rawBody: JSON.stringify([
              { op: "test", path: "/status", value: "spare" },
              { op: "replace", path: "/status", value: "in_use" },
            ]),
          });

          const { holder, release } = yield* holdRow(id);
          const first = yield* patch.pipe(Effect.forkChild);
          const second = yield* patch.pipe(Effect.forkChild);

          yield* waitUntil(lockWaiters.pipe(Effect.map((count) => count >= 2)));
          yield* Deferred.succeed(release, true);
          yield* Fiber.join(holder);

          const statuses = [
            (yield* Fiber.join(first)).status,
            (yield* Fiber.join(second)).status,
          ].toSorted((a, b) => a - b);

          assert.deepStrictEqual(statuses, [200, 412]);

          const after = asObject(
            (yield* http.get(`${API.asset}/${id}`, callers.alice)).json
          );

          assert.strictEqual(after.revision, 2);
          assert.strictEqual(after.status, "in_use");
        })
    );
  });
});
