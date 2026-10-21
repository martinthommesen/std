import { Effect } from "effect";
import { HttpApiClient } from "effect/http-api";

import { StdApi } from "./drifted-api.ts";

/**
 * The same client code as `api-compatible`, compiled against a definition
 * whose sign-in endpoint changed incompatibly: `tsc` must fail here.
 */
export const signInAsAlice = Effect.gen(function* signInAsAlice() {
  const client = yield* HttpApiClient.make(StdApi, {
    baseUrl: "http://127.0.0.1:8080",
  });

  return yield* client.signIn.signIn({
    payload: { login: "alice", password: "alice-password" },
  });
});
