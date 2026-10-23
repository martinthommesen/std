/** Pending checks stay quiet; verdict refusals and configured guidance have a live region. */
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
    [],
    [
      h.p([], [checkErrorText(error)]),
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
  );

/** Announces form checking without disabling editable controls.
 * @param model - The form.
 * @param h - Its Html builder.
 * @returns A persistent status region and retry action.
 */
export const formStateStatusView = (
  model: Model,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [],
    [
      AsyncData.isLoading(model.formState)
        ? h.p([], ["Checking form rules…"])
        : h.empty,
      Option.match(AsyncData.getError(model.formState), {
        onNone: () => h.empty,
        onSome: (error) => checkRefusalView(error, h),
      }),
      ...formNotices(model).map((notice) => h.p([h.Class("notice")], [notice])),
      ...Option.match(AsyncData.getData(model.formState), {
        onNone: () => [],
        onSome: (verdict) =>
          (verdict.messages ?? []).map((message) =>
            h.p([h.Class("field-help")], [message])
          ),
      }),
      h.div(
        [h.AriaLive("polite"), h.AriaAtomic(true), h.Class("visually-hidden")],
        [model.formAnnouncement]
      ),
    ]
  );
