import { Dialog, Menu } from "@foldkit/ui";
import { Effect, Option } from "effect";
import { reduce } from "effect/Array";
import { AsyncData } from "foldkit";
import { make as makeDate } from "foldkit/calendar";
import { Valid } from "foldkit/fieldValidation";
import { UrlRequest } from "foldkit/navigation";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { describe, expect, it } from "vitest";

import {
  FocusMain,
  LoadCurrentUser,
  LoadTables,
  LoadExternal,
  NavigateInternal,
  ReplaceUrl,
  SaveShellPreferences,
  SignOut,
} from "./command.ts";
import { FieldInput } from "./domain/form-input.ts";
import { fakeStdApi, tmfError } from "./fake-std-api.ts";
import {
  ada,
  adaAtHome,
  adaEnteringHome,
  signedIn,
  signInOpenedDirectly,
  signInRedirectedFromHome,
  urlOf,
} from "./fixture.ts";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import type { CurrentUser } from "./model.ts";
import { Model, SignOutRequest, Tables } from "./model.ts";
import { NAVIGATION_DRAWER_ID } from "./navigation-drawer.ts";
import { Message as RecordFormMessage } from "./page/record-form/message.ts";
import { FormMode } from "./page/record-form/model.ts";
import {
  Message as SignInMessage,
  SignIn,
  toMaybePassword,
} from "./page/sign-in/sign-in.ts";
import {
  LoadRecords,
  LoadTableMetadata,
  ReadToday,
  ReplaceListUrl,
} from "./page/table-list/command.ts";
import { Message as TableListMessage } from "./page/table-list/message.ts";
import { AppRoute, PLAIN_LIST, homeRouter, signInRouter } from "./route.ts";
import type { SignedOutRoute } from "./route.ts";
import { DEFAULT_SHELL_PREFERENCES } from "./shell-preferences.ts";
import {
  ASSET_FIELDS,
  REVISION_3,
  REVISION_4,
  revision,
  adaTables,
  assetTable,
  summaryOf,
} from "./table-fixture.ts";
import { update } from "./update.ts";

/** Choosing "Sign out" in the (closed, as in the fixtures) user menu. */
const selectedSignOut = Message.GotUserMenuMessage({
  message: Menu.Message.SelectedItem({ index: 0, item: "SignOut" }),
});

/** The flags of a browser that stored no preferences yet. */
const firstVisit = {
  maybePreferenceProblem: Option.none(),
  preferences: DEFAULT_SHELL_PREFERENCES,
};

const checkingAt = (pathname: string) =>
  init(firstVisit, urlOf(pathname)).model;

const loadedTables = Command.resolve(
  LoadTables,
  Message.SucceededLoadTables({
    revision: REVISION_3,
    sessionId: 1,
    tables: adaTables.tables,
  })
);

const signedOutAt = (route: SignedOutRoute) =>
  modifyFields(signInOpenedDirectly, { route: () => route });

const typeAndSubmit = (password: string) => [
  message(
    Message.GotSignInMessage({
      message: SignInMessage.UpdatedLogin({ value: "ada" }),
    })
  ),
  message(
    Message.GotSignInMessage({
      message: SignInMessage.UpdatedPassword({
        maybePassword: toMaybePassword(password),
      }),
    })
  ),
  message(Message.GotSignInMessage({ message: SignInMessage.SubmittedForm() })),
];

/**
 * Commands as their names and arguments, to compare.
 *
 * @param commands - The Commands.
 * @returns Name and arguments of each.
 */
const namesAndArgs = (
  commands: readonly { readonly name: string; readonly args?: unknown }[] = []
) => commands.map((command) => [command.name, command.args]);

