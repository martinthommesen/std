import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { DEFAULT_PAGE_SIZE } from "../../domain/list-query.ts";
import type { StdApi } from "../../std-client.ts";
import { LoadDeadLetters, OperateDeadDelivery } from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { Deliveries, Operation, PAGE_SIZES, isBusy } from "./model.ts";
import type { Model } from "./model.ts";

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  StdApi
>;

type Step = Update.Step<Model, Message, StdApi>;

const load = (model: Model): UpdateReturn => ({
  commands: [
    LoadDeadLetters({
      limit: model.limit,
      offset: model.offset,
      requestId: model.requestId + 1,
      subscriptionId: model.appliedSubscriptionId,
    }),
  ],
  model: modifyFields(model, {
    deliveries: () => Deliveries.Loading(),
    requestId: (requestId) => requestId + 1,
  }),
});

/** Starts a fresh operator page.
 * @param id - The parent page identity.
 * @returns The loading Model and its read Command.
 */
export const init = (id: number): UpdateReturn =>
  load({
    appliedSubscriptionId: "",
    deliveries: Deliveries.Idle(),
    dialog: Dialog.init({ id: "dead-letter-confirmation" }),
    id,
    limit: DEFAULT_PAGE_SIZE,
    offset: 0,
    operation: Operation.Idle(),
    requestId: 0,
    subscriptionId: "",
  });

const foldDialogOutMessage = Dialog.OutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- keyed by the child's OutMessage tag
  Closed: () => (model) => ({
    model: Operation.guards.Confirming(model.operation)
      ? modifyFields(model, { operation: () => Operation.Idle() })
      : model,
  }),
  // oxlint-disable-next-line sonarjs/function-name -- keyed by the child's OutMessage tag
  Opened: () => (model) => ({ model }),
});

const dialogChild = {
  foldOutMessage: foldDialogOutMessage,
  read: (model: Model) => Option.some(model.dialog),
  toParentMessage: (message: Dialog.Message) =>
    Message.GotDialogMessage({ message }),
  write: (model: Model, nextDialog: Dialog.Model): Model =>
    modifyFields(model, { dialog: () => nextDialog }),
};

const foldDialog = Update.foldChild({
  ...dialogChild,
  update: Dialog.update,
});

const openDialog = Update.foldChildStep({
  ...dialogChild,
  update: Dialog.open,
});

const closeDialog = Update.foldChildStep({
  ...dialogChild,
  update: Dialog.close,
});

const failure = (model: Model, error: string): UpdateReturn => ({
  model: modifyFields(model, { operation: () => Operation.Failed({ error }) }),
});

/** Pure transitions; every successful operation is followed by a server read.
 * @param model - The current page.
 * @param message - What happened.
 * @returns The next Model, Commands and session OutMessage.
 */
export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    ClickedAction: ({ action, delivery }) => {
      const unavailable =
        action === "retry" && delivery.subscriptionState !== "served";

      if (
        isBusy(model) ||
        !Operation.guards.Idle(model.operation) ||
        unavailable
      ) {
        return { model };
      }

      return openDialog(
        modifyFields(model, {
          operation: () => Operation.Confirming({ action, delivery }),
        })
      );
    },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    ClickedApplyFilters: () =>
      isBusy(model)
        ? { model }
        : load(
            modifyFields(model, {
              appliedSubscriptionId: () => model.subscriptionId,
              offset: () => 0,
              operation: () => Operation.Idle(),
            })
          ),
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    ClickedConfirm: () => {
      if (!Operation.guards.Confirming(model.operation)) {
        return { model };
      }

      const { action, delivery } = model.operation;

      const dialogClose = closeDialog(
        modifyFields(model, {
          operation: () => Operation.Executing(),
        })
      );

      return {
        commands: [
          ...(dialogClose.commands ?? []),
          OperateDeadDelivery({ action, deliveryId: delivery.id }),
        ],
        model: dialogClose.model,
      };
    },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    ClickedNext: () =>
      isBusy(model)
        ? { model }
        : load(
            modifyFields(model, { offset: (offset) => offset + model.limit })
          ),
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    ClickedPrevious: () =>
      isBusy(model)
        ? { model }
        : load(
            modifyFields(model, {
              offset: (offset) => Math.max(0, offset - model.limit),
            })
          ),
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    ClickedRefresh: () =>
      isBusy(model)
        ? { model }
        : load(modifyFields(model, { operation: () => Operation.Idle() })),
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    FailedLoadDeadLetters: ({ error, requestId }) => {
      if (requestId !== model.requestId) {
        return { model };
      }

      return {
        model: modifyFields(model, {
          deliveries: () => Deliveries.Failure({ error }),
        }),
      };
    },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    FailedOperateDeadDelivery: ({ error }) =>
      Operation.guards.Executing(model.operation)
        ? failure(model, error)
        : { model },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    GotDialogMessage: ({ message: dialogMessage }) =>
      foldDialog(model, dialogMessage),
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    LoadDeadLettersSessionEnded: ({ requestId }) =>
      requestId === model.requestId
        ? { model, outMessage: OutMessage.SessionEnded() }
        : { model },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    OperateDeadDeliverySessionEnded: () =>
      Operation.guards.Executing(model.operation)
        ? { model, outMessage: OutMessage.SessionEnded() }
        : { model },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    SelectedPageSize: ({ value }) =>
      isBusy(model) || !PAGE_SIZES.includes(value)
        ? { model }
        : load(
            modifyFields(model, { limit: () => Number(value), offset: () => 0 })
          ),
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    SucceededLoadDeadLetters: ({ page, requestId }) =>
      requestId === model.requestId
        ? {
            model: modifyFields(model, {
              deliveries: () => Deliveries.Success({ data: page }),
            }),
          }
        : { model },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    SucceededOperateDeadDelivery: () =>
      Operation.guards.Executing(model.operation)
        ? load(
            modifyFields(model, {
              offset: () => 0,
              operation: () => Operation.Idle(),
            })
          )
        : { model },
    // oxlint-disable-next-line sonarjs/function-name -- keyed by the Message tag
    UpdatedSubscription: ({ value }) => ({
      model: modifyFields(model, { subscriptionId: () => value }),
    }),
  });
