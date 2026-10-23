/**
 * `party-foundation` (Contracts 11.3, 11.6; plan Step 3, workstream 3P;
 * decision 0024): every user has exactly one individual.
 *
 * - Every new user gets one with it, in the same operation, whichever path
 *   creates it (the generic API, `std bootstrap-admin` and seeds through
 *   `ensureUser`, a local child class of `core.user`), also when users are
 *   created concurrently.
 * - `core.user.individual` is read-only for every caller and unique.
 * - The `data` migration gives every existing user one through the save
 *   pipeline, with change entries naming it, also while users are created
 *   concurrently; a rerun changes nothing.
 *
 * The backfill of a real `v0.0.2` database, killed and resumed, is
 * `examples/quickstart/test/party-foundation-upgrade.test.ts`.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import {
  BUILT_IN_ROLE_IDS,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_FIELD_IDS,
} from "@std/definitions/well-known";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Exit, Fiber, Redacted, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { ensureUser } from "../src/auth/bootstrap-admin.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { CORE_SET_DIRECTORY } from "../src/config/set-files.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { runDataMigrations } from "../src/platform/data-migrations.ts";
import { PLATFORM_MIGRATIONS } from "../src/platform/migrations.ts";
import { migration0012 } from "../src/platform/migrations/0012-user-individuals.ts";
import { individualOf } from "../src/records/party-rules.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { objectOf, recordIn, signInAll, textOf } from "./authz-support.ts";
import { codeOf, readsTestLayer, recordPath } from "./reads-support.ts";
import {
  addOverride,
  createClass,
  ensureSite,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const PartyCountsSchema = Schema.Struct({
  distinctIndividuals: Schema.Int,
  individuals: Schema.Int,
  users: Schema.Int,
  usersWithIndividual: Schema.Int,
});

const decodeCounts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PartyCountsSchema)
);

/**
 * Users, users with an individual, distinct individuals they name, and all
 * individuals.
 */
const partyCounts = values(
  `SELECT json_build_object(
     'users', (SELECT count(*) FROM core."user"),
     'usersWithIndividual', (SELECT count(individual) FROM core."user"),
     'distinctIndividuals', (SELECT count(DISTINCT individual) FROM core."user"),
     'individuals', (SELECT count(*) FROM core.individual))::text AS value`
).pipe(
  Effect.flatMap(([text]) => decodeCounts(text ?? "")),
  Effect.orDie
);

/**
 * Asserts that every user has exactly one individual of its own and, when
 * only users create individuals, that there are no others.
 * @param exactly - Whether every individual belongs to a user.
 * @returns The number of users.
 */
const assertOneEach = (exactly: boolean) =>
  Effect.gen(function* oneIndividualEach() {
    const counts = yield* partyCounts;

    assert.strictEqual(counts.usersWithIndividual, counts.users);
    assert.strictEqual(counts.distinctIndividuals, counts.users);

    if (exactly) {
      assert.strictEqual(counts.individuals, counts.users);
    }

    return counts.users;
  });

const individualOfUser = (userId: string) =>
  values(
    `SELECT individual::text AS value FROM core."user" WHERE id = $1::uuid`,
    [userId]
  ).pipe(Effect.map(([id]) => id ?? ""));

/**
 * The operation of a record's latest change entry.
 * @param recordId - The record.
 * @returns Its operation ID.
 */
const operationOf = (recordId: string) =>
  values(
    `SELECT operation_id::text AS value FROM core.change WHERE record_id = $1::uuid ORDER BY record_version DESC LIMIT 1`,
    [recordId]
  ).pipe(Effect.map(([id]) => id ?? ""));

/**
 * The ID a resource's reference attribute points at (an EntityRef).
 * @param reference - The attribute value.
 * @returns The referenced ID, or an empty string.
 */
const refIdOf = (reference: JsonValue | undefined): string =>
  textOf(objectOf(reference).id);

/** The state of migration 12's ledger row, if it has one. */
const ledgerRow12 = values(
  "SELECT state AS value FROM core.platform_migration WHERE id = 12"
);

/**
 * Users as an earlier release left them: without an individual.
 * @param count - How many.
 * @returns Their IDs.
 */