describe("start-up", () => {
  it("asks the server for the session", () => {
    const initial = init(firstVisit, urlOf("/"));

    expect(initial.model).toStrictEqual(
      Model.CheckingSession({
        maybePreferenceProblem: Option.none(),
        preferences: DEFAULT_SHELL_PREFERENCES,
        route: AppRoute.Home(),
      })
    );
    expect(initial.commands).toStrictEqual([LoadCurrentUser()]);
  });

  it("a session lands on the page asked for", () => {
    story(
      update,
      given(checkingAt("/")),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.some(REVISION_3),
          maybeUser: Option.some(ada),
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(adaEnteringHome);
      }),
      Command.expectExact(
        LoadTables({ maybeRevision: Option.some(REVISION_3), sessionId: 1 })
      ),
      loadedTables,
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectNone()
    );
  });

  it("a session on the sign-in page redirects home, and the redirect's echo changes nothing", () => {
    story(
      update,
      given(checkingAt("/sign-in")),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.some(REVISION_3),
          maybeUser: Option.some(ada),
        })
      ),
      Command.expectExact(
        ReplaceUrl({ url: homeRouter() }),
        LoadTables({ maybeRevision: Option.some(REVISION_3), sessionId: 1 })
      ),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      loadedTables,
      message(Message.ChangedUrl({ url: urlOf(homeRouter()) })),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectNone()
    );
  });

  it("no session on a signed-in page redirects to sign-in and still remembers the page after the echo", () => {
    story(
      update,
      given(checkingAt("/")),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.none(),
          maybeUser: Option.none(),
        })
      ),
      Command.expectExact(ReplaceUrl({ url: signInRouter() })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      message(Message.ChangedUrl({ url: urlOf(signInRouter()) })),
      model((app) => {
        expect(app).toStrictEqual(signInRedirectedFromHome);
      }),
      Command.expectNone()
    );
  });

  it("no session on the sign-in page needs no redirect", () => {
    story(
      update,
      given(checkingAt("/sign-in")),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.none(),
          maybeUser: Option.none(),
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(signInOpenedDirectly);
      }),
      Command.expectNone()
    );
  });

  it("an unknown path stays not found without a session", () => {
    story(
      update,
      given(checkingAt("/no/such/page")),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.none(),
          maybeUser: Option.none(),
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(
          signedOutAt(AppRoute.NotFound({ path: "/no/such/page" }))
        );
      }),
      Command.expectNone()
    );
  });

  it("a route change while checking is where the session lands", () => {
    story(
      update,
      given(checkingAt("/sign-in")),
      message(Message.ChangedUrl({ url: urlOf("/elsewhere") })),
      Command.expectNone(),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.some(REVISION_3),
          maybeUser: Option.some(ada),
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaEnteringHome, {
            route: () => AppRoute.NotFound({ path: "/elsewhere" }),
          })
        );
      }),
      loadedTables
    );
  });

  it("an unreachable server can be retried, and fail again", () => {
    const unavailable = Model.SessionUnavailable({
      maybePreferenceProblem: Option.none(),
      preferences: DEFAULT_SHELL_PREFERENCES,
      route: AppRoute.Home(),
    });

    story(
      update,
      given(checkingAt("/")),
      message(Message.FailedLoadCurrentUser()),
      model((app) => {
        expect(app).toStrictEqual(unavailable);
      }),
      message(Message.ClickedRetrySessionCheck()),
      model((app) => {
        expect(app).toStrictEqual(
          Model.CheckingSession({
            maybePreferenceProblem: Option.none(),
            preferences: DEFAULT_SHELL_PREFERENCES,
            route: AppRoute.Home(),
          })
        );
      }),
      Command.expectExact(LoadCurrentUser()),
      Command.resolve(LoadCurrentUser, Message.FailedLoadCurrentUser()),
      model((app) => {
        expect(app).toStrictEqual(unavailable);
      })
    );
  });

  it("late answers and retries outside their state change nothing", () => {
    story(
      update,
      given(adaAtHome),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.none(),
          maybeUser: Option.none(),
        })
      ),
      message(Message.FailedLoadCurrentUser()),
      message(Message.ClickedRetrySessionCheck()),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectNone()
    );
  });
});

