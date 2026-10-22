import { assert, describe, it, layer } from "@effect/vitest";
/**
 * The `std upgrade` and `std doctor` commands (Contracts 8.5, 1.10), as an
 * operator runs them: `--plan --json` prints a plan and changes nothing,
 * `--expect` applies exactly that plan, and `doctor` exits 0, 1 or 2.
 */
import { Effect, Schema } from "effect";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { runCli } from "./cli-support.ts";
import {
  catalogFingerprint,
  configFingerprint,
  FIXTURE,
} from "./config-support.ts";
import { currentRevision, schemaTestLayer, values } from "./schema-support.ts";

const PlanJson = Schema.fromJsonString(
  Schema.Struct({
    hash: Schema.String,
    refusals: Schema.Array(Schema.Struct({ code: Schema.String })),
    sets: Schema.Array(Schema.Struct({ name: Schema.String })),
  })
);

const DoctorJson = Schema.fromJsonString(
  Schema.Struct({
    exitCode: Schema.Int,
    findings: Schema.Array(
      Schema.Struct({ code: Schema.String, severity: Schema.String })
    ),
  })
);

const decodePlan = Schema.decodeUnknownSync(PlanJson);

const decodeDoctor = Schema.decodeUnknownSync(DoctorJson);

describe("cli", () => {
  it.effect("reports invalid TLS configuration as a startup failure", () =>
    Effect.gen(function* invalidTlsStartup() {
      const result = yield* runCli(
        "postgres://std:disposable-secret@db.example/std",
        ["doctor"],
        {
          STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE: "false",
          STD_DATABASE_SSL_MODE: "disable",
        }
      );

      assert.strictEqual(result.code, 1);
      assert.include(
        result.output,
        "Refusing plaintext Postgres on a non-loopback host"
      );
      assert.notInclude(result.output, "disposable-secret");
    })
  );

  it("decodes the plan's JSON form", () => {
    assert.deepStrictEqual(
      decodePlan('{"hash": "h", "refusals": [], "sets": [{"name": "core"}]}'),
      { hash: "h", refusals: [], sets: [{ name: "core" }] }
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "std upgrade --plan --json, then --expect applies the plan; std doctor exits 0, then 2",
      () =>
        Effect.gen(function* commands() {
          const database = yield* TestDatabase;
          const revision = yield* currentRevision;

          const fingerprint = Effect.all([
            catalogFingerprint,
            configFingerprint,
            currentRevision,
          ]);

          const before = yield* fingerprint;

          const jsonOnly = yield* runCli(database.url, [
            "upgrade",
            "--json",
            "--set",
            FIXTURE.v1,
          ]);

          assert.strictEqual(jsonOnly.code, 0, jsonOnly.output);
          assert.deepStrictEqual(
            decodePlan(jsonOnly.stdout).sets.map((set) => set.name),
            ["core", "fx"]
          );
          assert.deepStrictEqual(
            yield* fingerprint,
            before,
            "--json alone plans and changes nothing"
          );

          const planned = yield* runCli(database.url, [
            "upgrade",
            "--plan",
            "--json",
            "--set",
            FIXTURE.v1,
          ]);

          assert.strictEqual(planned.code, 0, planned.output);

          const plan = decodePlan(planned.stdout);

          assert.deepStrictEqual(
            plan.sets.map((set) => set.name),
            ["core", "fx"]
          );
          assert.strictEqual(yield* currentRevision, revision);

          const applied = yield* runCli(database.url, [
            "upgrade",
            "--expect",
            plan.hash,
            "--set",
            FIXTURE.v1,
          ]);

          assert.strictEqual(applied.code, 0, applied.output);
          assert.include(applied.output, "Set fx v1: completed");

          const stale = yield* runCli(database.url, [
            "upgrade",
            "--expect",
            plan.hash,
            "--set",
            FIXTURE.v2,
          ]);

          assert.strictEqual(stale.code, 1);
          assert.include(stale.output, "The database changed since the plan");

          const doctor = yield* runCli(database.url, ["doctor", "--json"]);
          const report = decodeDoctor(doctor.stdout);

          assert.strictEqual(doctor.code, 0, doctor.output);
          assert.strictEqual(report.exitCode, 0);

          yield* values("CREATE TABLE fx.stray (id integer)");

          const warned = yield* runCli(database.url, ["doctor"]);

          assert.strictEqual(warned.code, 2);
          assert.include(warned.output, "orphanTable");
        })
    );
  });
});
