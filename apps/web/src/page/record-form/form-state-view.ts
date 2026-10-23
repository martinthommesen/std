/** One persistent live region announces the binding verdict and definition-supplied notices. */
import { Match, Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { buttonView } from "../../view/controls.ts";
import { formNotices } from "./form-state-flow.ts";
import { Message } from "./message.ts";
import { WriteError } from "./model.ts";
import type { Model } from "./model.ts";

const checkErrorText = (error: WriteError): string =>
  Match.value(error).pipe(
    Match.tag(
      "Unavailable",
      () =>
        "The server did not answer the form check. Your input is kept; try again."
    ),
    Match.tag(
      "ValidationFailed",
      () => "The form could not be checked: review the marked fields."
    ),
    Match.tag(
      "InvalidReference",
      () =>
        "The form could not be checked: a chosen record is not available here."
    ),
    Match.tag(
      "UnknownField",
      () =>
        "The form could not be checked: a field is no longer available to you. Reload the definition."
    ),
    Match.tag(
      "NotAllowed",
      () => "You are not allowed to make this proposed change."
    ),
    Match.tag(
      "NotFound",
      () => "This record no longer exists, or you can no longer see it."
    ),
    Match.tag(
      "VersionConflict",
      ({ currentVersion }) =>
        `The record changed to version ${currentVersion}. Reload it, keeping your changes, before checking the form again.`
    ),
    Match.tag(
      "SchemaChanged",
      () =>
        "The definition changed. Your input is kept while the definition reloads."
    ),
    Match.tag(
      "Referenced",
      () => "The proposed change conflicts with records that refer to this one."
    ),
    Match.tag(
      "Refused",
      ({ message }) => `The form check was refused: ${message}`
    ),
    Match.exhaustive
  );

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
    [h.AriaLive("polite"), h.AriaAtomic(true)],
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
    ]
  );
