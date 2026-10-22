/**
 * How a `/api/v2` route ends (Contracts 10.6): every failure with an API
 * tag is answered with its TMF `Error`; anything else stays a defect, a
 * `500` without a body, as in v1 (3.8).
 */
import { Effect } from "effect";
import type { HttpServerResponse } from "effect/http";

import { isTmfFailure, tmfErrorResponse } from "./tmf-error.ts";

/**
 * Answers every API failure with its TMF `Error`.
 *
 * @param effect - A route's work.
 * @returns The response.
 */
export const answered = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  // oxlint-disable-next-line promise/valid-params, promise/prefer-await-to-then, github/no-then -- Effect.catch is not Promise.catch
  Effect.catch(effect, (failure) =>
    isTmfFailure(failure)
      ? Effect.succeed(tmfErrorResponse(failure))
      : Effect.die(failure)
  );
