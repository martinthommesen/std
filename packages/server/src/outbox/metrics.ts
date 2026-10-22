/**
 * The outbox's metrics (Contracts 4.6: dead deliveries are "shown in an
 * admin view and a metric"). Effect metrics in the process registry; an
 * exporter comes with observability (Step 5).
 *
 * - `std_outbox_dead_deliveries` (gauge): `dead` rows in `core.delivery`,
 *   refreshed by the worker's housekeeping and after every operator retry
 *   or discard.
 * - `std_outbox_deliveries_done`, `_failed`, `_dead`, `_lease_lost`
 *   (counters): attempts this process finished that way.
 */
import { Effect, Metric, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { Transactions } from "../sql/transactions.ts";

/** Dead deliveries in the database. */
export const deadDeliveries = Metric.gauge("std_outbox_dead_deliveries", {
  description: "Outbox deliveries in status dead, waiting for an operator",
});

/** Attempts that ended `done`. */
export const deliveriesDone = Metric.counter("std_outbox_deliveries_done", {
  description: "Outbox delivery attempts that ended done",
});

/** Attempts that failed and will be retried. */
export const deliveriesFailed = Metric.counter("std_outbox_deliveries_failed", {
  description: "Outbox delivery attempts that failed and wait for a retry",
});

/** Attempts that failed for the last time (or whose lease expired). */
export const deliveriesDead = Metric.counter("std_outbox_deliveries_dead", {
  description: "Outbox delivery attempts that made the delivery dead",
});

/** Attempts whose result was discarded because the lease was lost. */
export const deliveriesLeaseLost = Metric.counter(
  "std_outbox_deliveries_lease_lost",
  { description: "Outbox delivery attempts whose lease was lost" }
);

const decodeCount = decodeRows(Schema.Struct({ n: Schema.Int }));

/**
 * Counts the `dead` rows and sets the gauge.
 *
 * @returns The count.
 */
export const refreshDeadGauge = Effect.fn("Outbox.refreshDeadGauge")(
  function* refreshDeadGauge() {
    const { request } = yield* Transactions;

    const rows = yield* request(
      SqlClient.SqlClient.pipe(
        Effect.flatMap((sql) =>
          readOnly(
            sql.unsafe(
              "SELECT count(*)::int AS n FROM core.delivery WHERE status = 'dead'"
            )
          )
        )
      )
    );

    const [row] = yield* decodeCount(rows);
    const count = row?.n ?? 0;

    yield* Metric.update(deadDeliveries, count);

    return count;
  }
);
