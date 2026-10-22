import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";
import { describe, expect, it } from "vitest";

import {
  LoadCurrentUser,
  NavigateInternal,
  ReplaceUrl,
  SignOut,
} from "./command.ts";
import { ada, adaAtHome, signInFromHome } from "./fixture.ts";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import { Model, SignOutRequest } from "./model.ts";
import {
  Message as SignInMessage,
  RequestSession,
  toMaybePassword,
} from "./page/sign-in/sign-in.ts";
import { AppRoute } from "./route.ts";
import { update } from "./update.ts";

const urlOf = (pathname: string): Url => ({
  hash: Option.none(),
  host: "localhost:5173",
  pathname,
  port: Option.none(),
  protocol: "http:",
  search: Option.none(),
});

const checkingAt = (pathname: string) => init(urlOf(pathname)).model;

describe("app", () => {
  it("starts by asking the server for the session", () => {
    const start = init(urlOf("/"));

    expect(start.model).toStrictEqual(
      Model.CheckingSession({ route: AppRoute.Home() })
    );
    expect(start.commands?.map((command) => command.name)).toStrictEqual([
      "LoadCurrentUser",
    ]);
  });

  it("a session lands on the page asked for", () => {
    story(
      update,
      given(checkingAt("/")),
      message(Message.SucceededLoadCurrentUser({ user: ada })),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectNone()
    );
  });

  it("a session on the sign-in page redirects home", () => {
    story(
      update,
      given(checkingAt("/sign-in")),
      message(Message.SucceededLoadCurrentUser({ user: ada })),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectExact(ReplaceUrl({ url: "/" })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });

  it("no session on a signed-in page redirects to sign-in and remembers the page", () => {
    story(
      update,
      given(checkingAt("/")),
      message(Message.FailedLoadCurrentUser({ error: "NoSession" })),
      model((app) => {
        expect(app).toStrictEqual(signInFromHome);
      }),
      Command.expectExact(ReplaceUrl({ url: "/sign-in" })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });

  it("an unknown path stays not found whether or not signed in", () => {
    story(
      update,
      given(checkingAt("/no/such/page")),
      message(Message.FailedLoadCurrentUser({ error: "NoSession" })),
      model((app) => {
        expect(app._tag).toBe("SignedOut");
        expect(app.route).toStrictEqual(
          AppRoute.NotFound({ path: "/no/such/page" })
        );
      }),
      Command.expectNone()
    );
  });

  it("an unreachable server can be retried", () => {
    story(
      update,
      given(checkingAt("/")),
      message(Message.FailedLoadCurrentUser({ error: "Unavailable" })),
      model((app) => {
        expect(app).toStrictEqual(
          Model.SessionUnavailable({ route: AppRoute.Home() })
        );
      }),
      message(Message.ClickedRetry()),
      model((app) => {
        expect(app._tag).toBe("CheckingSession");
      }),
      Command.resolve(
        LoadCurrentUser,
        Message.SucceededLoadCurrentUser({ user: ada })
      ),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      })
    );
  });

  it("signing in returns to the page asked for, with the user's name and no token", () => {
    story(
      update,
      given(signInFromHome),
      message(
        Message.GotSignInMessage({
          message: SignInMessage.UpdatedLogin({ value: "ada" }),
        })
      ),
      message(
        Message.GotSignInMessage({
          message: SignInMessage.UpdatedPassword({
            maybePassword: toMaybePassword("ada-password"),
          }),
        })
      ),
      message(
        Message.GotSignInMessage({ message: SignInMessage.SubmittedForm() })
      ),
      Command.resolve(
        RequestSession,
        SignInMessage.SucceededRequestSession({ user: ada })
      ),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
        expect(JSON.stringify(app)).not.toContain("ada-password");
        expect(Object.keys(app).toSorted()).toStrictEqual([
          "_tag",
          "route",
          "signOut",
          "user",
        ]);
      }),
      Command.expectExact(ReplaceUrl({ url: "/" })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });

  it("signing out ends on the sign-in page", () => {
    story(
      update,
      given(adaAtHome),
      message(Message.ClickedSignOut()),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, { signOut: () => SignOutRequest.Pending() })
        );
      }),
      Command.expectExact(SignOut),
      Command.resolve(SignOut, Message.SucceededSignOut()),
      model((app) => {
        expect(app).toStrictEqual(
          Model.SignedOut({
            maybeReturnRoute: Option.none(),
            route: AppRoute.SignIn(),
            signIn: signInFromHome.signIn,
          })
        );
      }),
      Command.expectExact(ReplaceUrl({ url: "/sign-in" })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });

  it("a failed sign-out keeps the session and can be retried", () => {
    story(
      update,
      given(adaAtHome),
      message(Message.ClickedSignOut()),
      Command.resolve(SignOut, Message.FailedSignOut()),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, { signOut: () => SignOutRequest.Failed() })
        );
      }),
      message(Message.ClickedSignOut()),
      Command.expectExact(SignOut),
      Command.resolve(SignOut, Message.SucceededSignOut()),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      model((app) => {
        expect(app._tag).toBe("SignedOut");
      })
    );
  });

  it("a second click while signing out does nothing", () => {
    story(
      update,
      given(
        modifyFields(adaAtHome, { signOut: () => SignOutRequest.Pending() })
      ),
      message(Message.ClickedSignOut()),
      Command.expectNone(),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, { signOut: () => SignOutRequest.Pending() })
        );
      })
    );
  });

  it("following a link while signed in moves through the address bar", () => {
    story(
      update,
      given(adaAtHome),
      message(Message.ChangedUrl({ url: urlOf("/elsewhere") })),
      model((app) => {
        expect(app.route).toStrictEqual(
          AppRoute.NotFound({ path: "/elsewhere" })
        );
      }),
      message(Message.ChangedUrl({ url: urlOf("/sign-in") })),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.expectExact(ReplaceUrl({ url: "/" })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });

  it("a signed-out visitor sent home is redirected to sign-in", () => {
    story(
      update,
      given(
        Model.SignedOut({
          maybeReturnRoute: Option.none(),
          route: AppRoute.SignIn(),
          signIn: signInFromHome.signIn,
        })
      ),
      message(Message.ChangedUrl({ url: urlOf("/") })),
      model((app) => {
        expect(app).toStrictEqual(signInFromHome);
      }),
      Command.expectExact(ReplaceUrl({ url: "/sign-in" })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });

  it("an internal link navigates; late answers from earlier states change nothing", () => {
    story(
      update,
      given(adaAtHome),
      message(
        Message.ClickedLink({
          request: { _tag: "Internal", url: urlOf("/") },
        })
      ),
      Command.expectExact(NavigateInternal({ url: "http://localhost:5173/" })),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
      message(Message.SucceededLoadCurrentUser({ user: ada })),
      message(Message.FailedLoadCurrentUser({ error: "NoSession" })),
      message(Message.SucceededSignOut()),
      model((app) => {
        expect(app).toStrictEqual(
          Model.SignedOut({
            maybeReturnRoute: Option.none(),
            route: AppRoute.SignIn(),
            signIn: signInFromHome.signIn,
          })
        );
      }),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl())
    );
  });
});
