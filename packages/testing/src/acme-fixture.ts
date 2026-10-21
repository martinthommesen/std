/**
 * The two-user example of Contracts 3.3 in a test database.
 *
 * The core and acme definition sets are loaded through the real loader
 * (`loadSetDirectory`, one change set each). Then, through the record
 * service's save pipeline (with every record allowed: a seeding actor, no
 * access rules), so every record has its change entry:
 *
 * - users Alice (role `asset_manager`) and Bob (role `employee`), with
 *   passwords, plus Carol (`employee`, deactivated) and Ada (the built-in
 *   `admin` role);
 * - Bob's laptop L (cost 1200, docked to Alice's monitor), monitor M (cost
 *   300, not docked) and plain asset S (cost 2500, status `lost`);
 * - Alice's monitor AM and laptop K.
 *
 * Users and their role assignments are created by the system user; each
 * asset by its owner, so `created_by` is the owner.
 */
import { fileURLToPath } from "node:url";

import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { Actor } from "@std/server/auth/actor";
import { Catalog } from "@std/server/catalog/catalog";
import { InstanceSettings } from "@std/server/config/instance-settings";
import { loadSetDirectory } from "@std/server/config/load-set";
import { CORE_SET_DIRECTORY } from "@std/server/config/set-files";
import { SaveHooks } from "@std/server/records/save-hooks";
import { createRecord } from "@std/server/records/save-pipeline";
import { WriteAccess } from "@std/server/records/write-access";
import { WriteOnlyValues } from "@std/server/records/write-only-values";
import { Transactions } from "@std/server/sql/transactions";
import type { JsonValue } from "@std/values/json-value";
import { Context, Effect, Layer } from "effect";

import { testDatabaseLayer } from "./test-database.ts";
import type { TestDatabaseOptions } from "./test-database.ts";

/** The acme example set's directory. */
export const ACME_SET_DIRECTORY = fileURLToPath(
  new URL("../../../examples/acme", import.meta.url)
);

/** Stable IDs of the acme set. */
export const ACME = {
  asset: "989151bb-a69f-4b18-b73d-9e19a4e7514c",
  laptop: "6a365314-6d1b-4e4d-b166-73f29f808504",
  monitor: "87363f0e-8122-4569-8fc8-ec8c5277a71b",
} as const;

/** A fixture user. */
export interface FixtureUser {
  readonly id: DefinitionId;
  readonly login: string;
  readonly password: string;
}

/** What the fixture created. */
export interface AcmeData {
  readonly alice: FixtureUser;
  readonly bob: FixtureUser;
  /** An employee who has been deactivated. */
  readonly carol: FixtureUser;
  /** An administrator: the built-in `admin` role. */
  readonly admin: FixtureUser;
  /** Record IDs: Bob's L, M, S; Alice's monitor AM and laptop K. */
  readonly records: {
    readonly L: DefinitionId;
    readonly M: DefinitionId;
    readonly S: DefinitionId;
    readonly AM: DefinitionId;
    readonly K: DefinitionId;
  };
}

const roleId = (snapshot: ConfigSnapshot, name: string): DefinitionId => {
  const role = snapshot.roleByName(name);

  if (role === undefined) {
    throw new RangeError(`The acme set has no role ${name}`);
  }

  return role.id;
};

/** The seeding services: every record allowed, scrypt, no hooks. */
const SeedServices = Layer.mergeAll(
  WriteAccess.allowAll,
  SaveHooks.none,
  WriteOnlyValues.scrypt
);

/**
 * Creates one record through the save pipeline as a seeding actor.
 *
 * @param actorId - The acting (and auditing) user.
 * @param classId - The class to create.
 * @param body - Field values by name.
 * @returns The new record's ID.
 */
export const seedRecord = Effect.fn("AcmeFixture.seedRecord")(
  function* seedRecord(
    actorId: DefinitionId,
    classId: DefinitionId,
    body: Readonly<Record<string, JsonValue>>
  ) {
    const saved = yield* createRecord({ body, endpointClassId: classId }).pipe(
      Effect.provideService(Actor, Actor.of({ roleIds: [], userId: actorId })),
      Effect.provide(SeedServices)
    );

    return saved.id;
  }
);

/**
 * Creates a user with roles and a password through the save pipeline, as
 * the system user.
 *
 * @param snapshot - The configuration.
 * @param user - Name, login, password, roles and whether active.
 * @returns The user.
 */
