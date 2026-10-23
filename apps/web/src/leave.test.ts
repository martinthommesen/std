/**
 * Leaving a form with unsaved edits: an in-app link opens the leave
 * confirmation instead of navigating, "Discard changes" follows the link,
 * "Keep editing" stays, and the page asks the browser to confirm an
 * unload only while edits are unsaved.
 */
import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { UrlRequest } from "foldkit/navigation";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";
import { describe, expect, it } from "vitest";

import { NavigateInternal } from "./command.ts";
import { adaAtHome, urlOf } from "./fixture.ts";
import {
  REVISION_5,
  TICKET,
  TICKET_FIELDS,
  TICKET_ID,
  ticketRecord,
  ticketTable,
} from "./form-fixture.ts";
import { subscriptions } from "./main.ts";
import { Message } from "./message.ts";
import type { Model, SignedInModel } from "./model.ts";
import { Message as RecordFormMessage } from "./page/record-form/message.ts";
import { FormMode } from "./page/record-form/model.ts";
import type { Model as RecordFormModel } from "./page/record-form/model.ts";
import {
  init as recordFormInit,
  update as recordFormUpdate,
} from "./page/record-form/update.ts";
import { AppRoute, PLAIN_LIST } from "./route.ts";
import { userTable } from "./table-fixture.ts";
import { update } from "./update.ts";

const formAfter = (
  start: RecordFormModel,
  ...messages: readonly RecordFormMessage[]
): RecordFormModel => {
  const [first, ...rest] = messages;

  return first === undefined
    ? start
    : formAfter(recordFormUpdate(start, first).model, ...rest);
};

const loadedTicket = formAfter(
  recordFormInit({
    id: 1,
    maybeAppRevision: Option.none(),
    mode: FormMode.Edit({ recordId: TICKET_ID }),
    table: TICKET,
  }).model,
  RecordFormMessage.SucceededLoadFormMetadata({
    revision: REVISION_5,
    table: ticketTable,
  }),
  RecordFormMessage.SucceededLoadRecord({
    generation: 1,
    maybeRevision: Option.none(),
    purpose: "Open",
    record: ticketRecord,
  }),
  RecordFormMessage.SucceededLoadTarget({ request: 1, table: userTable })
);

const onTicket = (page: RecordFormModel): SignedInModel =>
  modifyFields(adaAtHome, {
    maybeRecordForm: () => Option.some(page),
    nextPageId: () => 2,
    route: () =>
      AppRoute.Record({ ...PLAIN_LIST, id: TICKET_ID, table: TICKET }),
  });

/** Ada on the ticket's form, with a new short description not saved. */
const withUnsavedEdits = onTicket(
  formAfter(
    loadedTicket,
    RecordFormMessage.UpdatedText({
      fieldId: TICKET_FIELDS.shortDescription,
      text: "Black screen after the update",
    })
  )
);

const linkTo = (pathname: string) =>
  Message.ClickedLink({
    request: UrlRequest.Internal({ url: urlOf(pathname) }),
  });

const LIST = `/tables/${TICKET}`;

/** The list's address as the link hands it on: absolute. */
const LIST_URL = urlToString(urlOf(LIST));

const RECORD = `/tables/${TICKET}/records/${TICKET_ID}`;

const signedIn = (app: Model): SignedInModel => {
  if (app._tag !== "SignedIn") {
    throw new Error(`expected a signed-in state, found ${app._tag}`);
  }

  return app;
};

describe("leaving a form with unsaved edits", () => {
  it("an in-app link opens the leave confirmation, and Discard changes follows it", () => {
    story(
      update,
      given(withUnsavedEdits),
      message(linkTo(LIST)),
      Command.expectExact(
        Dialog.ShowDialog({
          focusSelector: "[data-foldkit-dialog-initial-focus]",
          id: "leave-confirmation",
        })
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      model((app) => {
        expect(signedIn(app).leaveDialog.isOpen).toBeTruthy();
        expect(signedIn(app).maybeLeaveUrl).toStrictEqual(
          Option.some(LIST_URL)
        );
        // Nothing has navigated: the form and its edits are still there.
        expect(signedIn(app).route._tag).toBe("Record");
      }),
      message(Message.ClickedDiscardChanges()),
      Command.expectExact(
        Dialog.CloseDialog({ id: "leave-confirmation" }),
        NavigateInternal({ url: LIST_URL })
      ),
      Command.resolveAll(
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
        [NavigateInternal, Message.CompletedNavigateInternal()]
      ),
      model((app) => {
        expect(signedIn(app).maybeLeaveUrl).toStrictEqual(Option.none());
      })
    );
  });

  it("Keep editing closes it and stays on the form", () => {
    story(
      update,
      given(withUnsavedEdits),
      message(linkTo(LIST)),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(
        Message.GotLeaveDialogMessage({
          message: Dialog.Message.RequestedClose(),
        })
      ),
      Command.expectExact(Dialog.CloseDialog({ id: "leave-confirmation" })),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog()
      ),
      model((app) => {
        expect(signedIn(app).leaveDialog.isOpen).toBeFalsy();
        expect(signedIn(app).maybeLeaveUrl).toStrictEqual(Option.none());
        expect(signedIn(app).maybeRecordForm).toStrictEqual(
          withUnsavedEdits.maybeRecordForm
        );
      })
    );
  });

  it("links leave a form without unsaved edits at once, and a link to the form itself never asks", () => {
    story(
      update,
      given(onTicket(loadedTicket)),
      message(linkTo(LIST)),
      Command.expectExact(NavigateInternal({ url: LIST_URL })),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
      model((app) => {
        expect(signedIn(app).leaveDialog.isOpen).toBeFalsy();
      })
    );

    story(
      update,
      given(withUnsavedEdits),
      message(linkTo(RECORD)),
      Command.expectExact(
        NavigateInternal({ url: urlToString(urlOf(RECORD)) })
      ),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
      model((app) => {
        expect(signedIn(app).leaveDialog.isOpen).toBeFalsy();
      })
    );
  });

  it("the page asks the browser to confirm an unload only while edits are unsaved", () => {
    const { modelToDependencies } = subscriptions.unsavedEdits;

    expect(
      [withUnsavedEdits, onTicket(loadedTicket), adaAtHome].map(
        (app) => modelToDependencies(app).isLeavingUnsavedEdits
      )
    ).toStrictEqual([true, false, false]);
  });
});
