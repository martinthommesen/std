import { Effect } from "effect";
import { HttpApiClient } from "effect/http-api";

import { StdApi } from "../../../../packages/api/src/api.ts";

/**
 * Client code written against the shared `@std/api` definition: the same
 * sign-in call the live client test makes. It type-checks.
 */
export const signInAsAlice = Effect.gen(function* signInAsAlice() {
  const client = yield* HttpApiClient.make(StdApi, {
    baseUrl: "http://127.0.0.1:8080",
  });

  return yield* client.signIn.signIn({
    payload: { login: "alice", password: "alice-password" },
  });
});