export const createFixtureUser = Effect.fn("AcmeFixture.createUser")(
  function* createFixtureUser(
    snapshot: ConfigSnapshot,
    user: {
      readonly name: string;
      readonly login: string;
      readonly password: string;
      readonly roles: readonly string[];
      readonly active: boolean;
    }
  ) {
    const id = yield* seedRecord(SYSTEM_USER_ID, USER_CLASS_ID, {
      active: user.active,
      login: user.login,
      name: user.name,
      password: user.password,
    });

    for (const role of user.roles) {
      yield* seedRecord(SYSTEM_USER_ID, USER_ROLE_CLASS_ID, {
        role: roleId(snapshot, role),
        user: id,
      });
    }

    return {
      id,
      login: user.login,
      password: user.password,
    } satisfies FixtureUser;
  }
);

const asset = (
  owner: DefinitionId,
  classId: DefinitionId,
  values: Readonly<Record<string, JsonValue>>
) => seedRecord(owner, classId, { owner, ...values });

const insertAcmeRecords = Effect.fn("AcmeFixture.insertRecords")(
  function* insertAcmeRecords(snapshot: ConfigSnapshot) {
    const alice = yield* createFixtureUser(snapshot, {
      active: true,
      login: "alice",
      name: "Alice",
      password: "alice-password",
      roles: ["asset_manager"],
    });

    const bob = yield* createFixtureUser(snapshot, {
      active: true,
      login: "bob",
      name: "Bob",
      password: "bob-password",
      roles: ["employee"],
    });

    const carol = yield* createFixtureUser(snapshot, {
      active: false,
      login: "carol",
      name: "Carol",
      password: "carol-password",
      roles: ["employee"],
    });

    const admin = yield* createFixtureUser(snapshot, {
      active: true,
      login: "ada",
      name: "Ada",
      password: "ada-password",
      roles: ["admin"],
    });

    const AM = yield* asset(alice.id, ACME.monitor, {
      cost: "400",
      name: "Alice monitor",
      purchased_on: "2025-02-01",
      size_inches: 27,
      status: "in_use",
    });

    const K = yield* asset(alice.id, ACME.laptop, {
      cost: "1800",
      disk_key: "K-DISK-KEY",
      name: "K",
      purchased_on: "2025-03-01",
      serial: "SN-K",
      status: "in_use",
    });

    const L = yield* asset(bob.id, ACME.laptop, {
      cost: "1200",
      disk_key: "L-DISK-KEY",
      docked_to: AM,
      name: "L",
      purchased_on: "2025-01-15",
      serial: "SN-L",
      status: "in_use",
    });

    const M = yield* asset(bob.id, ACME.monitor, {
      cost: "300",
      name: "M",
      purchased_on: "2024-06-01",
      size_inches: 24,
      status: "in_use",
    });

    const S = yield* asset(bob.id, ACME.asset, {
      cost: "2500",
      name: "S",
      purchased_on: "2023-03-10",
      status: "lost",
    });

    return {
      admin,
      alice,
      bob,
      carol,
      records: { AM, K, L, M, S },
    } satisfies AcmeData;
  }
);

/** The fixture's data. */
export class AcmeFixture extends Context.Service<AcmeFixture, AcmeData>()(
  "@std/testing/acme-fixture/AcmeFixture"
) {
  /** Loads the sets and inserts the users and records. */
  static readonly layer = Layer.effect(
    AcmeFixture,
    Effect.gen(function* buildAcmeFixture() {
      const core = yield* loadSetDirectory(CORE_SET_DIRECTORY);

      yield* loadSetDirectory(ACME_SET_DIRECTORY, {
        required: new Map([[core.header.name, core.owner]]),
      });

      const { request } = yield* Transactions;
      const catalog = yield* Catalog;

      return AcmeFixture.of(
        yield* request(
          Effect.gen(function* insertAcmeData() {
            return yield* insertAcmeRecords(yield* catalog.current);
          })
        ).pipe(Effect.orDie)
      );
    })
  );
}

/**
 * A test database with the SQL layer, a catalog, the instance settings and
 * the acme fixture.
 *
 * @param options - Test database options.
 * @returns The layer.
 */
export const acmeTestLayer = (options: TestDatabaseOptions = {}) =>
  AcmeFixture.layer.pipe(
    Layer.provideMerge(Layer.merge(Catalog.layer, InstanceSettings.layer)),
    Layer.provideMerge(testDatabaseLayer(options))
  );
