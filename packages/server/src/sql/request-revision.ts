/**
 * The configuration state a transaction runs at (Contracts 1.2, 1.3).
 */
import { Context, Effect, Schema } from "effect";

import { decodeRows } from "./rows.ts";

/** The `(revision, change_set_id)` a transaction runs at. */
export interface ConfigState {
  readonly revision: number;
  readonly changeSetId: string;
}

/**
 * The configuration state a request transaction runs at: the row
 * `core.begin_request()` returned. In a config commit it is the state read
 * under `CONFIG_KEY` before the commit bumps it.
 */
export class RequestRevision extends Context.Service<
  RequestRevision,
  ConfigState
>()("@std/server/sql/request-revision/RequestRevision") {}

/** `(revision, change_set_id)` rows; `int8` reads as text. */
const decodeConfigStateRows = decodeRows(
  Schema.Struct({ change_set_id: Schema.String, revision: Schema.String })
);

/**
 * Parses the one `(revision, change_set_id)` row of a query.
 * @param rows - The driver rows of `core.begin_request()` or `core.config_state`.
 * @returns The state; anything but one well-formed row is a defect.
 */
export const parseConfigState = (
  rows: readonly unknown[]
): Effect.Effect<ConfigState> =>
  decodeConfigStateRows(rows).pipe(
    Effect.flatMap(([row]) => {
      const revision = Number(row?.revision);

      return row !== undefined && Number.isSafeInteger(revision)
        ? Effect.succeed({ changeSetId: row.change_set_id, revision })
        : Effect.die(
            new RangeError("core.config_state did not return one valid row")
          );
    })
  );
