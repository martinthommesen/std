import { assert, describe, it, layer } from "@effect/vitest";
/**
 * `std bootstrap-admin` (decision 0016): the first administrator of a new
 * install, created as the system user through the save pipeline, once per
 * login.
 */
import {
  BUILT_IN_ROLE_IDS,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { Plaintext } from "@std/values/write-only";
import { Effect, Layer, Redacted } from "effect";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { loadActor } from "../src/auth/actor.ts";
import {
  AdminBootstrapRefused,
  bootstrapAdmin,
} from "../src/auth/bootstrap-admin.ts";
import { signIn } from "../src/auth/sessions.ts";
import { SignInAdmission } from "../src/auth/sign-in-limits.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { InstanceSettings } from "../src/config/instance-settings.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { runCli } from "./cli-support.ts";
import { loadCore, schemaTestLayer, values } from "./schema-support.ts";

const FIRST = "first-test-password";
const SECOND = "second-test-password";

const account = (login: string, password: string) => ({
  login,
  name: "Test Administrator",
  password: Redacted.make(password),
});

/**
 * Signs in inside a request transaction.
 * @param login - The login.
 * @param password - The password.
 * @returns Whether sign-in succeeded.
 */
const canSignIn = (login: string, password: string) =>
  Effect.gen(function* trySignIn() {
    const { request } = yield* Transactions;
    const catalog = yield* Catalog;

    return yield* request(
      Effect.gen(function* signInNow() {
        return yield* signIn(
          yield* catalog.current,
          login,
          new Plaintext(password),
          "bootstrap-test"
        );
      })
    ).pipe(
      Effect.as(true),
      Effect.catchTag("InvalidCredentials", () => Effect.succeed(false))
    );
  });

const changeEntries = (classId: string) =>
  values(
    `SELECT count(*)::text AS value FROM core.change WHERE record_class_id = $1`,
    [classId]
  ).pipe(Effect.map(([count]) => Number(count)));

const recordEntries = (recordId: string) =>
  values(
    `SELECT count(*)::text AS value FROM core.change WHERE record_id = $1::uuid`,
    [recordId]
  ).pipe(Effect.map(([count]) => Number(count)));

const testLayer = InstanceSettings.layer.pipe(
  Layer.provideMerge(schemaTestLayer()),
  Layer.provideMerge(SignInAdmission.layer)
);

describe("bootstrap-admin", () => {
  it("tells the operator to run std upgrade first", () => {
    assert.include(
      new AdminBootstrapRefused({ reason: "coreSetNotLoaded" }).message,
      "run std upgrade first"
    );
  });

  layer(testLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "creates one administrator after the core set, once per login",
      () =>
        Effect.gen(function* createsOnce() {
          const early = yield* bootstrapAdmin(account("admin", FIRST)).pipe(
            Effect.flip
          );

          assert.deepStrictEqual(
            early._tag === "AdminBootstrapRefused" ? early.reason : early._tag,
            "coreSetNotLoaded"
          );

          yield* loadCore;

          const created = yield* bootstrapAdmin(account("admin", FIRST));

          assert.strictEqual(created.outcome, "created");

          // Saved through the pipeline: one change entry each for the user,
          // its individual (Contracts 11.3) and its role assignment.
          const [individual] = yield* values(
            `SELECT individual::text AS value FROM core."user" WHERE id = $1::uuid`,
            [created.userId]
          );

          assert.strictEqual(yield* recordEntries(created.userId), 1);
          assert.strictEqual(yield* recordEntries(individual ?? ""), 1);
          assert.strictEqual(yield* changeEntries(USER_ROLE_CLASS_ID), 1);

          // The same login, in another case and with another password, is
          // left alone: nothing is created and the password is unchanged.
          const again = yield* bootstrapAdmin(account(" ADMIN ", SECOND));

          assert.deepStrictEqual(again, {
            outcome: "exists",
            userId: created.userId,
          });
          assert.strictEqual(yield* recordEntries(created.userId), 1);
          assert.isTrue(yield* canSignIn("admin", FIRST));
          assert.isFalse(yield* canSignIn("admin", SECOND));

          const { request } = yield* Transactions;
          const catalog = yield* Catalog;

          const actor = yield* request(
            Effect.gen(function* actorOf() {
              return yield* loadActor(yield* catalog.current, created.userId);
            })
          );

          assert.include(actor.roleIds, BUILT_IN_ROLE_IDS.admin);
        })
    );

    dbTest.effect(
      "std bootstrap-admin reads its account from the environment",
      () =>
        Effect.gen(function* command() {
          const database = yield* TestDatabase;

          const missing = yield* runCli(database.url, ["bootstrap-admin"], {
            STD_ADMIN_PASSWORD: "",
          });

          assert.strictEqual(missing.code, 1, missing.output);

          const created = yield* runCli(database.url, ["bootstrap-admin"], {
            STD_ADMIN_LOGIN: "ops",
            STD_ADMIN_PASSWORD: FIRST,
          });

          assert.strictEqual(created.code, 0, created.output);
          assert.include(created.stdout, "Created the administrator");
          assert.notInclude(created.output, FIRST);
          assert.isTrue(yield* canSignIn("ops", FIRST));

          const again = yield* runCli(database.url, ["bootstrap-admin"], {
            STD_ADMIN_LOGIN: "ops",
            STD_ADMIN_PASSWORD: SECOND,
          });

          assert.strictEqual(again.code, 0, again.output);
          assert.include(again.stdout, "nothing changed");
          assert.isTrue(yield* canSignIn("ops", FIRST));

          const usage = yield* runCli(database.url, [
            "bootstrap-admin",
            "--password",
            SECOND,
          ]);

          assert.strictEqual(usage.code, 2, usage.output);
        })
    );
  });
});