describe("signing in", () => {
  it("returns to the page asked for, with the user's name and no token or password", () => {
    story(
      update,
      given(signInRedirectedFromHome),
      ...typeAndSubmit("ada-password"),
      model((app) => {
        expect(JSON.stringify(app)).not.toContain("ada-password");
        expect(JSON.stringify(app)).toContain("<redacted:password>");
      }),
      Command.resolve(
        SignIn,
        SignInMessage.SucceededSignIn({
          maybeRevision: Option.some(REVISION_3),
          user: ada,
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(adaEnteringHome);
        expect(Object.keys(app).toSorted()).toStrictEqual([
          "_tag",
          "leaveDialog",
          "maybeDeadLetters",
          "maybeLeaveIntent",
          "maybePreferenceProblem",
          "maybeRecordForm",
          "maybeRevision",
          "maybeTableList",
          "navigationDrawer",
          "nextPageId",
          "preferences",
          "route",
          "sessionId",
          "signOutRequest",
          "tables",
          "user",
          "userMenu",
        ]);
      }),
      Command.expectExact(
        ReplaceUrl({ url: homeRouter() }),
        LoadTables({ maybeRevision: Option.some(REVISION_3), sessionId: 1 }),
        FocusMain()
      ),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      ),
      loadedTables
    );
  });

  it("from the sign-in page opened directly lands home", () => {
    story(
      update,
      given(signInOpenedDirectly),
      ...typeAndSubmit("ada-password"),
      Command.resolve(
        SignIn,
        SignInMessage.SucceededSignIn({
          maybeRevision: Option.some(REVISION_3),
          user: ada,
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(adaEnteringHome);
      }),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      ),
      loadedTables,
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      })
    );
  });

  it("a late sign-in answer after the session started changes nothing", () => {
    story(
      update,
      given(adaAtHome),
      message(
        Message.GotSignInMessage({
          message: SignInMessage.SucceededSignIn({
            maybeRevision: Option.some(REVISION_3),
            user: ada,
          }),
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectNone()
    );
  });

  it("leaving the sign-in page forgets the typed password, not the login", () => {
    story(
      update,
      given(signInOpenedDirectly),
      ...typeAndSubmit("ada-password").slice(0, 2),
      message(Message.ChangedUrl({ url: urlOf("/nope") })),
      Command.resolve(FocusMain, Message.CompletedFocusMain()),
      message(Message.ChangedUrl({ url: urlOf(signInRouter()) })),
      Command.resolve(FocusMain, Message.CompletedFocusMain()),
      model((app) => {
        const form = Model.guards.SignedOut(app) ? app.signIn : undefined;

        expect(form?.login).toStrictEqual(Valid({ value: "ada" }));
        expect(form?.password.value).toStrictEqual(Option.none());
      })
    );
  });

  it("a signed-out visitor sent home is redirected to sign-in", () => {
    story(
      update,
      given(signInOpenedDirectly),
      message(Message.ChangedUrl({ url: urlOf(homeRouter()) })),
      model((app) => {
        expect(app).toStrictEqual(signInRedirectedFromHome);
      }),
      Command.expectExact(ReplaceUrl({ url: signInRouter() })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });
});

/** The sign-in page after the app's first session ended. */
const signedOutAfterFirstSession = modifyFields(signInOpenedDirectly, {
  nextSessionId: () => 2,
});

describe("signing out", () => {
  it("page numbers go on across sign-out and sign-in, so an earlier session's answer reaches no page", () => {
    const pagesOpened = modifyFields(adaAtHome, { nextPageId: () => 7 });

    story(
      update,
      given(pagesOpened),
      message(selectedSignOut),
      Command.resolve(SignOut, Message.SucceededSignOut({ sessionId: 1 })),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      ),
      model((app) => {
        expect(Model.guards.SignedOut(app) ? app.nextPageId : 0).toBe(7);
      }),
      message(
        Message.GotSignInMessage({
          message: SignInMessage.SucceededSignIn({
            maybeRevision: Option.some(REVISION_3),
            user: ada,
          }),
        })
      ),
      model((app) => {
        expect(Model.guards.SignedIn(app) ? app.nextPageId : 0).toBe(7);
      }),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()],
        [LoadTables, Message.FailedLoadTables({ sessionId: 1 })]
      )
    );
  });

  it("ends on the sign-in page, with focus moved to it", () => {
    story(
      update,
      given(adaAtHome),
      message(selectedSignOut),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, {
            signOutRequest: () => SignOutRequest.Pending(),
          })
        );
      }),
      Command.expectExact(
        SignOut({ maybeRevision: Option.some(REVISION_3), sessionId: 1 })
      ),
      Command.resolve(SignOut, Message.SucceededSignOut({ sessionId: 1 })),
      model((app) => {
        expect(app).toStrictEqual(signedOutAfterFirstSession);
      }),
      Command.expectExact(ReplaceUrl({ url: signInRouter() }), FocusMain()),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      )
    );
  });

  it("a failure keeps the session and can be retried", () => {
    story(
      update,
      given(adaAtHome),
      message(selectedSignOut),
      Command.resolve(SignOut, Message.FailedSignOut({ sessionId: 1 })),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, {
            signOutRequest: () => SignOutRequest.Failed(),
          })
        );
      }),
      message(selectedSignOut),
      Command.expectExact(
        SignOut({ maybeRevision: Option.some(REVISION_3), sessionId: 1 })
      ),
      Command.resolve(SignOut, Message.SucceededSignOut({ sessionId: 1 })),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      ),
      model((app) => {
        expect(app).toStrictEqual(signedOutAfterFirstSession);
      })
    );
  });

  it("a second click while signing out does nothing", () => {
    const pending = modifyFields(adaAtHome, {
      signOutRequest: () => SignOutRequest.Pending(),
    });

    story(
      update,
      given(pending),
      message(selectedSignOut),
      Command.expectNone(),
      model((app) => {
        expect(app).toStrictEqual(pending);
      })
    );
  });

  it("sign-out answers after the session ended change nothing", () => {
    story(
      update,
      given(signInOpenedDirectly),
      message(selectedSignOut),
      message(Message.SucceededSignOut({ sessionId: 1 })),
      message(Message.FailedSignOut({ sessionId: 1 })),
      Command.expectNone(),
      model((app) => {
        expect(app).toStrictEqual(signInOpenedDirectly);
      })
    );
  });
});

