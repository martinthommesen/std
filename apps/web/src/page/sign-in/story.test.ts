import { Effect, Option, Redacted, Schema } from "effect";
import { Invalid, NotValidated, Valid } from "foldkit/fieldValidation";
import {
  Command,
  expectNoOutMessage,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { describe, expect, it } from "vitest";

import { fakeStdApi } from "../../fake-std-api.ts";
import { ada } from "../../fixture.ts";
import { REVISION_3 } from "../../table-fixture.ts";
import {
  FocusField,
  LOGIN_INPUT_ID,
  Message,
  Model,
  OutMessage,
  PASSWORD_INPUT_ID,
  SignIn,
  Submission,
  forgetPassword,
  init,
  toMaybePassword,
  update,
} from "./sign-in.ts";

const PASSWORD = "correct horse battery staple";

const password = Option.getOrThrow(toMaybePassword(PASSWORD));

const filled: Model = modifyFields(init(), {
  login: () => Valid({ value: "ada" }),
  password: () => Valid({ value: Option.some(password) }),
});

const failed: Model = modifyFields(filled, {
  submission: () => Submission.Failed({ error: "InvalidCredentials" }),
});

describe("sign-in", () => {
  it("holds the password only redacted, and JSON encoding refuses it", () => {
    story(
      update,
      given(init()),
      message(
        Message.UpdatedPassword({ maybePassword: toMaybePassword(PASSWORD) })
      ),
      model((form) => {
        expect(form.password).toStrictEqual(
          Valid({ value: Option.some(password) })
        );
        expect(JSON.stringify(form)).not.toContain(PASSWORD);
        expect(JSON.stringify(form)).toContain("<redacted:password>");
        expect(() =>
          Schema.encodeSync(Schema.toCodecJson(Model))(form)
        ).toThrow("Cannot serialize Redacted");
        expect(() =>
          Schema.encodeSync(Schema.toCodecJson(Message))(
            Message.UpdatedPassword({ maybePassword: Option.some(password) })
          )
        ).toThrow("Cannot serialize Redacted");
      })
    );
  });

  it("validates the login as it is typed", () => {
    story(
      update,
      given(init()),
      message(Message.UpdatedLogin({ value: "ada" })),
      model((form) => {
        expect(form.login).toStrictEqual(Valid({ value: "ada" }));
      }),
      message(Message.UpdatedLogin({ value: "" })),
      model((form) => {
        expect(form.login).toStrictEqual(
          Invalid({ errors: ["Enter your login."], value: "" })
        );
      })
    );
  });

  it("clearing the password asks for it", () => {
    story(
      update,
      given(filled),
      message(Message.UpdatedPassword({ maybePassword: toMaybePassword("") })),
      model((form) => {
        expect(form.password).toStrictEqual(
          Invalid({ errors: ["Enter your password."], value: Option.none() })
        );
      })
    );
  });

  it("an empty form marks both fields and focuses the login", () => {
    story(
      update,
      given(init()),
      message(Message.SubmittedForm()),
      model((form) => {
        expect(form.login._tag).toBe("Invalid");
        expect(form.password._tag).toBe("Invalid");
        expect(form.submission).toStrictEqual(Submission.Idle());
      }),
      Command.expectExact(FocusField({ id: LOGIN_INPUT_ID })),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });

  it("a login without a password focuses the password", () => {
    story(
      update,
      given(init()),
      message(Message.UpdatedLogin({ value: "ada" })),
      message(Message.SubmittedForm()),
      model((form) => {
        expect(form.password).toStrictEqual(
          Invalid({ errors: ["Enter your password."], value: Option.none() })
        );
      }),
      Command.expectExact(FocusField({ id: PASSWORD_INPUT_ID })),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });

  it("a filled form signs in with the login and the still redacted password, then reports the user", () => {
    story(
      update,
      given(filled),
      message(Message.SubmittedForm()),
      model((form) => {
        expect(form.submission).toStrictEqual(Submission.Pending());
      }),
      Command.expectExact(SignIn({ login: "ada", password })),
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

  it("refused credentials keep the form, and a retry can succeed", () => {
    story(
      update,
      given(filled),
      message(Message.SubmittedForm()),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({ error: "InvalidCredentials" })
      ),
      model((form) => {
        expect(form).toStrictEqual(failed);
      }),
      expectNoOutMessage(),
      message(Message.SubmittedForm()),
      Command.expectExact(SignIn({ login: "ada", password })),
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

  it("an unreachable server or a session not kept is reported", () => {
    for (const error of ["Unavailable", "SessionNotKept"] as const) {
      story(
        update,
        given(filled),
        message(Message.SubmittedForm()),
        Command.resolve(SignIn, Message.FailedSignIn({ error })),
        model((form) => {
          expect(form.submission).toStrictEqual(Submission.Failed({ error }));
        }),
        expectNoOutMessage()
      );
    }
  });

  it("editing a field takes back the failure's alert", () => {
    story(
      update,
      given(failed),
      message(Message.UpdatedLogin({ value: "ada2" })),
      model((form) => {
        expect(form.submission).toStrictEqual(Submission.Idle());
      })
    );
  });

  it("a submission while one is pending does nothing", () => {
    story(
      update,
      given(modifyFields(filled, { submission: () => Submission.Pending() })),
      message(Message.SubmittedForm()),
      Command.expectNone(),
      model((form) => {
        expect(form.submission).toStrictEqual(Submission.Pending());
      }),
      expectNoOutMessage()
    );
  });

  it("forgetting the password keeps the login", () => {
    expect(forgetPassword(filled)).toStrictEqual(
      modifyFields(filled, {
        password: () => NotValidated({ value: Option.none() }),
      })
    );
  });
});

const ME = "/api/v1/auth/me";

const COOKIE_SIGN_IN = "/api/v1/auth/cookie-sign-in";

const signedIn = {
  body: { expiresAt: "2026-10-22T12:00:00.000Z", userId: ada.userId },
  status: 200,
};

const run = (answers: Parameters<typeof fakeStdApi>[0]) => {
  const fake = fakeStdApi(answers);

  return {
    result: Effect.runPromise(
      SignIn({ login: "ada", password }).effect.pipe(Effect.provide(fake.layer))
    ),
    seen: fake.seen,
  };
};

describe("the sign-in request", () => {
  it("sends the password in plain text only in the request body, with STD-Client: web", async () => {
    const { result, seen } = run({
      [COOKIE_SIGN_IN]: signedIn,
      [ME]: {
        body: ada,
        headers: { "std-schema-revision": REVISION_3 },
        status: 200,
      },
    });

    await expect(result).resolves.toStrictEqual(
      Message.SucceededSignIn({
        maybeRevision: Option.some(REVISION_3),
        user: ada,
      })
    );
    expect(seen.map((request) => request.path)).toStrictEqual([
      COOKIE_SIGN_IN,
      ME,
    ]);
    expect(JSON.parse(seen[0]?.body ?? "{}")).toStrictEqual({
      login: "ada",
      password: PASSWORD,
    });
    expect(seen[0]?.headers["std-client"]).toBe("web");
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("maps refused credentials, a session not kept and anything else", async () => {
    const refused = run({
      [COOKIE_SIGN_IN]: { body: { _tag: "InvalidCredentials" }, status: 401 },
    });

    const notKept = run({
      [COOKIE_SIGN_IN]: signedIn,
      [ME]: { body: { _tag: "Unauthenticated" }, status: 401 },
    });

    const unreachable = run({});

    await expect(refused.result).resolves.toStrictEqual(
      Message.FailedSignIn({ error: "InvalidCredentials" })
    );
    await expect(notKept.result).resolves.toStrictEqual(
      Message.FailedSignIn({ error: "SessionNotKept" })
    );
    await expect(unreachable.result).resolves.toStrictEqual(
      Message.FailedSignIn({ error: "Unavailable" })
    );
  });

  it("keeps a redacted password redacted in its arguments", () => {
    const command = SignIn({ login: "ada", password });

    expect(Redacted.isRedacted(command.args.password)).toBeTruthy();
    expect(JSON.stringify(command.args)).not.toContain(PASSWORD);
  });
});
