import { Dialog } from "@foldkit/ui";
import { DeadDelivery } from "@std/api/dead-letters";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { Action, Page } from "./model.ts";

/** Facts from the operator, the Dialog and HTTP Commands. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md)
export const Message = defineMessageUnion({
  ClickedAction: { action: Action, delivery: DeadDelivery },
  ClickedApplyFilters: {},
  ClickedConfirm: {},
  ClickedNext: {},
  ClickedPrevious: {},
  ClickedRefresh: {},
  FailedLoadDeadLetters: { error: Schema.String, requestId: Schema.Int },
  FailedOperateDeadDelivery: { error: Schema.String },
  GotDialogMessage: { message: Dialog.Message },
  SelectedPageSize: { value: Schema.String },
  SucceededLoadDeadLetters: { page: Page, requestId: Schema.Int },
  SucceededOperateDeadDelivery: {},
  UpdatedStatus: { value: Schema.String },
  UpdatedSubscription: { value: Schema.String },
});

/** A fact the page handles. */
export type Message = typeof Message.Type;

/** Authentication belongs to the parent session. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md)
export const OutMessage = defineMessageUnion({ SessionEnded: {} });

/** A fact handled by the parent session. */
export type OutMessage = typeof OutMessage.Type;
