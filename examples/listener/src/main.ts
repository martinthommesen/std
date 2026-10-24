import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Schema } from "effect";

import { startListener } from "./listener.ts";

NodeRuntime.runMain(
  Effect.gen(function* main() {
    // TCP's port range, not an application capacity limit. Zero is ephemeral.
    const port = yield* Config.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 0 })),
      "STD_LISTENER_PORT"
    ).pipe(Config.withDefault(8081));

    const origin = yield* startListener(port);

    yield* Effect.logInfo(
      `Listener ready: ${origin}/listener; receipts: ${origin}/receipts`
    );

    return yield* Effect.never;
  }).pipe(Effect.scoped)
);
