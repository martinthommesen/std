/**
 * Closed-loop load: a fixed number of clients, each running one operation
 * after another until told to stop.
 */
import { Effect } from "effect";

/** Set `stopped` to end a load run; clients finish their current operation. */
export interface StopSignal {
  stopped: boolean;
}

/**
 * A fresh stop signal.
 * @returns A signal that is not stopped.
 */
export const stopSignal = (): StopSignal => ({ stopped: false });

/**
 * Runs `clients` loops of `operation` concurrently until `stop` is set.
 * @param clients - Concurrent clients.
 * @param stop - Ends the run.
 * @param operation - One operation; its result is one sample.
 * @returns Every client's samples.
 */
export const runClients = <S, E, R>(
  clients: number,
  stop: StopSignal,
  operation: Effect.Effect<S, E, R>
): Effect.Effect<readonly S[], E, R> => {
  const client = Effect.gen(function* oneClient() {
    const samples: S[] = [];

    while (!stop.stopped) {
      samples.push(yield* operation);
    }

    return samples;
  });

  return Effect.all(
    Array.from({ length: clients }, () => client),
    { concurrency: clients }
  ).pipe(Effect.map((perClient) => perClient.flat()));
};
