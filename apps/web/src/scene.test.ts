import { Option } from "effect";
import {
  Command,
  click,
  expect,
  given,
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
  SignOut,
} from "./command.ts";
import {
  ada,
  adaAtHome,
  signInOpenedDirectly,
  signInRedirectedFromHome,
} from "./fixture.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { Message as SignInMessage, SignIn } from "./page/sign-in/sign-in.ts";
import { AppRoute, homeRouter, signInRouter } from "./route.ts";
import { REVISION_3, adaTables } from "./table-fixture.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const banner = role("banner");

const primaryNav = role("navigation", { name: "Primary" });

const signOutButton = role("button", { name: "Sign out" });

const homeNavLink = within(primaryNav, role("link", { name: "Home" }));

const tablesNav = role("navigation", { name: "Tables" });

describe("app", () => {
  it("checking the session has a heading and announces itself", () => {
    scene(
      { update, view },
      given(Model.CheckingSession({ route: AppRoute.Home() })),
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
      expect(within(banner, signOutButton)).toBeEnabled(),
      expect(homeNavLink).toHaveAttr("aria-current", "page"),
      expect(role("link", { name: "STD" })).toHaveAttr("href", homeRouter()),
      expect(role("heading", { level: 1 })).toHaveText("Welcome, Ada Lovelace"),
      expect(role("heading", { name: "Tables" })).toExist(),
      expect(role("main")).toHaveAttr("id", "main")
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
      click(signOutButton),
      expect(role("button", { name: "Signing out…" })).toBeDisabled(),
      Command.expectExact(SignOut({ maybeRevision: Option.some(REVISION_3) })),
      Command.resolve(SignOut, Message.SucceededSignOut()),
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
      click(signOutButton),
      Command.resolve(SignOut, Message.FailedSignOut()),
      expect(within(banner, role("alert"))).toHaveText(
        "Signing out did not work. Try again."
      ),
      expect(signOutButton).toBeEnabled()
    );
  });

  it("an unreachable server is announced and offers a retry", () => {
    scene(
      { update, view },
      given(Model.SessionUnavailable({ route: AppRoute.Home() })),
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
          tables: adaTables.tables,
        })
      ),
      expect(within(tablesNav, role("link", { name: "Asset" }))).toHaveAttr(
        "href",
        "/tables/acme.asset"
      ),
      // Tables of several namespaces are grouped, one heading each.
      expect(
        within(tablesNav, role("heading", { level: 3, name: "acme" }))
      ).toExist(),
      expect(
        within(tablesNav, role("heading", { level: 3, name: "core" }))
      ).toExist()
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
        LoadTables({ maybeRevision: Option.some(REVISION_3) }),
        FocusMain()
      ),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()],
        [LoadTables, Message.FailedLoadTables()]
      ),
      expect(role("alert")).toContainText("The tables could not be loaded"),
      expect(within(banner, text("Ada Lovelace"))).toExist(),
      expect(role("heading", { name: "Welcome, Ada Lovelace" })).toExist()
    );
  });
});
