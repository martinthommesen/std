import { Effect, Option } from "effect";
import { Valid } from "foldkit/fieldValidation";
import { UrlRequest } from "foldkit/navigation";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { describe, expect, it } from "vitest";

import {
  FocusMain,
  LoadCurrentUser,
  LoadExternal,
  NavigateInternal,
  ReplaceUrl,
  SignOut,
} from "./command.ts";
import { fakeStdApi } from "./fake-std-api.ts";
import {
  ada,
  adaAtHome,
  signInOpenedDirectly,
  signInRedirectedFromHome,
  urlOf,
} from "./fixture.ts";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import { Model, SignOutRequest } from "./model.ts";
import {
  Message as SignInMessage,
  SignIn,
  toMaybePassword,
} from "./page/sign-in/sign-in.ts";
import { AppRoute, homeRouter, signInRouter } from "./route.ts";
import type { SignedOutRoute } from "./route.ts";
import { update } from "./update.ts";

const checkingAt = (pathname: string) => init(urlOf(pathname)).model;

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

describe("start-up", () => {
  it("asks the server for the session", () => {
    const initial = init(urlOf("/"));

    expect(initial.model).toStrictEqual(
      Model.CheckingSession({ route: AppRoute.Home() })
    );
    expect(initial.commands).toStrictEqual([LoadCurrentUser()]);
  });

  it("a session lands on the page asked for", () => {
    story(
      update,
      given(checkingAt("/")),
      message(
        Message.SucceededLoadCurrentUser({ maybeUser: Option.some(ada) })
      ),
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
        Message.SucceededLoadCurrentUser({ maybeUser: Option.some(ada) })
      ),
      Command.expectExact(ReplaceUrl({ url: homeRouter() })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
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
      message(Message.SucceededLoadCurrentUser({ maybeUser: Option.none() })),
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
      message(Message.SucceededLoadCurrentUser({ maybeUser: Option.none() })),
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
      message(Message.SucceededLoadCurrentUser({ maybeUser: Option.none() })),
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
        Message.SucceededLoadCurrentUser({ maybeUser: Option.some(ada) })
      ),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, {
            route: () => AppRoute.NotFound({ path: "/elsewhere" }),
          })
        );
      })
    );
  });

  it("an unreachable server can be retried, and fail again", () => {
    const unavailable = Model.SessionUnavailable({ route: AppRoute.Home() });

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
          Model.CheckingSession({ route: AppRoute.Home() })
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
      message(Message.SucceededLoadCurrentUser({ maybeUser: Option.none() })),
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
      Command.resolve(SignIn, SignInMessage.SucceededSignIn({ user: ada })),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
        expect(Object.keys(app).toSorted()).toStrictEqual([
          "_tag",
          "route",
          "signOutRequest",
          "user",
        ]);
      }),
      Command.expectExact(ReplaceUrl({ url: homeRouter() }), FocusMain()),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      )
    );
  });

  it("from the sign-in page opened directly lands home", () => {
    story(
      update,
      given(signInOpenedDirectly),
      ...typeAndSubmit("ada-password"),
      Command.resolve(SignIn, SignInMessage.SucceededSignIn({ user: ada })),
      model((app) => {
        expect(app).toStrictEqual(adaAtHome);
      }),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      )
    );
  });

  it("a late sign-in answer after the session started changes nothing", () => {
    story(
      update,
      given(adaAtHome),
      message(
        Message.GotSignInMessage({
          message: SignInMessage.SucceededSignIn({ user: ada }),
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

describe("signing out", () => {
  it("ends on the sign-in page, with focus moved to it", () => {
    story(
      update,
      given(adaAtHome),
      message(Message.ClickedSignOut()),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, {
            signOutRequest: () => SignOutRequest.Pending(),
          })
        );
      }),
      Command.expectExact(SignOut()),
      Command.resolve(SignOut, Message.SucceededSignOut()),
      model((app) => {
        expect(app).toStrictEqual(signInOpenedDirectly);
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
      message(Message.ClickedSignOut()),
      Command.resolve(SignOut, Message.FailedSignOut()),
      model((app) => {
        expect(app).toStrictEqual(
          modifyFields(adaAtHome, {
            signOutRequest: () => SignOutRequest.Failed(),
          })
        );
      }),
      message(Message.ClickedSignOut()),
      Command.expectExact(SignOut()),
      Command.resolve(SignOut, Message.SucceededSignOut()),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [FocusMain, Message.CompletedFocusMain()]
      ),
      model((app) => {
        expect(app).toStrictEqual(signInOpenedDirectly);
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
      message(Message.ClickedSignOut()),
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
      message(Message.ClickedSignOut()),
      message(Message.SucceededSignOut()),
      message(Message.FailedSignOut()),
      Command.expectNone(),
      model((app) => {
        expect(app).toStrictEqual(signInOpenedDirectly);
      })
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
});

describe("the session requests", () => {
  const ME = "/api/v1/auth/me";

  const SIGN_OUT = "/api/v1/auth/sign-out";

  it("auth/me: a user, no session, or an unreachable server", async () => {
    const withUser = fakeStdApi({ [ME]: { body: ada, status: 200 } });

    const withoutSession = fakeStdApi({
      [ME]: { body: { _tag: "Unauthenticated" }, status: 401 },
    });

    const down = fakeStdApi({});

    const load = async (layer: typeof down.layer) =>
      await Effect.runPromise(
        LoadCurrentUser().effect.pipe(Effect.provide(layer))
      );

    await expect(load(withUser.layer)).resolves.toStrictEqual(
      Message.SucceededLoadCurrentUser({ maybeUser: Option.some(ada) })
    );
    await expect(load(withoutSession.layer)).resolves.toStrictEqual(
      Message.SucceededLoadCurrentUser({ maybeUser: Option.none() })
    );
    await expect(load(down.layer)).resolves.toStrictEqual(
      Message.FailedLoadCurrentUser()
    );
    expect(withUser.seen[0]?.headers["std-client"]).toBe("web");
  });

  it("sign-out: ended, already ended, or not reached", async () => {
    const ended = fakeStdApi({ [SIGN_OUT]: { status: 204 } });

    const alreadyEnded = fakeStdApi({
      [SIGN_OUT]: { body: { _tag: "Unauthenticated" }, status: 401 },
    });

    const down = fakeStdApi({});

    const signOut = async (layer: typeof down.layer) =>
      await Effect.runPromise(SignOut().effect.pipe(Effect.provide(layer)));

    await expect(signOut(ended.layer)).resolves.toStrictEqual(
      Message.SucceededSignOut()
    );
    await expect(signOut(alreadyEnded.layer)).resolves.toStrictEqual(
      Message.SucceededSignOut()
    );
    await expect(signOut(down.layer)).resolves.toStrictEqual(
      Message.FailedSignOut()
    );
    expect(ended.seen[0]?.headers["std-client"]).toBe("web");
    expect(ended.seen[0]?.method).toBe("POST");
  });
});
