import { Dialog } from "@foldkit/ui";
import { DeadDelivery } from "@std/api/dead-letters";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

/** One confirmed page of the dead-letter collection. */
export const Page = Schema.Struct({
  deliveries: Schema.Array(DeadDelivery),
  total: Schema.Int,
});

/** The remotely loaded page. */
export const Deliveries = AsyncData.Schema(Page, Schema.String);

/** The task the operator wants to run. */
export const Action = Schema.Literals(["retry", "discard"]);

/** The task's confirmation and submission state. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md)
export const Operation = defineTaggedUnion({
  Confirming: { action: Action, delivery: DeadDelivery },
  Executing: { action: Action, delivery: DeadDelivery },
  Failed: { error: Schema.String },
  Idle: {},
});

/** The operator page, with no payload values or credentials. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md)
export const Model = Schema.Struct({
  appliedSubscriptionId: Schema.String,
  deliveries: Deliveries.schema,
  dialog: Dialog.Model,
  id: Schema.Int,
  limit: Schema.Int,
  offset: Schema.Int,
  operation: Operation,
  requestId: Schema.Int,
  subscriptionId: Schema.String,
});

/** The operator page's state. */
export type Model = typeof Model.Type;

/** The page sizes offered by the operator list. */
export const PAGE_SIZES: readonly string[] = ["10", "25", "100"];

/** Whether the page is waiting for a read or a confirmed task.
 * @param model - The operator page.
 * @returns Whether another operation must wait.
 */
export const isBusy = (model: Model): boolean =>
  AsyncData.isPending(model.deliveries) ||
  Operation.guards.Executing(model.operation);
