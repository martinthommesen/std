import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import {
  Command,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from "foldkit/story";
import { describe, expect, it } from "vitest";

import { LoadDeadLetters, OperateDeadDelivery } from "./command.ts";
import { delivery, loaded } from "./fixture.ts";
import { Message, OutMessage } from "./message.ts";
import { Operation } from "./model.ts";
import { init, update } from "./update.ts";

describe("dead-letter page", () => {
  it("confirms retry, keeps the row while executing, and only removes it after rereading", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedAction({ action: "retry", delivery })),
      model((page) => {
        expect(page.operation._tag).toBe("Confirming");
      }),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(Message.ClickedConfirm()),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog()
      ),
      model((page) => {
        expect(page.operation._tag).toBe("Executing");
        expect(
          Option.getOrThrow(AsyncData.getData(page.deliveries)).deliveries
        ).toHaveLength(1);
      }),
      Command.expectHas(
        OperateDeadDelivery({ action: "retry", deliveryId: delivery.id })
      ),
      Command.resolve(
        OperateDeadDelivery,
        Message.SucceededOperateDeadDelivery()
      ),
      Command.expectHas(
        LoadDeadLetters({
          limit: 25,
          offset: 0,
          requestId: 2,
          status: "dead",
          subscriptionId: "",
        })
      ),
      Command.resolve(
        LoadDeadLetters,
        Message.SucceededLoadDeadLetters({
          page: { deliveries: [], total: 0 },
          requestId: 2,
        })
      ),
      model((page) => {
        expect(
          Option.getOrThrow(AsyncData.getData(page.deliveries)).deliveries
        ).toHaveLength(0);
      })
    );
  });

  it("cancel and repeated confirm never run an extra task", () => {
    const confirming = update(
      loaded,
      Message.ClickedAction({ action: "discard", delivery })
    ).model;

    const cancelled = update(
      confirming,
      Message.GotDialogMessage({ message: Dialog.Message.RequestedClose() })
    );

    expect(cancelled.model.operation._tag).toBe("Idle");
    expect(
      update(cancelled.model, Message.ClickedConfirm()).commands
    ).toBeUndefined();
    const executing = update(confirming, Message.ClickedConfirm()).model;
    expect(
      update(executing, Message.ClickedConfirm()).commands
    ).toBeUndefined();
  });

  it("late reads are ignored and a failed task keeps the row and explains uncertainty", () => {
    expect(
      update(
        loaded,
        Message.SucceededLoadDeadLetters({
          page: { deliveries: [], total: 0 },
          requestId: 0,
        })
      ).model
    ).toBe(loaded);

    const confirming = update(
      loaded,
      Message.ClickedAction({ action: "discard", delivery })
    ).model;

    const executing = update(confirming, Message.ClickedConfirm()).model;
    story(
      update,
      given(executing),
      message(
        Message.FailedOperateDeadDelivery({ error: "The response was lost." })
      ),
      model((page) => {
        expect(page.operation).toStrictEqual(
          Operation.Failed({ error: "The response was lost." })
        );
        expect(
          Option.getOrThrow(AsyncData.getData(page.deliveries)).deliveries
        ).toHaveLength(1);
      })
    );
  });

  it("applies a subscription filter at offset zero and changes page size", () => {
    story(
      update,
      given(loaded),
      message(
        Message.UpdatedSubscription({ value: delivery.subscriptionId ?? "" })
      ),
      message(Message.ClickedApplyFilters()),
      Command.expectHas(
        LoadDeadLetters({
          limit: 25,
          offset: 0,
          requestId: 2,
          status: "dead",
          subscriptionId: delivery.subscriptionId ?? "",
        })
      ),
      Command.resolve(
        LoadDeadLetters,
        Message.SucceededLoadDeadLetters({
          page: { deliveries: [delivery], total: 70 },
          requestId: 2,
        })
      ),
      message(Message.SelectedPageSize({ value: "10" })),
      model((page) => {
        expect(page.limit).toBe(10);
      }),
      Command.expectHas(
        LoadDeadLetters({
          limit: 10,
          offset: 0,
          requestId: 3,
          status: "dead",
          subscriptionId: delivery.subscriptionId ?? "",
        })
      ),
      Command.resolve(
        LoadDeadLetters,
        Message.SucceededLoadDeadLetters({
          page: { deliveries: [delivery], total: 70 },
          requestId: 3,
        })
      )
    );
  });

  it("reports an ended session to the parent", () => {
    story(
      update,
      given(init(1).model),
      message(
        Message.FailedLoadDeadLetters({ error: "SessionEnded", requestId: 1 })
      ),
      expectOutMessage(OutMessage.SessionEnded()),
      model((page) => {
        expect(page.deliveries._tag).toBe("Loading");
      })
    );
  });
});
