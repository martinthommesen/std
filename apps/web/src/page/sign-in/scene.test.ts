import { Option } from "effect";
import {
  Command,
  expect,
  expectOutMessage,
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

import { ada } from "../../fixture.ts";
import { REVISION_3 } from "../../table-fixture.ts";
import {
  FocusField,
  Message,
  OutMessage,
  SignIn,
  init,
  toMaybePassword,
  update,
  view,
} from "./sign-in.ts";

const heading = role("heading", { name: "Sign in to STD" });

const form = role("form", { name: "Sign in to STD" });

const loginField = label("Login");

const passwordField = label("Password");

const signInButton = role("button", { name: "Sign in" });

const signingInButton = role("button", { name: "Signing in…" });

describe("sign-in", () => {
  it("shows a labelled form with required fields and the login focused first", () => {
    scene(
      { update, view },
      given(init()),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(heading).toExist(),
      expect(form).toExist(),
      expect(loginField).toHaveAttr("autocomplete", "username"),
      expect(loginField).toHaveAttr("autofocus"),
      expect(loginField).toHaveAttr("aria-required", "true"),
      expect(passwordField).toHaveAttr("type", "password"),
      expect(passwordField).toHaveAttr("autocomplete", "current-password"),
      expect(passwordField).toHaveAttr("aria-required", "true"),
      expect(signInButton).toBeEnabled()
    );
  });

  it("an empty submission explains each missing field", () => {
    scene(
      { update, view },
      given(init()),
      submit(form),
      expect(loginField).toHaveAttr("aria-invalid", "true"),
      expect(loginField).toHaveAccessibleDescription("Enter your login."),
      expect(passwordField).toHaveAccessibleDescription("Enter your password."),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });

  it("clearing the login shows its error at once", () => {
    scene(
      { update, view },
      given(init()),
      type(loginField, "ada"),
      type(loginField, ""),
      expect(loginField).toHaveAccessibleDescription("Enter your login.")
    );
  });

  it("the password never reaches the DOM's value attribute", () => {
    scene(
      { update, view },
      given(init()),
      type(passwordField, "s3cret-value"),
      expect(passwordField).not.toHaveAttr("value"),
      expect(text("s3cret-value")).not.toExist()
    );
  });

  it("signing in sends what was typed, shows progress, then reports the user", () => {
    scene(
      { update, view },
      given(init()),
      type(loginField, "ada"),
      type(passwordField, "ada-password"),
      submit(form),
      expect(signingInButton).toBeDisabled(),
      expect(signingInButton).toHaveAttr("aria-live", "polite"),
      expect(form).toHaveAttr("aria-busy", "true"),
      Command.expectExact(
        SignIn({
          login: "ada",
          password: Option.getOrThrow(toMaybePassword("ada-password")),
        })
      ),
      Command.resolve(
        SignIn,
        Message.SucceededSignIn({
          maybeRevision: Option.some(REVISION_3),
          user: ada,
        })
      ),
      expectOutMessage(
        OutMessage.SucceededSignIn({
          maybeRevision: Option.some(REVISION_3),
          user: ada,
        })
      )
    );
  });

  it("refused credentials are announced in the form, until the user edits", () => {
    scene(
      { update, view },
      given(init()),
      type(loginField, "ada"),
      type(passwordField, "wrong"),
      submit(form),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({ error: "InvalidCredentials" })
      ),
      expect(within(form, role("alert"))).toHaveText(
        "The login or password is not correct."
      ),
      expect(signInButton).toBeEnabled(),
      expect(loginField).toHaveValue("ada"),
      type(passwordField, "right"),
      expect(role("alert")).not.toExist()
    );
  });

  it("an unreachable server and a session the browser did not keep are announced too", () => {
    scene(
      { update, view },
      given(init()),
      type(loginField, "ada"),
      type(passwordField, "ada-password"),
      submit(form),
      Command.resolve(SignIn, Message.FailedSignIn({ error: "Unavailable" })),
      expect(role("alert")).toHaveText(
        "STD could not be reached. Try again in a moment."
      ),
      submit(form),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({ error: "SessionNotKept" })
      ),
      expect(role("alert")).toContainText("did not keep the session")
    );
  });
});
