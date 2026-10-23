import "./styles.css";
import { Dialog } from "@foldkit/ui";
import type { DeadDelivery } from "@std/api/dead-letters";
import { Option } from "effect";
import { match as matchArray, isReadonlyArrayEmpty } from "effect/Array";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { buttonView, inputField, selectField } from "../../view/controls.ts";
import { Message } from "./message.ts";
import { Operation, PAGE_SIZES, isBusy } from "./model.ts";
import type { Model } from "./model.ts";

const ACTIONS_CLASS = "form-actions";

const rowView = (
  delivery: typeof DeadDelivery.Type,
  isDisabled: boolean,
  h: HtmlBuilder<Message>
): Html =>
  h.keyed("tr")(
    delivery.id,
    [],
    [
      h.td([], [delivery.id]),
      h.td([], [delivery.subscriptionId ?? ""]),
      h.td(
        [],
        [
          delivery.withheld?.includes("recordId") === true
            ? "Restricted"
            : (delivery.recordId ?? ""),
        ]
      ),
      h.td(
        [],
        [
          delivery.withheld?.includes("recordVersion") === true
            ? "Restricted"
            : String(delivery.recordVersion ?? ""),
        ]
      ),
      h.td([], [delivery.changeId ?? ""]),
      h.td([], [String(delivery.attempts ?? "")]),
      h.td([], [delivery.finishedAt ?? "Time unavailable"]),
      h.td([], [delivery.subscriptionState ?? "State unavailable"]),
      h.td([], [delivery.lastError ?? "No error recorded"]),
      h.td([], [delivery.deadLetterPolicy ?? "Subscription unavailable"]),
      h.td(
        [],
        [
          buttonView(
            {
              isDisabled: isDisabled || delivery.subscriptionState !== "served",
              onClick: Message.ClickedAction({ action: "retry", delivery }),
              text: `Retry ${delivery.id}`,
              variant: "quiet",
            },
            h
          ),
          buttonView(
            {
              isDisabled,
              onClick: Message.ClickedAction({ action: "discard", delivery }),
              text: `Discard ${delivery.id}`,
              variant: "quiet",
            },
            h
          ),
        ]
      ),
    ]
  );

const policyText = (
  action: "retry" | "discard",
  policy: typeof DeadDelivery.Type.deadLetterPolicy
): string => {
  if (policy === "block") {
    return action === "retry"
      ? "Under block, later deliveries for this record stay blocked until this delivery completes or is discarded."
      : "Under block, discarding releases later deliveries for this record.";
  }

  if (policy === "skip") {
    return "Under skip, later deliveries may already have run. A retry can arrive after newer versions.";
  }

  return "The subscription is no longer live. Under block, discard releases later deliveries; under skip, later deliveries may already have run and a retry can arrive out of order.";
};

const confirmationOf = (
  action: "retry" | "discard",
  delivery: typeof DeadDelivery.Type
): string => {
  const effect =
    action === "retry"
      ? "Attempts reset to zero and the delivery is queued again."
      : "The delivery is marked done without running its effect. This cannot be undone from this page.";

  return `Delivery ${delivery.id}. Subscription ${delivery.subscriptionId ?? "unknown"} is ${delivery.subscriptionState ?? "unknown"}. ${effect} ${policyText(action, delivery.deadLetterPolicy)}`;
};

const confirmationContentView = (
  model: Model,
  { title, description, closeButton }: Dialog.RenderInfo,
  h: HtmlBuilder<Message>
): readonly Html[] => {
  const content = Operation.guards.Confirming(model.operation)
    ? {
        description: confirmationOf(
          model.operation.action,
          model.operation.delivery
        ),
        title:
          model.operation.action === "retry"
            ? "Retry this delivery?"
            : "Discard this delivery?",
      }
    : { description: "", title: "Discard this delivery?" };

  return [
    h.h2([...title], [content.title]),
    h.p([...description], [content.description]),
    h.div(
      [h.Class(ACTIONS_CLASS)],
      [
        h.button([...closeButton, h.Class("button button-quiet")], ["Cancel"]),
        buttonView(
          {
            onClick: Message.ClickedConfirm(),
            text: "Confirm",
            variant: "primary",
          },
          h
        ),
      ]
    ),
  ];
};

const dialogView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    model: model.dialog,
    slotId: model.dialog.id,
    toParentMessage: (message) => Message.GotDialogMessage({ message }),
    view: Dialog.view,
    viewInputs: {
      hasDescription: true,
      toView: (render) =>
        h.dialog(
          [...render.dialog, h.Class("dialog")],
          render.isVisible
            ? [
                h.div([...render.backdrop, h.Class("dialog-backdrop")]),
                h.div(
                  [...render.panel, h.Class("dialog-panel")],
                  confirmationContentView(model, render, h)
                ),
              ]
            : []
        ),
    },
  });

