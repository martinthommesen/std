/**
 * The two-user example of Contracts 3.3 in a test database.
 *
 * The core and acme definition sets are loaded through the real loader
 * (`loadSetDirectory`, one change set each). Then, as table owner:
 *
 * - users Alice (role `asset_manager`) and Bob (role `employee`), with
 *   passwords, plus Carol (`employee`, deactivated);
 * - Bob's laptop L (cost 1200, docked to Alice's monitor), monitor M (cost
 *   300, not docked) and plain asset S (cost 2500, status `lost`);
 * - Alice's monitor AM and laptop K.
 *
 * TEMPORARY: users, roles and records are inserted with direct SQL
 * (`owner-records.ts`) until the save pipeline exists; the writes
 * workstream replaces these inserts with record-service creates.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { USER_CLASS_ID, USER_ROLE_CLASS_ID } from "@std/definitions/well-known";
import { setPasswordForDevelopment } from "@std/server/auth/dev-password";
import { Catalog } from "@std/server/catalog/catalog";
import { InstanceSettings } from "@std/server/config/instance-settings";
import { loadSetDirectory } from "@std/server/config/load-set";
import { CORE_SET_DIRECTORY } from "@std/server/config/set-files";
import { Transactions } from "@std/server/sql/transactions";
import { Context, Effect, Layer } from "effect";

import { insertAsOwner } from "./owner-records.ts";
import type { OwnerRecord } from "./owner-records.ts";
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

/**
 * Inserts a user with roles and a password, as table owner.
 *
 * @param snapshot - The configuration.
 * @param user - Name, login, password, roles and whether active.
 * @returns The user.
 */
export const insertUserAsOwner = Effect.fn("AcmeFixture.insertUser")(
  function* insertUserAsOwner(
    snapshot: ConfigSnapshot,
    user: {
      readonly name: string;
      readonly login: string;
      readonly password: string;
      readonly roles: readonly string[];
      readonly active: boolean;
    }
  ) {
    const [id = ""] = yield* insertAsOwner(snapshot, USER_CLASS_ID, [
      {
        values: {
          active: user.active ? "true" : "false",
          login: user.login,
          name: user.name,
        },
      },
    ]);

    if (user.roles.length > 0) {
      yield* insertAsOwner(
        snapshot,
        USER_ROLE_CLASS_ID,
        user.roles.map((role): OwnerRecord => ({
          values: { role: roleId(snapshot, role), user: id },
        }))
      );
    }

    yield* setPasswordForDevelopment(snapshot, id, user.password);

    return {
      id,
      login: user.login,
      password: user.password,
    } satisfies FixtureUser;
  }
);

const asset = (
  by: DefinitionId,
  values: Readonly<Record<string, string | null>>
): OwnerRecord => ({ by, id: randomUUID(), values: { owner: by, ...values } });

const insertAcmeRecords = Effect.fn("AcmeFixture.insertRecords")(
  function* insertAcmeRecords(snapshot: ConfigSnapshot) {
    const alice = yield* insertUserAsOwner(snapshot, {
      active: true,
      login: "alice",
      name: "Alice",
      password: "alice-password",
      roles: ["asset_manager"],
    });

    const bob = yield* insertUserAsOwner(snapshot, {
      active: true,
      login: "bob",
      name: "Bob",
      password: "bob-password",
      roles: ["employee"],
    });

    const carol = yield* insertUserAsOwner(snapshot, {
      active: false,
      login: "carol",
      name: "Carol",
      password: "carol-password",
      roles: ["employee"],
    });

    const [AM = ""] = yield* insertAsOwner(snapshot, ACME.monitor, [
      asset(alice.id, {
        cost: "400",
        name: "Alice monitor",
        purchased_on: "2025-02-01",
        size_inches: "27",
        status: "in_use",
      }),
    ]);

    const [K = ""] = yield* insertAsOwner(snapshot, ACME.laptop, [
      asset(alice.id, {
        cost: "1800",
        disk_key: "K-DISK-KEY",
        name: "K",
        purchased_on: "2025-03-01",
        serial: "SN-K",
        status: "in_use",
      }),
    ]);

    const [L = ""] = yield* insertAsOwner(snapshot, ACME.laptop, [
      asset(bob.id, {
        cost: "1200",
        disk_key: "L-DISK-KEY",
        docked_to: AM,
        name: "L",
        purchased_on: "2025-01-15",
        serial: "SN-L",
        status: "in_use",
      }),
    ]);

    const [M = ""] = yield* insertAsOwner(snapshot, ACME.monitor, [
      asset(bob.id, {
        cost: "300",
        name: "M",
        purchased_on: "2024-06-01",
        size_inches: "24",
        status: "in_use",
      }),
    ]);

    const [S = ""] = yield* insertAsOwner(snapshot, ACME.asset, [
      asset(bob.id, {
        cost: "2500",
        name: "S",
        purchased_on: "2023-03-10",
        status: "lost",
      }),
    ]);

    return {
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