const insertOldUsers = (count: number) =>
  values(
    `INSERT INTO core."user" (id, class_id, version, created_at, created_by, updated_at, updated_by, name, login, active)
     SELECT uuidv7(), $1::uuid, 1, now(), $2::uuid, now(), $2::uuid, 'Old User ' || g, 'old-' || g, true
     FROM generate_series(1, ${count}) AS g
     RETURNING id::text AS value`,
    [USER_CLASS_ID, SYSTEM_USER_ID]
  );

/**
 * The migrations with a defective 0012 whose batches claim to be done at
 * once, with the real one's checksum.
 */
const ENDING_EARLY = PLATFORM_MIGRATIONS.map((migration) =>
  migration.id === migration0012.id
    ? {
        ...migration0012,
        batch: () => Effect.succeed({ changed: 0, next: null }),
      }
    : migration
);

const account = (login: string) => ({
  login,
  name: `Seed ${login}`,
  password: Redacted.make(`${login}-${randomUUID()}`),
});

describe("party-foundation", () => {
  it("gives a user's individual the user's name, split into given and family names", () => {
    assert.deepStrictEqual(individualOf("Grace Brewster Hopper"), {
      familyName: "Hopper",
      givenName: "Grace Brewster",
      name: "Grace Brewster Hopper",
    });
    assert.deepStrictEqual(individualOf("  Administrator "), {
      familyName: "Administrator",
      givenName: "Administrator",
      name: "Administrator",
    });
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: 120_000 })(
    (dbTest) => {
      dbTest.effect(
        "every new user gets exactly one individual in its own operation, through the generic API, bootstrap and a local child class",
        () =>
          Effect.gen(function* everyNewUser() {
            const http = yield* TestHttpClient;
            const { tokens } = yield* signInAll;

            // The fixture's users and the system user already have theirs.
            const before = yield* assertOneEach(true);

            const created = yield* http.request("POST", "/api/v1/coreUser", {
              body: {
                active: true,
                login: `grace-${randomUUID().slice(0, 8)}`,
                name: "Grace Hopper",
                password: `pw-${randomUUID()}`,
              },
              token: tokens.admin,
            });

            assert.strictEqual(created.status, 201, created.text);

            const user = recordIn(created.json);
            const individualId = refIdOf(user.individual);

            const individual = yield* http.get(
              recordPath("core.individual", individualId),
              { token: tokens.admin }
            );

            assert.strictEqual(individual.status, 200, individual.text);
            assert.deepInclude(recordIn(individual.json), {
              familyName: "Hopper",
              givenName: "Grace",
              name: "Grace Hopper",
              status: "initialized",
            });
            // The user and its individual commit in one operation.
            assert.strictEqual(
              yield* operationOf(textOf(user.id)),
              yield* operationOf(individualId)
            );

            // std bootstrap-admin and seeds create users through ensureUser.
            const seeded = yield* ensureUser(account("seeded"), [
              BUILT_IN_ROLE_IDS.admin,
            ]);

            assert.notStrictEqual(yield* individualOfUser(seeded.userId), "");

            // A local child class of core.user.
            yield* ensureSite;

            const child = createClass("contractor", {
              parentId: USER_CLASS_ID,
            });

            yield* applyChangeSet({ operations: [child.op] });

            // The service assigns `individual`: a local child cannot make it
            // required (every create would fail before the assignment).
            const required = yield* applyChangeSet({
              operations: [
                addOverride(child.id, USER_FIELD_IDS.individual, {
                  required: true,
                }).op,
              ],
            }).pipe(Effect.flip);

            assert.strictEqual(required._tag, "DefinitionInvalid");
            assert.deepStrictEqual(
              required._tag === "DefinitionInvalid"
                ? required.problems.map((entry) => entry.code)
                : [],
              ["overrideInvalid"]
            );
            yield* (yield* Catalog).refresh;

            const contractor = yield* http.request(
              "POST",
              "/api/v1/siteContractor",
              {
                body: {
                  active: false,
                  login: `contractor-${randomUUID().slice(0, 8)}`,
                  name: "Kim",
                },
                token: tokens.admin,
              }
            );

            assert.strictEqual(contractor.status, 201, contractor.text);
            assert.isString(refIdOf(recordIn(contractor.json).individual));

            assert.strictEqual(yield* assertOneEach(true), before + 3);
          })
      );

      dbTest.effect(
        "the individual reference is read-only for every caller, unique, and keeps its individual",
        () =>
          Effect.gen(function* readOnlyReference() {
            const http = yield* TestHttpClient;
            const { fixture, tokens } = yield* signInAll;
            const aliceIndividual = yield* individualOfUser(fixture.alice.id);
            const bobIndividual = yield* individualOfUser(fixture.bob.id);

            const named = yield* http.request("POST", "/api/v1/coreUser", {
              body: {
                individual: aliceIndividual,
                login: `copy-${randomUUID().slice(0, 8)}`,
                name: "Copy",
              },
              token: tokens.admin,
            });

            assert.strictEqual(named.status, 422, named.text);
            assert.strictEqual(yield* codeOf(named), "ValidationFailed");

            const [version] = yield* values(
              `SELECT version::text AS value FROM core."user" WHERE id = $1::uuid`,
              [fixture.bob.id]
            );

            const moved = yield* http.request(
              "PATCH",
              recordPath("core.user", fixture.bob.id),
              {
                body: { individual: aliceIndividual },
                headers: { "if-match": `"${version ?? ""}"` },
                token: tokens.admin,
              }
            );

            assert.strictEqual(moved.status, 422, moved.text);
            assert.strictEqual(yield* codeOf(moved), "ValidationFailed");
            assert.strictEqual(
              yield* individualOfUser(fixture.bob.id),
              bobIndividual
            );

            // A user's individual cannot be deleted while the user names it.
            const [individualVersion] = yield* values(
              `SELECT version::text AS value FROM core.party WHERE id = $1::uuid`,
              [bobIndividual]
            );

            const deleted = yield* http.request(
              "DELETE",
              recordPath("core.individual", bobIndividual),
              {
                headers: { "if-match": `"${individualVersion ?? ""}"` },
                token: tokens.admin,
              }
            );

            assert.strictEqual(
              yield* codeOf(deleted),
              "Referenced",
              deleted.text
            );

            // Postgres itself refuses two users naming one individual.
            const shared = yield* values(
              `UPDATE core."user" SET individual = $1::uuid WHERE id = $2::uuid RETURNING id::text AS value`,
              [aliceIndividual, fixture.bob.id]
            ).pipe(Effect.exit);

            assert.isTrue(Exit.isFailure(shared));
            yield* assertOneEach(true);
          })
      );

      dbTest.effect(
        "users created concurrently each get exactly one individual",
        () =>
          Effect.gen(function* concurrentUsers() {
            const before = yield* assertOneEach(true);

            const created = yield* Effect.all(
              Array.from({ length: 24 }, (_, index) =>
                ensureUser(account(`parallel-${index}`), [])
              ),
              { concurrency: 12 }
            );

            assert.isTrue(
              created.every((entry) => entry.outcome === "created")
            );
            assert.strictEqual(yield* assertOneEach(true), before + 24);
          })
      );

      dbTest.effect(
        "an individual saved without a name gets one from its given and family names",
        () =>
          Effect.gen(function* derivedName() {
            const http = yield* TestHttpClient;
            const { tokens } = yield* signInAll;

            const created = yield* http.request(
              "POST",
              "/api/v1/coreIndividual",
              {
                body: { familyName: "Lovelace", givenName: "Ada" },
                token: tokens.admin,
              }
            );

            assert.strictEqual(created.status, 201, created.text);

            const record = recordIn(created.json);

            assert.strictEqual(record.name, "Ada Lovelace");

            const renamed = yield* http.request(
              "PATCH",
              recordPath("core.individual", textOf(record.id)),
              {
                body: { familyName: "King" },
                headers: { "if-match": `"${textOf(record.revision)}"` },
                token: tokens.admin,
              }
            );

            assert.strictEqual(renamed.status, 200, renamed.text);
            assert.strictEqual(recordIn(renamed.json).name, "Ada King");

            const cleared = yield* http.request(
              "PATCH",
              recordPath("core.individual", textOf(record.id)),
              {
                body: { name: null },
                headers: {
                  "if-match": `"${textOf(recordIn(renamed.json).revision)}"`,
                },
                token: tokens.admin,
              }
            );

            assert.strictEqual(cleared.status, 200, cleared.text);
            assert.strictEqual(recordIn(cleared.json).name, "Ada King");

            const named = yield* http.request(
              "POST",
              "/api/v1/coreIndividual",
              {
                body: {
                  familyName: "Byron",
                  givenName: "Augusta Ada",
                  name: "Countess of Lovelace",
                },
                token: tokens.admin,
              }
            );

            assert.strictEqual(
              recordIn(named.json).name,
              "Countess of Lovelace"
            );
          })
      );
    }
  );

  layer(schemaTestLayer(), { excludeTestServices: true, timeout: 120_000 })(
    (dbTest) => {
      dbTest.effect(
        "the backfill gives every user without one exactly one individual through the save pipeline, also while users are created, and a rerun changes nothing",
        () =>
          Effect.gen(function* backfill() {
            // The core set without its data migration: the state an
            // upgrade from v0.0.2 is in after the sets load.
            yield* loadSetDirectory(CORE_SET_DIRECTORY);

            yield* insertOldUsers(250);

            const migration = yield* runDataMigrations({ batchSize: 7 }).pipe(
              Effect.forkChild
            );

            const created = yield* Effect.all(
              Array.from({ length: 30 }, (_, index) =>
                ensureUser(account(`during-${index}`), [])
              ),
              { concurrency: 6 }
            );

            const [outcome] = yield* Fiber.join(migration);

            assert.strictEqual(outcome?.id, 12);
            assert.strictEqual(outcome?.outcome, "applied");
            // 250 old users and the system user, none of the new ones.
            assert.strictEqual(outcome?.changed, 251);
            assert.isTrue(
              created.every((entry) => entry.outcome === "created")
            );
            assert.strictEqual(yield* assertOneEach(true), 281);

            // Each backfilled user: one change entry for its individual and
            // one for itself, both naming the migration.
            const [entries] = yield* values(
              `SELECT count(*)::text AS value FROM core.change
               WHERE cause = '{"kind": "system", "migration": {"id": 12, "name": "user-individuals"}}'::jsonb`
            );

            assert.strictEqual(entries, "502");

            const [state] = yield* values(
              "SELECT state || ' ' || (progress ->> 'changed') AS value FROM core.platform_migration WHERE id = 12"
            );

            assert.strictEqual(state, "applied 251");

            const [changes] = yield* values(
              "SELECT count(*)::text AS value FROM core.change"
            );

            assert.deepStrictEqual(yield* runDataMigrations(), []);
            assert.deepStrictEqual(
              yield* values("SELECT count(*)::text AS value FROM core.change"),
              [changes]
            );
          })
      );
    }
  );

  layer(schemaTestLayer(), { excludeTestServices: true, timeout: 120_000 })(
    (dbTest) => {
      dbTest.effect(
        "an invalid batch size runs nothing and leaves the migration pending",
        () =>
          Effect.gen(function* invalidBatchSize() {
            yield* loadSetDirectory(CORE_SET_DIRECTORY);
            yield* insertOldUsers(5);

            for (const batchSize of [0, -1, 1.5, Number.NaN, 10_001]) {
              const refused = yield* runDataMigrations({ batchSize }).pipe(
                Effect.flip
              );

              assert.strictEqual(refused._tag, "DataBatchSizeInvalid");

              const upgrade = yield* runUpgrade({
                dataBatchSize: batchSize,
              }).pipe(Effect.flip);

              assert.strictEqual(upgrade._tag, "DataBatchSizeInvalid");
            }

            assert.deepStrictEqual(yield* ledgerRow12, []);
            assert.strictEqual((yield* partyCounts).usersWithIndividual, 0);

            const [outcome] = yield* runDataMigrations({ batchSize: 1 });

            assert.strictEqual(outcome?.changed, 6);
            yield* assertOneEach(true);
          })
      );
    }
  );

  layer(schemaTestLayer(), { excludeTestServices: true, timeout: 120_000 })(
    (dbTest) => {
      dbTest.effect(
        "a migration is applied only when nothing still needs it: batches that end early leave it running",
        () =>
          Effect.gen(function* proofOfCompletion() {
            yield* loadSetDirectory(CORE_SET_DIRECTORY);
            yield* insertOldUsers(5);

            const failed = yield* runDataMigrations({
              migrations: ENDING_EARLY,
            }).pipe(Effect.flip);

            assert.strictEqual(failed._tag, "DataMigrationFailed");
            assert.include(failed.message, "6 records still needing");
            assert.deepStrictEqual(yield* ledgerRow12, ["running"]);

            // The real migration resumes from the start and completes.
            const [outcome] = yield* runDataMigrations();

            assert.strictEqual(outcome?.outcome, "resumed");
            assert.strictEqual(outcome?.changed, 6);
            assert.deepStrictEqual(yield* ledgerRow12, ["applied"]);
            yield* assertOneEach(true);
          })
      );
    }
  );
});