describe("answers of an earlier session", () => {
  const bob: CurrentUser = {
    ...ada,
    name: "Bob Builder",
    user: {
      "@type": "CoreUserRef",
      id: "019a0000-0000-7000-8000-000000000002",
    },
  };

  const bobTables = [summaryOf("hd.ticket", "Ticket", false)];

  /** Bob, signed in after Ada's session ended, his tables still loading. */
  const bobEntering = modifyFields(adaEnteringHome, {
    maybeRevision: () => Option.some(REVISION_4),
    sessionId: () => 2,
    user: () => bob,
  });

  it("each session's requests carry its number, and the next session gets the next one", () => {
    const adaEntered = update(
      checkingAt("/"),
      Message.SucceededLoadCurrentUser({
        maybeRevision: Option.some(REVISION_3),
        maybeUser: Option.some(ada),
      })
    );

    const adaSigningOut = update(adaEntered.model, selectedSignOut);

    // Ada's session ends before her table list or sign-out is answered.
    const adaEnded = update(
      adaSigningOut.model,
      Message.FailedAuthentication({ sessionId: 1 })
    );

    const bobEntered = update(
      adaEnded.model,
      Message.GotSignInMessage({
        message: SignInMessage.SucceededSignIn({
          maybeRevision: Option.some(REVISION_4),
          user: bob,
        }),
      })
    );

    expect(namesAndArgs(adaEntered.commands)).toStrictEqual([
      ["LoadTables", { maybeRevision: Option.some(REVISION_3), sessionId: 1 }],
    ]);
    expect(namesAndArgs(adaSigningOut.commands)).toStrictEqual([
      ["SignOut", { maybeRevision: Option.some(REVISION_3), sessionId: 1 }],
    ]);
    expect(adaEnded.model).toStrictEqual(
      modifyFields(signInRedirectedFromHome, { nextSessionId: () => 2 })
    );
    expect(bobEntered.model).toStrictEqual(bobEntering);
    expect(namesAndArgs(bobEntered.commands)).toContainEqual([
      "LoadTables",
      { maybeRevision: Option.some(REVISION_4), sessionId: 2 },
    ]);
  });

  it("a late table list never shows the previous user's tables to the next one", () => {
    story(
      update,
      given(bobEntering),
      message(
        Message.SucceededLoadTables({
          revision: REVISION_3,
          sessionId: 1,
          tables: adaTables.tables,
        })
      ),
      model((app) => {
        expect(app).toStrictEqual(bobEntering);
      }),
      message(
        Message.SucceededLoadTables({
          revision: REVISION_4,
          sessionId: 2,
          tables: bobTables,
        })
      ),
      model((app) => {
        expect(signedIn(app).tables).toStrictEqual(
          Tables.Success({ data: { revision: REVISION_4, tables: bobTables } })
        );
      })
    );
  });

  it("a late ended session or failed table list leaves the next session alone", () => {
    story(
      update,
      given(bobEntering),
      message(Message.FailedAuthentication({ sessionId: 1 })),
      model((app) => {
        expect(app).toStrictEqual(bobEntering);
      }),
      message(Message.FailedLoadTables({ sessionId: 1 })),
      model((app) => {
        expect(app).toStrictEqual(bobEntering);
      }),
      Command.expectNone()
    );
  });

  it("a late sign-out answer leaves the next session alone", () => {
    const bobSigningOut = modifyFields(bobEntering, {
      signOutRequest: () => SignOutRequest.Pending(),
    });

    story(
      update,
      given(bobSigningOut),
      message(Message.SucceededSignOut({ sessionId: 1 })),
      model((app) => {
        expect(app).toStrictEqual(bobSigningOut);
      }),
      message(Message.FailedSignOut({ sessionId: 1 })),
      model((app) => {
        expect(app).toStrictEqual(bobSigningOut);
      }),
      Command.expectNone(),
      message(Message.SucceededSignOut({ sessionId: 2 })),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(signInOpenedDirectly, { nextSessionId: () => 3 })
        );
      }),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      )
    );
  });
});

