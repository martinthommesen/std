import { Dialog, Menu } from "@foldkit/ui";
import { Option } from "effect";
import {
  Command,
  click,
  expect,
  given,
  Mount,
  label,
  role,
  scene,
  submit,
  text,
  type,
  within,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { describe, it } from "vitest";

import {
  FocusMain,
  LoadCurrentUser,
  LoadTables,
  ReplaceUrl,
  SaveShellPreferences,
  SignOut,
} from "./command.ts";
import {
  ada,
  adaAtHome,
  signInOpenedDirectly,
  signInRedirectedFromHome,
} from "./fixture.ts";
import { Message } from "./message.ts";
import { Model, Tables } from "./model.ts";
import { Message as SignInMessage, SignIn } from "./page/sign-in/sign-in.ts";
import { AppRoute, homeRouter, signInRouter } from "./route.ts";
import { DEFAULT_SHELL_PREFERENCES } from "./shell-preferences.ts";
import { REVISION_3, adaTables, summaryOf } from "./table-fixture.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const banner = role("banner");

const primaryNav = role("navigation", { name: "Primary" });

const userMenuButton = role("button", { name: "Ada Lovelace" });

const signOutItem = role("menuitem", { name: "Sign out" });

/** Opening the user menu: the click, and the menu's own focus move. */
const openUserMenu = [
  click(userMenuButton),
  Command.resolve(Menu.FocusItems, Menu.Message.CompletedFocusItems()),
  Mount.resolveAll(
    [Menu.PortalMenuBackdrop, Menu.Message.CompletedPortalMenuBackdrop()],
    [Menu.AnchorMenu, Menu.Message.CompletedAnchorMenu()]
  ),
];

/** Choosing "Sign out": the click, and the menu's focus moving back. */
const chooseSignOut = [
  click(signOutItem),
  Command.resolve(Menu.FocusButton, Menu.Message.CompletedFocusButton()),
  Mount.expectEnded(Menu.PortalMenuBackdrop),
  Mount.expectEnded(Menu.AnchorMenu),
];

const homeNavLink = within(primaryNav, role("link", { name: "Home" }));

const tablesNav = role("navigation", { name: "Tables" });

const administrationButton = within(
  tablesNav,
  role("button", { name: /^Administration/u })
);

describe("app", () => {
  it("checking the session has a heading and announces itself", () => {
    scene(
      { update, view },
      given(
        Model.CheckingSession({
          maybePreferenceProblem: Option.none(),
          preferences: DEFAULT_SHELL_PREFERENCES,
          route: AppRoute.Home(),
        })
      ),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(role("heading", { level: 1 })).toHaveText("STD"),
      expect(role("status")).toHaveText("Checking your session…"),
      expect(primaryNav).not.toExist()
    );
  });

  it("the signed-in shell shows who is signed in and where they are", () => {
    scene(
      { update, view },
      given(adaAtHome),
      expect(within(banner, text("Ada Lovelace"))).toExist(),
      expect(within(banner, userMenuButton)).toHaveAttr(
        "aria-haspopup",
        "menu"
      ),
      expect(homeNavLink).toHaveAttr("aria-current", "page"),
      expect(role("link", { name: "STD" })).toHaveAttr("href", homeRouter()),
      expect(role("link", { name: "Skip to content" })).toHaveAttr(
        "href",
        "#main"
      ),
      expect(role("heading", { level: 1 })).toHaveText("Welcome, Ada Lovelace"),
      expect(role("heading", { name: "Tables" })).toExist(),
      expect(role("main")).toHaveAttr("id", "main"),
      ...openUserMenu,
      expect(role("menu")).toContainText("Signed in as"),
      expect(signOutItem).toBeEnabled()
    );
  });

  it("the navigation drawer is a modal dialog holding the navigation, opened from the menu button and closed from its own", () => {
    const openNavigation = role("button", { name: "Open navigation" });
    const drawer = role("dialog", { name: "Navigation" });
    const sidebar = role("complementary", { name: "Navigation" });

    scene(
      { update, view },
      given(adaAtHome),
      expect(openNavigation).toHaveAttr("aria-haspopup", "dialog"),
      expect(drawer).not.toExist(),
      expect(within(sidebar, homeNavLink)).toExist(),
      click(openNavigation),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      expect(drawer).toHaveAttr("aria-modal", "true"),
      expect(within(drawer, homeNavLink)).toExist(),
      expect(within(drawer, administrationButton)).toExist(),
      // The navigation is in one place at a time, so its IDs stay unique.
      expect(within(sidebar, homeNavLink)).not.toExist(),
      click(role("button", { name: "Close navigation" })),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog()
      ),
      Mount.expectEnded(Dialog.AcquireResources),
      expect(drawer).not.toExist(),
      expect(within(sidebar, homeNavLink)).toExist()
    );
  });

  it.each([
    [
      "Invalid",
      "Could not restore the navigation preference. Administration starts closed. Open or close it to save the preference again.",
    ],
    [
      "Unreadable",
      "This browser did not let STD read whether Administration was open, so it starts closed.",
    ],
    [
      "Unsaved",
      "This browser did not store whether Administration is open; it starts closed next time.",
    ],
  ] as const)(
    "the navigation says when the browser could not keep its preferences (%s)",
    (problem, said) => {
      scene(
        { update, view },
        given(
          modifyFields(adaAtHome, {
            maybePreferenceProblem: () => Option.some(problem),
          })
        ),
        expect(
          within(role("complementary", { name: "Navigation" }), role("status"))
        ).toHaveText(said)
      );
    }
  );

  it("the Administration group holds the dead letters page for whoever may read subscriptions", () => {
    const withSubscriptions = modifyFields(adaAtHome, {
      route: () => AppRoute.DeadLetters(),
      tables: () =>
        Tables.Success({
          data: {
            revision: REVISION_3,
            tables: [
              ...adaTables.tables,
              summaryOf("core.subscription", "Subscription", true),
            ],
          },
        }),
    });

    scene(
      { update, view },
      given(withSubscriptions),
      expect(
        within(
          role("navigation", { name: "Administration pages" }),
          role("link", { name: "Dead letters" })
        )
      ).toHaveAttr("aria-current", "page"),
      expect(
        within(primaryNav, role("link", { name: "Dead letters" }))
      ).not.toExist(),
      expect(administrationButton).toContainText("3")
    );
  });

  it("a signed-in unknown path offers the way home and marks no nav item", () => {
    scene(
      { update, view },
      given(
        modifyFields(adaAtHome, {
          route: () => AppRoute.NotFound({ path: "/nope" }),
        })
      ),
      expect(role("heading", { name: "Page not found" })).toExist(),
      expect(role("link", { name: "Go to the home page" })).toHaveAttr(
        "href",
        homeRouter()
      ),
      expect(homeNavLink).not.toHaveAttr("aria-current")
    );
  });

  it("signing out shows progress, then the sign-in page", () => {
    scene(
      { update, view },
      given(adaAtHome),
      ...openUserMenu,
      ...chooseSignOut,
      expect(within(banner, role("status"))).toHaveText("Signing out…"),
      Command.expectHas(
        SignOut({ maybeRevision: Option.some(REVISION_3), sessionId: 1 })
      ),
      Command.resolve(SignOut, Message.SucceededSignOut({ sessionId: 1 })),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      ),
      expect(role("heading", { name: "Sign in to STD" })).toExist(),
      expect(text("Ada Lovelace")).not.toExist(),
      expect(primaryNav).not.toExist()
    );
  });

  it("a failed sign-out is announced and keeps the session", () => {
    scene(
      { update, view },
      given(adaAtHome),
      ...openUserMenu,
      ...chooseSignOut,
      Command.resolve(SignOut, Message.FailedSignOut({ sessionId: 1 })),
      expect(within(banner, role("alert"))).toHaveText(
        "Signing out did not work. Try again."
      ),
      Mount.expectEnded(Menu.PortalMenuBackdrop),
      Mount.expectEnded(Menu.AnchorMenu),
      ...openUserMenu,
      expect(signOutItem).toBeEnabled()
    );
  });

  it("an unreachable server is announced and offers a retry", () => {
    scene(
      { update, view },
      given(
        Model.SessionUnavailable({
          maybePreferenceProblem: Option.none(),
          preferences: DEFAULT_SHELL_PREFERENCES,
          route: AppRoute.Home(),
        })
      ),
      expect(role("heading", { name: "STD is not reachable" })).toExist(),
      expect(role("alert")).toContainText("The server did not answer."),
      click(role("button", { name: "Try again" })),
      Command.expectExact(LoadCurrentUser()),
      Command.resolve(
        LoadCurrentUser,
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.some(REVISION_3),
          maybeUser: Option.some(ada),
        })
      ),
      expect(within(banner, text("Ada Lovelace"))).toExist(),
      expect(role("status")).toHaveText("Loading the tables…"),
      Command.resolve(
        LoadTables,
        Message.SucceededLoadTables({
          revision: REVISION_3,
          sessionId: 1,
          tables: adaTables.tables,
        })
      ),
      expect(within(tablesNav, role("link", { name: "Asset" }))).toHaveAttr(
        "href",
        "/tables/acme.asset"
      ),
      // The app's tables come first, under their namespace; the
      // platform's are in the closed Administration group.
      expect(
        within(tablesNav, role("heading", { level: 2, name: "acme" }))
      ).toExist(),
      expect(administrationButton).toHaveAttr("aria-expanded", "false"),
      click(administrationButton),
      expect(administrationButton).toHaveAttr("aria-expanded", "true"),
      Command.expectExact(
        SaveShellPreferences({ preferences: { isAdministrationOpen: true } })
      ),
      Command.resolve(
        SaveShellPreferences,
        Message.CompletedSaveShellPreferences()
      ),
      expect(within(tablesNav, role("link", { name: "User" }))).toHaveAttr(
        "href",
        "/tables/core.user"
      )
    );
  });

  it("a signed-out unknown path shows a not-found page with a way to sign in", () => {
    scene(
      { update, view },
      given(
        modifyFields(signInOpenedDirectly, {
          route: () => AppRoute.NotFound({ path: "/nope" }),
        })
      ),
      expect(role("heading", { name: "Page not found" })).toExist(),
      expect(text("/nope")).toExist(),
      expect(role("link", { name: "Go to sign in" })).toHaveAttr(
        "href",
        signInRouter()
      )
    );
  });

  it("signing in from the redirect lands back home with the user's name", () => {
    scene(
      { update, view },
      given(signInRedirectedFromHome),
      type(label("Login"), "ada"),
      type(label("Password"), "ada-password"),
      submit(role("form", { name: "Sign in to STD" })),
      Command.expectExact(SignIn),
      Command.resolve(
        SignIn,
        SignInMessage.SucceededSignIn({
          maybeRevision: Option.some(REVISION_3),
          user: ada,
        })
      ),
      Command.expectExact(
        ReplaceUrl({ url: homeRouter() }),
        LoadTables({ maybeRevision: Option.some(REVISION_3), sessionId: 1 }),
        FocusMain()
      ),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()],
        [LoadTables, Message.FailedLoadTables({ sessionId: 1 })]
      ),
      expect(role("alert")).toContainText("The tables could not be loaded"),
      expect(within(banner, text("Ada Lovelace"))).toExist(),
      expect(role("heading", { name: "Welcome, Ada Lovelace" })).toExist()
    );
  });
});
