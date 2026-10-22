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
import { describe, it } from "vitest";

import { LoadCurrentUser, ReplaceUrl, SignOut } from "./command.ts";
import { ada, adaAtHome, signInFromHome } from "./fixture.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import {
  Message as SignInMessage,
  RequestSession,
} from "./page/sign-in/sign-in.ts";
import { AppRoute } from "./route.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const banner = role("banner");

const primaryNav = role("navigation", { name: "Primary" });

const signOutButton = role("button", { name: "Sign out" });

describe("app", () => {
  it("checking the session announces itself", () => {
    scene(
      { update, view },
      given(Model.CheckingSession({ route: AppRoute.Home() })),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(role("status")).toHaveText("Checking your session…"),
      expect(role("main")).toHaveAttr("aria-busy", "true"),
      expect(banner).not.toExist()
    );
  });

  it("the signed-in shell shows who is signed in and where they are", () => {
    scene(
      { update, view },
      given(adaAtHome),
      expect(within(banner, text("Ada Lovelace"))).toExist(),
      expect(within(banner, signOutButton)).toBeEnabled(),
      expect(within(primaryNav, role("link", { name: "Home" }))).toHaveAttr(
        "aria-current",
        "page"
      ),
      expect(role("link", { name: "STD" })).toHaveAttr("href", "/"),
      expect(role("heading", { level: 1 })).toHaveText("Welcome, Ada Lovelace"),
      expect(role("heading", { name: "Tables" })).toExist(),
      expect(role("main")).toExist()
    );
  });

  it("signing out shows progress, then the sign-in page", () => {
    scene(
      { update, view },
      given(adaAtHome),
      click(signOutButton),
      expect(role("button", { name: "Signing out…" })).toBeDisabled(),
      Command.expectExact(SignOut),
      Command.resolve(SignOut, Message.SucceededSignOut()),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
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

  it("an unreachable server offers a retry", () => {
    scene(
      { update, view },
      given(Model.SessionUnavailable({ route: AppRoute.Home() })),
      expect(role("heading", { name: "STD is not reachable" })).toExist(),
      click(role("button", { name: "Try again" })),
      Command.expectExact(LoadCurrentUser),
      Command.resolve(
        LoadCurrentUser,
        Message.SucceededLoadCurrentUser({ user: ada })
      ),
      expect(within(banner, text("Ada Lovelace"))).toExist()
    );
  });

  it("an unknown path shows a not-found page with a way back", () => {
    scene(
      { update, view },
      given(
        Model.SignedOut({
          maybeReturnRoute: Option.none(),
          route: AppRoute.NotFound({ path: "/nope" }),
          signIn: signInFromHome.signIn,
        })
      ),
      expect(role("heading", { name: "Page not found" })).toExist(),
      expect(text("/nope")).toExist(),
      expect(role("link", { name: "Go to sign in" })).toHaveAttr(
        "href",
        "/sign-in"
      )
    );
  });

  it("signing in from the redirect lands back home with the user's name", () => {
    scene(
      { update, view },
      given(signInFromHome),
      type(label("Login"), "ada"),
      type(label("Password"), "ada-password"),
      submit(role("form", { name: "Sign in to STD" })),
      Command.expectExact(RequestSession),
      Command.resolve(
        RequestSession,
        SignInMessage.SucceededRequestSession({ user: ada })
      ),
      Command.expectExact(ReplaceUrl({ url: "/" })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      expect(within(banner, text("Ada Lovelace"))).toExist(),
      expect(role("heading", { name: "Welcome, Ada Lovelace" })).toExist()
    );
  });
});