describe("navigation", () => {
  it("another page moves focus to it; the sign-in page redirects a signed-in user home", () => {
    story(
      update,
      given(adaAtHome),
      message(Message.ChangedUrl({ url: urlOf("/elsewhere") })),
      model((app) => {
        expect(app.route).toStrictEqual(
          AppRoute.NotFound({ path: "/elsewhere" })
        );
      }),
      Command.expectExact(FocusMain()),
      Command.resolve(FocusMain, Message.CompletedFocusMain()),
      message(Message.ChangedUrl({ url: urlOf(signInRouter()) })),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectExact(ReplaceUrl({ url: homeRouter() }), FocusMain()),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      )
    );
  });

  it("an internal link pushes the address, an external one loads it", () => {
    story(
      update,
      given(adaAtHome),
      message(
        Message.ClickedLink({
          request: UrlRequest.Internal({ url: urlOf(homeRouter()) }),
        })
      ),
      Command.expectExact(NavigateInternal({ url: "http://localhost:5173/" })),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
      message(
        Message.ClickedLink({
          request: UrlRequest.External({ href: "https://example.com/" }),
        })
      ),
      Command.expectExact(LoadExternal({ href: "https://example.com/" })),
      Command.resolve(LoadExternal, Message.CompletedLoadExternal()),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      })
    );
  });

  it("the skip link moves focus to main and leaves the address as it is", () => {
    story(
      update,
      given(adaAtHome),
      message(
        Message.ClickedLink({
          request: UrlRequest.Internal({
            url: { ...urlOf(homeRouter()), hash: Option.some("main") },
          }),
        })
      ),
      Command.expectExact(FocusMain()),
      Command.resolve(FocusMain, Message.CompletedFocusMain()),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      })
    );
  });

  it("the navigation drawer opens as a modal dialog, focusing its first link, and closes on the next page", () => {
    story(
      update,
      given(adaAtHome),
      message(Message.ClickedOpenNavigation()),
      Command.expectExact(
        Dialog.ShowDialog({
          focusSelector: `#${NAVIGATION_DRAWER_ID} .nav-link`,
          id: NAVIGATION_DRAWER_ID,
        })
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      model((app) => {
        expect(signedIn(app).navigationDrawer.isOpen).toBeTruthy();
      }),
      // Following one of its links closes it; the new page takes focus.
      message(Message.ChangedUrl({ url: urlOf("/no/such/page") })),
      model((app) => {
        expect(signedIn(app).navigationDrawer.isOpen).toBeFalsy();
      }),
      Command.resolveAll(
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
        [FocusMain, Message.CompletedFocusMain()]
      )
    );
  });

  it("the Administration group remembers whether it is open, and says when the browser does not keep it", () => {
    story(
      update,
      given(adaAtHome),
      message(Message.ToggledAdministration({ isOpen: true })),
      Command.expectExact(
        SaveShellPreferences({ preferences: { isAdministrationOpen: true } })
      ),
      Command.resolve(
        SaveShellPreferences,
        Message.FailedSaveShellPreferences()
      ),
      model((app) => {
        expect(signedIn(app).preferences.isAdministrationOpen).toBeTruthy();
        expect(signedIn(app).maybePreferenceProblem).toStrictEqual(
          Option.some("Unsaved")
        );
      }),
      message(Message.ToggledAdministration({ isOpen: false })),
      Command.resolve(
        SaveShellPreferences,
        Message.CompletedSaveShellPreferences()
      ),
      model((app) => {
        expect(signedIn(app).preferences.isAdministrationOpen).toBeFalsy();
        expect(signedIn(app).maybePreferenceProblem).toStrictEqual(
          Option.none()
        );
      }),
      // The preferences go with the session to the next state.
      message(selectedSignOut),
      Command.resolve(SignOut, Message.SucceededSignOut({ sessionId: 1 })),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      ),
      model((app) => {
        expect(
          Model.guards.SignedOut(app) && app.preferences.isAdministrationOpen
        ).toBeFalsy();
      })
    );
  });

  it.each([
    ["could not be read", "Unreadable"],
    ["held something else", "Invalid"],
  ] as const)(
    "storage that %s starts with the defaults and keeps the problem into the signed-in state, until a store succeeds",
    (_case, problem) => {
      story(
        update,
        given(
          init(
            {
              maybePreferenceProblem: Option.some(problem),
              preferences: DEFAULT_SHELL_PREFERENCES,
            },
            urlOf("/")
          ).model
        ),
        model((app) => {
          expect(app).toStrictEqual(
            Model.CheckingSession({
              maybePreferenceProblem: Option.some(problem),
              preferences: DEFAULT_SHELL_PREFERENCES,
              route: AppRoute.Home(),
            })
          );
        }),
        message(
          Message.SucceededLoadCurrentUser({
            maybeRevision: Option.some(REVISION_3),
            maybeUser: Option.some(ada),
          })
        ),
        Command.resolve(LoadTables, Message.FailedLoadTables({ sessionId: 1 })),
        model((app) => {
          expect(signedIn(app).maybePreferenceProblem).toStrictEqual(
            Option.some(problem)
          );
        }),
        message(Message.ToggledAdministration({ isOpen: true })),
        Command.resolve(
          SaveShellPreferences,
          Message.CompletedSaveShellPreferences()
        ),
        model((app) => {
          expect(signedIn(app).maybePreferenceProblem).toStrictEqual(
            Option.none()
          );
        })
      );
    }
  );

  it("start-up takes the stored preferences into the signed-in state", () => {
    const opened = { isAdministrationOpen: true };

    story(
      update,
      given(
        init(
          {
            maybePreferenceProblem: Option.none(),
            preferences: opened,
          },
          urlOf("/")
        ).model
      ),
      message(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.some(REVISION_3),
          maybeUser: Option.some(ada),
        })
      ),
      model((app) => {
        expect(signedIn(app).preferences).toStrictEqual(opened);
      }),
      Command.resolve(LoadTables, Message.FailedLoadTables({ sessionId: 1 }))
    );
  });
});