const tableView = (
  deliveries: readonly (typeof DeadDelivery.Type)[],
  isDisabled: boolean,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.Class("dead-letters-table"),
      h.Role("region"),
      h.AriaLabel("Dead deliveries"),
      h.Tabindex(0),
    ],
    [
      h.table(
        [h.Class("records")],
        [
          h.caption([], ["Outbox dead deliveries"]),
          h.thead(
            [],
            [
              h.tr(
                [],
                [
                  "Delivery",
                  "Subscription",
                  "Record",
                  "Version",
                  "Change",
                  "Attempts",
                  "Time of death",
                  "Subscription state",
                  "Last error",
                  "Policy",
                  "Actions",
                ].map((heading) => h.th([h.Scope("col")], [heading]))
              ),
            ]
          ),
          h.tbody(
            [],
            deliveries.map((delivery) => rowView(delivery, isDisabled, h))
          ),
        ]
      ),
    ]
  );

const paginationView = (
  model: Model,
  total: number,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class(ACTIONS_CLASS)],
    [
      buttonView(
        {
          isDisabled:
            model.offset === 0 || Operation.guards.Executing(model.operation),
          onClick: Message.ClickedPrevious(),
          text: "Previous page",
          variant: "quiet",
        },
        h
      ),
      buttonView(
        {
          isDisabled:
            model.offset + model.limit >= total ||
            Operation.guards.Executing(model.operation),
          onClick: Message.ClickedNext(),
          text: "Next page",
          variant: "quiet",
        },
        h
      ),
    ]
  );

const listView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(AsyncData.getData(model.deliveries), {
    onNone: () => h.empty,
    onSome: (page) =>
      h.div(
        [],
        [
          h.p(
            [h.Role("status")],
            [
              isReadonlyArrayEmpty(page.deliveries)
                ? `${page.total} dead deliveries. This page is empty.`
                : `${page.total} dead deliveries. Showing ${model.offset + 1}–${model.offset + page.deliveries.length}.`,
            ]
          ),
          matchArray(page.deliveries, {
            onEmpty: () =>
              h.p(
                [],
                [
                  page.total === 0
                    ? "No dead deliveries match these filters."
                    : "No dead deliveries on this page. Go to the previous page or refresh.",
                ]
              ),
            onNonEmpty: (deliveries) =>
              tableView(deliveries, !Operation.guards.Idle(model.operation), h),
          }),
          paginationView(model, page.total, h),
        ]
      ),
  });

const filtersView = (
  model: Model,
  busy: boolean,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class(ACTIONS_CLASS)],
    [
      inputField(
        {
          id: "dead-letter-subscription",
          label: "Subscription ID",
          onInput: (value) => Message.UpdatedSubscription({ value }),
          value: model.subscriptionId,
        },
        h
      ),
      selectField(
        {
          id: "dead-letter-limit",
          isDisabled: busy,
          label: "Page size",
          onChange: (value) => Message.SelectedPageSize({ value }),
          options: PAGE_SIZES.map((value) => ({
            label: value,
            value,
          })),
          value: String(model.limit),
        },
        h
      ),
      buttonView(
        {
          isDisabled: busy,
          onClick: Message.ClickedApplyFilters(),
          text: "Apply filters",
          variant: "primary",
        },
        h
      ),
      buttonView(
        {
          isDisabled: busy,
          onClick: Message.ClickedRefresh(),
          text: "Refresh",
          variant: "quiet",
        },
        h
      ),
    ]
  );

/** An accessible operator list with a Foldkit UI confirmation Dialog.
 * @param model - The page state.
 * @param h - The typed builder.
 * @returns The page.
 */
export const view = Submodel.defineView<Model, Message>((model, h) => {
  const busy = isBusy(model);

  return h.div(
    [h.Class("page dead-letters")],
    [
      h.h1([], ["Dead letters"]),
      h.p(
        [],
        [
          "Review failed outbox deliveries, then retry or discard them. No record payloads are shown.",
        ]
      ),
      filtersView(model, busy, h),
      busy ? h.p([h.Role("status")], ["Waiting for STD…"]) : h.empty,
      AsyncData.match(model.deliveries, {
        onFailure: (error) => h.p([h.Role("alert")], [error]),
        onIdle: () => h.empty,
        onLoading: () => h.empty,
        onRefreshing: () => h.empty,
        onStale: ({ error }) => h.p([h.Role("alert")], [error]),
        onSuccess: () => h.empty,
      }),
      Operation.guards.Failed(model.operation)
        ? h.p(
            [h.Role("alert")],
            [model.operation.error, " Refresh before choosing another action."]
          )
        : h.empty,
      listView(model, h),
      dialogView(model, h),
    ]
  );
});
