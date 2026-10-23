/**
 * What form rules say on the form: a failed check, corrections and the
 * server's messages at the top, and a live region for what each check
 * found.
 */
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { buttonView } from "../../view/controls.ts";
import { checkErrorText, formNotices } from "./form-state-flow.ts";
import { Message } from "./message.ts";
import { WriteError } from "./model.ts";
import type { Model } from "./model.ts";

const checkRefusalView = (error: WriteError, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("form-alert form-check-refusal")],
    [
      h.p([], [checkErrorText(error)]),
      h.div(
        [h.Class("form-alert-actions")],
        [
          buttonView(
            {
              onClick: Message.ClickedRetryFormState(),
              text: "Check form again",
              variant: "quiet",
            },
            h
          ),
          WriteError.guards.VersionConflict(error)
            ? buttonView(
                {
                  onClick: Message.ClickedReloadRecord(),
                  text: "Reload the record, keeping my changes",
                  variant: "quiet",
                },
                h
              )
            : h.empty,
          WriteError.guards.UnknownField(error) ||
          WriteError.guards.SchemaChanged(error)
            ? buttonView(
                {
                  onClick: Message.ClickedReloadDefinition(),
                  text: "Reload the definition",
                  variant: "quiet",
                },
                h
              )
            : h.empty,
        ]
      ),
    ]
  );

/**
 * What the form rules say, at the top of the form with the save's
 * messages: a failed check (an alert, with the way to check again), the
 * corrections they make (notices), and the server's own messages, such as
 * why a record opens read-only (neutral information). While Save waits for
 * a check, the action bar says so.
 *
 * @param model - The form.
 * @param h - Its Html builder.
 * @returns The messages, nothing when there are none.
 */
export const formStateMessagesView = (
  model: Model,
  h: HtmlBuilder<Message>
): readonly Html[] => [
  Option.match(AsyncData.getError(model.formState), {
    onNone: () => h.empty,
    onSome: (error) => checkRefusalView(error, h),
  }),
  ...formNotices(model).map((notice) => h.p([h.Class("notice")], [notice])),
  ...Option.match(AsyncData.getData(model.formState), {
    onNone: () => [],
    onSome: (verdict) =>
      (verdict.messages ?? []).map((message) =>
        h.p([h.Class("form-info")], [message])
      ),
  }),
];

/**
 * The form rules' live region: what a check found, announced once, kept
 * rendered so each new announcement is read.
 *
 * @param model - The form.
 * @param h - Its Html builder.
 * @returns The region.
 */
export const formStateLiveRegionView = (
  model: Model,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.AriaLive("polite"), h.AriaAtomic(true), h.Class("visually-hidden")],
    [model.formAnnouncement]
  );
