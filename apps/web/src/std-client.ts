import { authenticationClient, makeStdClient } from "@std/api/client";
import type { StdClient } from "@std/api/client";
import { Context, Effect, Layer } from "effect";
import { Http } from "foldkit";

/**
 * The typed client of STD's fixed endpoints, built once for the runtime
 * (its `resources`) from the shared `@std/api` definition.
 *
 * Requests go to the page's own origin. The session is the HTTP-only
 * cookie the server sets at sign-in, which the browser sends and no script
 * reads, so the client sends no token; it marks every request with
 * `STD-Client: web`, without which the server does not accept the cookie
 * on an unsafe request (decision 0018).
 */
export class StdApi extends Context.Service<StdApi, StdClient>()(
  "@std/web/std-client/StdApi"
) {
  /** The client over Foldkit's Fetch-backed `HttpClient`. */
  static readonly layer = Layer.effect(
    StdApi,
    makeStdClient({ webClient: true }).pipe(
      Effect.provide(authenticationClient())
    )
  ).pipe(Layer.provide(Http.layer));
}