describe("the session requests", () => {
  const ME = "GET /api/v1/session/current";

  const SIGN_OUT = "DELETE /api/v1/session/current";

  it("session/current: a user, no session, or an unreachable server", async () => {
    const withUser = fakeStdApi({
      [ME]: {
        body: ada,
        headers: { "std-schema-revision": REVISION_3 },
        status: 200,
      },
    });

    const withoutSession = fakeStdApi({
      [ME]: tmfError("Unauthenticated", 401),
    });

    const down = fakeStdApi({});

    const load = async (layer: typeof down.layer) =>
      await Effect.runPromise(
        LoadCurrentUser().effect.pipe(Effect.provide(layer))
      );

    await expect(load(withUser.layer)).resolves.toStrictEqual(
      Message.SucceededLoadCurrentUser({
        maybeRevision: Option.some(REVISION_3),
        maybeUser: Option.some(ada),
      })
    );
    await expect(load(withoutSession.layer)).resolves.toStrictEqual(
      Message.SucceededLoadCurrentUser({
        maybeRevision: Option.none(),
        maybeUser: Option.none(),
      })
    );
    await expect(load(down.layer)).resolves.toStrictEqual(
      Message.FailedLoadCurrentUser()
    );
    expect(withUser.seen[0]?.headers["std-client"]).toBe("web");
  });

  it("sign-out: ended, already ended, or not reached", async () => {
    const ended = fakeStdApi({ [SIGN_OUT]: { status: 204 } });

    const alreadyEnded = fakeStdApi({
      [SIGN_OUT]: tmfError("Unauthenticated", 401),
    });

    const down = fakeStdApi({});

    const signOut = async (layer: typeof down.layer) =>
      await Effect.runPromise(
        SignOut({
          maybeRevision: Option.some(REVISION_3),
          sessionId: 1,
        }).effect.pipe(Effect.provide(layer))
      );

    await expect(signOut(ended.layer)).resolves.toStrictEqual(
      Message.SucceededSignOut({ sessionId: 1 })
    );
    await expect(signOut(alreadyEnded.layer)).resolves.toStrictEqual(
      Message.SucceededSignOut({ sessionId: 1 })
    );
    await expect(signOut(down.layer)).resolves.toStrictEqual(
      Message.FailedSignOut({ sessionId: 1 })
    );
    expect(ended.seen[0]?.headers["std-client"]).toBe("web");
    expect(ended.seen[0]?.method).toBe("DELETE");
  });
});

const ASSETS = "acme.asset";

const assetsRoute = AppRoute.TableList({
  filter: Option.none(),
  limit: Option.none(),
  sort: Option.none(),
  table: ASSETS,
});

/** Ada opens the asset list from the home page. */
const openAssets = [
  message(Message.ChangedUrl({ url: urlOf("/tables/acme.asset") })),
  Command.expectExact(
    LoadTableMetadata({
      maybeRevision: Option.some(REVISION_3),
      table: ASSETS,
    }),
    ReadToday(),
    FocusMain()
  ),
  Command.resolveAll(
    [FocusMain, Message.CompletedFocusMain()],
    [
      ReadToday,
      TableListMessage.CompletedReadToday({
        today: makeDate(2026, 10, 22),
      }),
    ]
  ),
] as const;

describe("tables and revisions", () => {
  it("a list route opens the table's list page with the app's revision", () => {
    story(
      update,
      given(adaAtHome),
      ...openAssets,
      model((app) => {
        expect(Option.isSome(signedIn(app).maybeTableList)).toBeTruthy();
      }),
      Command.resolve(
        LoadTableMetadata,
        TableListMessage.FailedLoadTableMetadata({ error: "Unavailable" })
      )
    );
  });

  it("a newer revision a page saw reloads the table list in the background", () => {
    story(
      update,
      given(adaAtHome),
      ...openAssets,
      Command.resolve(
        LoadTableMetadata,
        TableListMessage.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: assetTable,
        })
      ),
      Command.expectHas(
        LoadTables({ maybeRevision: Option.some(REVISION_4), sessionId: 1 })
      ),
      model((app) => {
        expect(AsyncData.isRefreshing(signedIn(app).tables)).toBeTruthy();
        expect(signedIn(app).maybeRevision).toStrictEqual(
          Option.some(REVISION_4)
        );
      }),
      Command.resolveAll(
        [
          LoadTables,
          Message.SucceededLoadTables({
            revision: REVISION_4,
            sessionId: 1,
            tables: adaTables.tables,
          }),
        ],
        [ReplaceListUrl, TableListMessage.CompletedReplaceListUrl()],
        [
          LoadRecords,
          TableListMessage.FailedLoadRecords({
            error: "Unavailable",
            generation: 1,
            maybeRevision: Option.none(),
          }),
        ]
      ),
      model((app) => {
        expect(AsyncData.isSuccess(signedIn(app).tables)).toBeTruthy();
      })
    );
  });

  it("a page whose session ended sends the user to sign in, and back afterwards", () => {
    story(
      update,
      given(adaAtHome),
      ...openAssets,
      Command.resolve(
        LoadTableMetadata,
        TableListMessage.FailedAuthentication()
      ),
      model((app) => {
        expect(Model.guards.SignedOut(app)).toBeTruthy();
        expect(
          Model.guards.SignedOut(app) ? app.maybeReturnRoute : Option.none()
        ).toStrictEqual(Option.some(assetsRoute));
      }),
      Command.expectExact(ReplaceUrl({ url: signInRouter() }), FocusMain()),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      )
    );
  });

  it("the table list comes with the revision its response states, and a revision the database never had is dropped", async () => {
    const PATH = "/api/v1/tableMetadata";

    const listed = fakeStdApi({
      [PATH]: {
        body: adaTables.tables,
        headers: { "std-schema-revision": REVISION_3 },
        status: 200,
      },
    });

    await expect(
      Effect.runPromise(
        LoadTables({
          maybeRevision: Option.some(REVISION_4),
          sessionId: 1,
        }).effect.pipe(Effect.provide(listed.layer))
      )
    ).resolves.toStrictEqual(
      Message.SucceededLoadTables({
        revision: REVISION_3,
        sessionId: 1,
        tables: adaTables.tables,
      })
    );
    expect(listed.seen[0]?.headers["std-schema-revision"]).toBe(REVISION_4);

    const unknownRevision = fakeStdApi({
      [PATH]: tmfError("SchemaChanged", 409, {
        changes: [],
        currentRevision: REVISION_3,
        requestRevision: REVISION_4,
      }),
    });

    await expect(
      Effect.runPromise(
        LoadTables({
          maybeRevision: Option.some(REVISION_4),
          sessionId: 1,
        }).effect.pipe(Effect.provide(unknownRevision.layer))
      )
    ).resolves.toStrictEqual(Message.FailedLoadTables({ sessionId: 1 }));
    expect(
      unknownRevision.seen.map((seen) => seen.headers["std-schema-revision"])
    ).toStrictEqual([REVISION_4, undefined]);
  });
});

