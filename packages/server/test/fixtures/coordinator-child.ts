/**
 * Child process for the interrupted-change test: plays a server process
 * applying one change set as its coordinator, against `STD_DATABASE_URL`.
 *
 * It prints `BOUNDARY <label>` at every step boundary the coordinator
 * reports. At the boundary named by `STD_TEST_PAUSE_AT` it prints
 * `PAUSED <label>` and waits, so the test can SIGKILL it there; with
 * `STD_TEST_CONTINUE_ON_INPUT=1` it goes on once a line arrives on stdin.
 * With any other pause label it runs to the end.
 *
 * Usage: `node coordinator-child.ts`, with the change set's operations as
 * JSON in `STD_TEST_OPERATIONS`.
 */
import { NodeRuntime } from "@effect/platform-node";
import { OperationSchema } from "@std/definitions/operation";
import { Config, Console, Effect, Layer, Schema } from "effect";

import { Catalog } from "../../src/catalog/catalog.ts";
import { InstanceSettings } from "../../src/config/instance-settings.ts";
import { applyChangeSet } from "../../src/schema/change-set.ts";
import { StepBoundary } from "../../src/schema/recovery-settings.ts";
import { DatabaseConfig } from "../../src/sql/database-config.ts";
import { SqlLayer } from "../../src/sql/layer.ts";

/** `application_name` of the child's pooled connections. */
export const CHILD_APPLICATION_NAME = "std-coordinator-child";

const decodeOperations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OperationSchema))
);

const services = Layer.merge(Catalog.layer, InstanceSettings.layer).pipe(
  Layer.provideMerge(SqlLayer),
  Layer.provideMerge(DatabaseConfig.fromEnv(CHILD_APPLICATION_NAME))
);

/** Waits for one chunk on stdin. */
const nextInput = Effect.callback<string>((resume) => {
  process.stdin.once("data", (chunk: Uint8Array) => {
    resume(Effect.succeed(String(chunk)));
  });
});

const program = Effect.gen(function* coordinate() {
  const pauseAt = yield* Config.String("STD_TEST_PAUSE_AT");

  const continueOnInput = yield* Config.Boolean(
    "STD_TEST_CONTINUE_ON_INPUT"
  ).pipe(Config.withDefault(false));

  const wait = continueOnInput ? Effect.asVoid(nextInput) : Effect.never;

  const operations = yield* decodeOperations(
    yield* Config.String("STD_TEST_OPERATIONS")
  );

  const result = yield* applyChangeSet({ operations }).pipe(
    Effect.provideService(StepBoundary, (label) =>
      Console.log(`BOUNDARY ${label}`).pipe(
        Effect.andThen(
          label === pauseAt
            ? Console.log(`PAUSED ${label}`).pipe(Effect.andThen(wait))
            : Effect.void
        )
      )
    )
  );

  yield* Console.log(`RESULT ${result.state}`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(services)));
