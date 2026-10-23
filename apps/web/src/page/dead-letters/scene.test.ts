import { Dialog } from "@foldkit/ui";
import {
  Command,
  Mount,
  click,
  expect,
  given,
  role,
  scene,
  text,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { describe, it } from "vitest";

import { LoadDeadLetters, OperateDeadDelivery } from "./command.ts";
import { delivery, loaded } from "./fixture.ts";
import { Message } from "./message.ts";
import { Deliveries } from "./model.ts";
import { init, update } from "./update.ts";
import { view } from "./view.ts";

describe("dead-letter page view", () => {
  it("shows an accessible list and confirms discard with its block consequence", () => {
    scene(
      { update, view },
      given(loaded),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Foldkit's scene assertion
      expect(role("table", { name: "Outbox dead deliveries" })).toExist(),
      click(role("button", { name: `Discard ${delivery.id}` })),
      expect(role("dialog", { name: "Discard this delivery?" })).toExist(),
      expect(text(/discarding releases later deliveries/u)).toExist(),
      Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      click(role("button", { name: "Confirm" })),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog()
      ),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.expectHas(
        OperateDeadDelivery({ action: "discard", deliveryId: delivery.id })
      ),
      Command.resolve(
        OperateDeadDelivery,
        Message.SucceededOperateDeadDelivery()
      ),
      Command.resolve(
        LoadDeadLetters,
        Message.SucceededLoadDeadLetters({
          page: { deliveries: [], total: 0 },
          requestId: 2,
        })
      ),
      expect(text("No dead deliveries match these filters.")).toExist()
    );
  });

  it("an emptied queue at a nonzero offset has no invented row range", () => {
    scene(
      { update, view },
      given(
        modifyFields(loaded, {
          deliveries: () =>
            Deliveries.Success({ data: { deliveries: [], total: 0 } }),
          offset: () => 25,
        })
      ),
      expect(role("status")).toHaveText(
        "0 dead deliveries. This page is empty."
      ),
      expect(role("button", { name: "Next page" })).toBeDisabled(),
      expect(role("button", { name: "Previous page" })).toBeEnabled(),
      click(role("button", { name: "Previous page" })),
      Command.resolve(
        LoadDeadLetters,
        Message.SucceededLoadDeadLetters({
          page: { deliveries: [], total: 0 },
          requestId: 2,
        })
      ),
      expect(role("status")).toHaveText(
        "0 dead deliveries. This page is empty."
      ),
      expect(role("button", { name: "Previous page" })).toBeDisabled()
    );
  });

  it("cancel closes the confirmation and leaves the row available", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: `Retry ${delivery.id}` })),
      expect(role("dialog", { name: "Retry this delivery?" })).toExist(),
      Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      click(role("button", { name: "Cancel" })),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog()
      ),
      Mount.expectEnded(Dialog.AcquireResources),
      expect(role("button", { name: `Retry ${delivery.id}` })).toExist()
    );
  });

  it("announces loading and list failure, then recovers through Refresh", () => {
    scene(
      { update, view },
      given(init(1).model),
      expect(role("status")).toHaveText("Waiting for STD…"),
      expect(role("button", { name: "Refresh" })).toBeDisabled(),
      expect(role("table", { name: "Outbox dead deliveries" })).not.toExist()
    );

    const failed = update(
      init(1).model,
      Message.FailedLoadDeadLetters({
        error: "The list is unavailable.",
        requestId: 1,
      })
    ).model;

    scene(
      { update, view },
      given(failed),
      expect(role("alert")).toHaveText("The list is unavailable."),
      click(role("button", { name: "Refresh" })),
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
          page: { deliveries: [delivery], total: 1 },
          requestId: 2,
        })
      ),
      expect(role("table", { name: "Outbox dead deliveries" })).toExist(),
      expect(role("alert")).not.toExist()
    );
  });

  it("a failed operation keeps the row, disables actions, and can recover by rereading", () => {
    const confirming = update(
      loaded,
      Message.ClickedAction({ action: "retry", delivery })
    ).model;

    const executing = update(confirming, Message.ClickedConfirm()).model;

    const failed = update(
      executing,
      Message.FailedOperateDeadDelivery({ error: "The response was lost." })
    ).model;

    scene(
      { update, view },
      given(failed),
      expect(role("alert")).toContainText("The response was lost."),
      expect(role("button", { name: `Retry ${delivery.id}` })).toBeDisabled(),
      expect(role("button", { name: `Discard ${delivery.id}` })).toBeDisabled(),
      click(role("button", { name: "Refresh" })),
      Command.resolve(
        LoadDeadLetters,
        Message.SucceededLoadDeadLetters({
          page: { deliveries: [delivery], total: 1 },
          requestId: 2,
        })
      ),
      expect(role("alert")).not.toExist(),
      expect(role("button", { name: `Retry ${delivery.id}` })).toBeEnabled()
    );
  });
});