describe("review fixes: pages and revisions", () => {
  const atAssets = update(
    adaAtHome,
    Message.ChangedUrl({ url: urlOf("/tables/acme.asset") })
  ).model;

  const toUsers = update(
    atAssets,
    Message.ChangedUrl({ url: urlOf("/tables/core.user") })
  );

  it("an answer meant for a page the user has left reaches no page", () => {
    expect(
      signedIn(toUsers.model).maybeTableList.pipe(Option.map((page) => page.id))
    ).toStrictEqual(Option.some(2));

    const late = update(
      toUsers.model,
      Message.GotTableListMessage({
        message: TableListMessage.SucceededLoadTableMetadata({
          revision: REVISION_3,
          table: assetTable,
        }),
        pageId: 1,
      })
    );

    const refusedLate = update(
      toUsers.model,
      Message.GotTableListMessage({
        message: TableListMessage.FailedLoadTableMetadata({
          error: "UnknownTable",
        }),
        pageId: 1,
      })
    );

    expect(late.model).toStrictEqual(toUsers.model);
    expect(late.commands ?? []).toStrictEqual([]);
    expect(refusedLate.model).toStrictEqual(toUsers.model);
  });

  it("going from one table's list to another's moves focus to the new page", () => {
    expect((toUsers.commands ?? []).map((command) => command.name)).toContain(
      "FocusMain"
    );
  });

  it("a deep link's first requests carry the revision session/current stated", () => {
    const entered = update(
      init(firstVisit, urlOf("/tables/acme.asset")).model,
      Message.SucceededLoadCurrentUser({
        maybeRevision: Option.some(REVISION_3),
        maybeUser: Option.some(ada),
      })
    );

    expect(namesAndArgs(entered.commands)).toStrictEqual(
      expect.arrayContaining([
        [
          "LoadTables",
          { maybeRevision: Option.some(REVISION_3), sessionId: 1 },
        ],
        [
          "LoadTableMetadata",
          { maybeRevision: Option.some(REVISION_3), table: ASSETS },
        ],
      ])
    );
  });

  it("a SchemaChanged refusal's current revision replaces the app's, even a lower one", () => {
    const restored = revision("2.00000000-0000-4000-8000-000000000c02");

    const refused = update(
      atAssets,
      Message.GotTableListMessage({
        message: TableListMessage.FailedLoadRecords({
          error: "SchemaChanged",
          generation: 0,
          maybeRevision: Option.some(restored),
        }),
        pageId: 1,
      })
    );

    expect(signedIn(refused.model).maybeRevision).toStrictEqual(
      Option.some(restored)
    );
    expect(namesAndArgs(refused.commands)).toContainEqual([
      "LoadTables",
      { maybeRevision: Option.some(restored), sessionId: 1 },
    ]);
  });
});

const formOf = (app: Model) => signedIn(app).maybeRecordForm;

/**
 * A Message of the form page with number 1.
 *
 * @param formMessage - The form's Message.
 * @returns The app's Message.
 */
const toForm = (formMessage: RecordFormMessage): Message =>
  Message.GotRecordFormMessage({ message: formMessage, pageId: 1 });

/**
 * Applies Messages one after the other, keeping only the Model.
 *
 * @param start - The first Model.
 * @param messages - The Messages.
 * @returns The last Model.
 */
const afterAll = (start: Model, ...messages: readonly Message[]): Model =>
  reduce(
    messages,
    start,
    (current, nextMessage) => update(current, nextMessage).model
  );

