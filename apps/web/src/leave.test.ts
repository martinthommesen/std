import { Dialog, Menu } from "@foldkit/ui";
import { Option } from "effect";
/**
 * Leaving a form with unsaved edits: an in-app link opens the leave
 * confirmation instead of navigating, "Discard changes" follows the link,
 * "Keep editing" stays, and the page asks the browser to confirm an
 * unload only while edits are unsaved.
 */
import { UrlRequest } from "foldkit/navigation";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";
import { describe, expect, it } from "vitest";

import { NavigateInternal, SignOut } from "./command.ts";
import { adaAtHome, signedIn, urlOf } from "./fixture.ts";
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
import { LeaveIntent } from "./model.ts";
import type { SignedInModel } from "./model.ts";
import { formAfter } from "./page/record-form/fixture.ts";
import { Message as RecordFormMessage } from "./page/record-form/message.ts";
import { FormMode } from "./page/record-form/model.ts";
import type { Model as RecordFormModel } from "./page/record-form/model.ts";
import { init as recordFormInit } from "./page/record-form/update.ts";
import { AppRoute, PLAIN_LIST } from "./route.ts";
import { userTable } from "./table-fixture.ts";
import { update } from "./update.ts";

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

/** Ada on the ticket's form, with Points and Tracking typed but not convertible. */
const withMalformedInput = onTicket(
  formAfter(
    loadedTicket,
    RecordFormMessage.UpdatedText({
      fieldId: TICKET_FIELDS.points,
      text: "12x",
    })
  )
);

const withIncompleteJson = onTicket(
  formAfter(
    loadedTicket,
    RecordFormMessage.UpdatedText({
      fieldId: TICKET_FIELDS.tracking,
      text: '{ "carrier": ',
    })
  )
);

/** Choosing "Sign out" in the user menu. */
const selectedSignOut = Message.GotUserMenuMessage({
  message: Menu.Message.SelectedItem({ index: 0, item: "SignOut" }),
});

const linkTo = (pathname: string) =>
  Message.ClickedLink({
    request: UrlRequest.Internal({ url: urlOf(pathname) }),
  });

const LIST = `/tables/${TICKET}`;

/** The list's address as the link hands it on: absolute. */
const LIST_URL = urlToString(urlOf(LIST));

const RECORD = `/tables/${TICKET}/records/${TICKET_ID}`;

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
        expect(signedIn(app).maybeLeaveIntent).toStrictEqual(
          Option.some(LeaveIntent.FollowLink({ url: LIST_URL }))
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
        expect(signedIn(app).maybeLeaveIntent).toStrictEqual(Option.none());
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
        expect(signedIn(app).maybeLeaveIntent).toStrictEqual(Option.none());
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

  it("the page asks the browser to confirm an unload only while edits are unsaved, malformed ones too", () => {
    const { modelToDependencies } = subscriptions.unsavedEdits;

    expect(
      [
        withUnsavedEdits,
        withMalformedInput,
        withIncompleteJson,
        onTicket(loadedTicket),
        adaAtHome,
      ].map((app) => modelToDependencies(app).isLeavingUnsavedEdits)
    ).toStrictEqual([true, true, true, false, false]);
  });

  it.each([
    ["a number with a letter in it", withMalformedInput],
    ["incomplete JSON", withIncompleteJson],
  ])(
    "a link from a form holding %s, which a save cannot send, still asks",
    (_case, start) => {
      story(
        update,
        given(start),
        message(linkTo(LIST)),
        Command.expectExact(
          Dialog.ShowDialog({
            focusSelector: "[data-foldkit-dialog-initial-focus]",
            id: "leave-confirmation",
          })
        ),
        Command.resolve(
          Dialog.ShowDialog,
          Dialog.Message.SucceededShowDialog()
        ),
        model((app) => {
          expect(signedIn(app).maybeLeaveIntent).toStrictEqual(
            Option.some(LeaveIntent.FollowLink({ url: LIST_URL }))
          );
        })
      );
    }
  );

  it("Sign out from a form with unsaved edits asks first; Keep editing sends nothing", () => {
    story(
      update,
      given(withUnsavedEdits),
      message(selectedSignOut),
      Command.expectHas(
        Dialog.ShowDialog({
          focusSelector: "[data-foldkit-dialog-initial-focus]",
          id: "leave-confirmation",
        })
      ),
      model((app) => {
        expect(signedIn(app).maybeLeaveIntent).toStrictEqual(
          Option.some(LeaveIntent.SignOut())
        );
        expect(signedIn(app).signOutRequest._tag).toBe("Idle");
      }),
      Command.resolveAll(
        [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
        [Menu.FocusButton, Menu.Message.CompletedFocusButton()]
      ),
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
        expect(signedIn(app).signOutRequest._tag).toBe("Idle");
        expect(signedIn(app).maybeLeaveIntent).toStrictEqual(Option.none());
      })
    );
  });

  it("Discard changes signs out, once", () => {
    story(
      update,
      given(withUnsavedEdits),
      message(selectedSignOut),
      Command.resolveAll(
        [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
        [Menu.FocusButton, Menu.Message.CompletedFocusButton()]
      ),
      message(Message.ClickedDiscardChanges()),
      Command.expectExact(
        Dialog.CloseDialog({ id: "leave-confirmation" }),
        SignOut({
          maybeRevision: withUnsavedEdits.maybeRevision,
          sessionId: withUnsavedEdits.sessionId,
        })
      ),
      model((app) => {
        expect(signedIn(app).signOutRequest._tag).toBe("Pending");
        // A second Discard changes, while the first sign-out runs, sends
        // nothing more.
        expect(
          update(app, Message.ClickedDiscardChanges()).commands ?? []
        ).toStrictEqual([]);
      }),
      Command.resolveAll(
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
        [SignOut, Message.FailedSignOut({ sessionId: 1 })]
      )
    );
  });

  it("Sign out without unsaved edits goes at once", () => {
    story(
      update,
      given(onTicket(loadedTicket)),
      message(selectedSignOut),
      Command.expectHas(
        SignOut({
          maybeRevision: adaAtHome.maybeRevision,
          sessionId: adaAtHome.sessionId,
        })
      ),
      model((app) => {
        expect(signedIn(app).leaveDialog.isOpen).toBeFalsy();
      }),
      Command.resolveAll(
        [SignOut, Message.FailedSignOut({ sessionId: 1 })],
        [Menu.FocusButton, Menu.Message.CompletedFocusButton()]
      )
    );
  });
});