describe("the form pages", () => {
  const RECORD_A = "019a0000-0000-7000-8000-00000000000a";

  const RECORD_B = "019a0000-0000-7000-8000-00000000000b";

  const atRecordA = update(
    adaAtHome,
    Message.ChangedUrl({ url: urlOf(`/tables/acme.asset/records/${RECORD_A}`) })
  );

  const atRecordB = update(
    atRecordA.model,
    Message.ChangedUrl({ url: urlOf(`/tables/acme.asset/records/${RECORD_B}`) })
  );

  it("a record's route opens its form with the app's revision; the new-record route a create form", () => {
    const creating = update(
      adaAtHome,
      Message.ChangedUrl({ url: urlOf("/tables/acme.asset/new") })
    );

    expect(namesAndArgs(atRecordA.commands)).toContainEqual([
      "LoadFormMetadata",
      { maybeRevision: Option.some(REVISION_3), table: ASSETS },
    ]);
    expect(
      [atRecordA.model, creating.model].map((app) =>
        formOf(app).pipe(Option.map((page) => page.mode))
      )
    ).toStrictEqual([
      Option.some(FormMode.Edit({ recordId: RECORD_A })),
      Option.some(FormMode.Create()),
    ]);
  });

  it("a form opened from a list keeps that list's address, and one opened directly the plain list", () => {
    const fromList = update(
      adaAtHome,
      Message.ChangedUrl({
        url: {
          ...urlOf(`/tables/acme.asset/records/${RECORD_A}`),
          search: Option.some("limit=50&sort=-name"),
        },
      })
    );

    expect(
      [fromList.model, atRecordA.model].map((app) =>
        formOf(app).pipe(Option.map((page) => page.listQuery))
      )
    ).toStrictEqual([
      Option.some({
        filter: Option.none(),
        limit: Option.some("50"),
        sort: Option.some("-name"),
      }),
      Option.some(PLAIN_LIST),
    ]);
  });

  it("another record opens another page, focused, and an answer meant for the first reaches no page", () => {
    const late = update(
      atRecordB.model,
      Message.GotRecordFormMessage({
        message: RecordFormMessage.FailedLoadFormMetadata({
          error: "UnknownTable",
        }),
        pageId: 1,
      })
    );

    expect(
      formOf(atRecordB.model).pipe(Option.map((page) => page.id))
    ).toStrictEqual(Option.some(2));
    expect((atRecordB.commands ?? []).map((command) => command.name)).toContain(
      "FocusMain"
    );
    expect(late.model).toStrictEqual(atRecordB.model);
  });

  it("leaving for a list closes the form; the same record's address keeps it", () => {
    const again = update(
      atRecordA.model,
      Message.ChangedUrl({
        url: urlOf(`/tables/acme.asset/records/${RECORD_A}`),
      })
    );

    const toList = update(
      atRecordA.model,
      Message.ChangedUrl({ url: urlOf("/tables/acme.asset") })
    );

    expect(again.model).toStrictEqual(atRecordA.model);
    expect(formOf(toList.model)).toStrictEqual(Option.none());
  });

  it("a create's success keeps its page as the new record's form, with the edits typed while it was in flight", () => {
    const created = afterAll(
      update(
        adaAtHome,
        Message.ChangedUrl({ url: urlOf("/tables/acme.asset/new") })
      ).model,
      toForm(
        RecordFormMessage.SucceededLoadFormMetadata({
          revision: REVISION_3,
          table: assetTable,
        })
      ),
      toForm(
        RecordFormMessage.UpdatedText({ fieldId: ASSET_FIELDS.name, text: "A" })
      ),
      toForm(RecordFormMessage.ClickedSave()),
      // Typed before the answer.
      toForm(
        RecordFormMessage.UpdatedText({
          fieldId: ASSET_FIELDS.name,
          text: "AB",
        })
      ),
      toForm(
        RecordFormMessage.SucceededSaveRecord({
          generation: 1,
          maybeRevision: Option.none(),
          saved: {
            class: ASSETS,
            id: RECORD_A,
            values: { name: "A" },
            version: 1,
          },
        })
      )
    );

    // The page's NavigateAway comes back as the new address.
    const arrived = update(
      created,
      Message.ChangedUrl({
        url: urlOf(`/tables/acme.asset/records/${RECORD_A}`),
      })
    );

    expect(
      formOf(arrived.model).pipe(
        Option.map((page) => [page.id, page.mode, page.edits])
      )
    ).toStrictEqual(
      Option.some([
        1,
        FormMode.Edit({ recordId: RECORD_A }),
        { [ASSET_FIELDS.name]: FieldInput.Text({ text: "AB" }) },
      ])
    );
    expect(
      (arrived.commands ?? []).map((command) => command.name)
    ).not.toContain("LoadFormMetadata");
  });

  it("a form page's ended session sends the user to sign in, and back afterwards", () => {
    const ended = update(
      atRecordA.model,
      Message.GotRecordFormMessage({
        message: RecordFormMessage.FailedAuthentication(),
        pageId: 1,
      })
    );

    expect(Model.guards.SignedOut(ended.model)).toBeTruthy();
    expect(
      Model.guards.SignedOut(ended.model) ? ended.model.maybeReturnRoute : null
    ).toStrictEqual(
      Option.some(
        AppRoute.Record({ ...PLAIN_LIST, id: RECORD_A, table: ASSETS })
      )
    );
  });
});
