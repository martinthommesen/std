import { Option, Redacted } from "effect";
import { Valid } from "foldkit/fieldValidation";
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

import { ada } from "../../fixture.ts";
import {
  FocusField,
  LOGIN_INPUT_ID,
  Message,
  OutMessage,
  PASSWORD_INPUT_ID,
  RequestSession,
  Submission,
  init,
  toMaybePassword,
  update,
} from "./sign-in.ts";

const PASSWORD = "correct horse battery staple";

const filled = modifyFields(init(), {
  login: () => Valid({ value: "ada" }),
  password: () => Valid({ value: toMaybePassword(PASSWORD) }),
});

describe("sign-in", () => {
  it("holds the password only redacted", () => {
    story(
      update,
      given(init()),
      message(
        Message.UpdatedPassword({ maybePassword: toMaybePassword(PASSWORD) })
      ),
      model((form) => {
        const password = Option.getOrThrow(form.password.value);

        expect(form.password._tag).toBe("Valid");
        expect(Redacted.isRedacted(password)).toBeTruthy();
        expect(JSON.stringify(form)).not.toContain(PASSWORD);
        expect(JSON.stringify(password)).toBe('"<redacted:password>"');
        expect(Redacted.value(password)).toBe(PASSWORD);
      })
    );
  });

  it("validates the login as it is typed", () => {
    story(
      update,
      given(init()),
      message(Message.UpdatedLogin({ value: "ada" })),
      model((form) => {
        expect(form.login._tag).toBe("Valid");
      }),
      message(Message.UpdatedLogin({ value: "" })),
      model((form) => {
        expect(form.login).toStrictEqual({
          _tag: "Invalid",
          errors: ["Enter your login."],
          value: "",
        });
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
        expect(form.submission._tag).toBe("Idle");
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
        expect(form.password).toStrictEqual({
          _tag: "Invalid",
          errors: ["Enter your password."],
          value: Option.none(),
        });
      }),
      Command.expectExact(FocusField({ id: PASSWORD_INPUT_ID })),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });

  it("a filled form requests a session and reports the user", () => {
    story(
      update,
      given(filled),
      message(Message.SubmittedForm()),
      model((form) => {
        expect(form.submission._tag).toBe("Submitting");
      }),
      Command.expectExact(RequestSession),
      Command.resolve(
        RequestSession,
        Message.SucceededRequestSession({ user: ada })
      ),
      model((form) => {
        expect(form.submission._tag).toBe("Idle");
      }),
      expectOutMessage(OutMessage.SucceededSignIn({ user: ada }))
    );
  });

  it("the request carries the login and the password still redacted", () => {
    const password = Option.getOrThrow(filled.password.value);

    story(
      update,
      given(filled),
      message(Message.SubmittedForm()),
      Command.expectExact(RequestSession({ login: "ada", password })),
      model((form) => {
        expect(Redacted.isRedacted(password)).toBeTruthy();
        expect(form.submission._tag).toBe("Submitting");
      }),
      Command.resolve(
        RequestSession,
        Message.FailedRequestSession({ error: "Unavailable" })
      )
    );
  });

  it("refused credentials keep the form and can be retried", () => {
    story(
      update,
      given(filled),
      message(Message.SubmittedForm()),
      Command.resolve(
        RequestSession,
        Message.FailedRequestSession({ error: "InvalidCredentials" })
      ),
      model((form) => {
        expect(form.submission).toStrictEqual({
          _tag: "Failed",
          error: "InvalidCredentials",
        });
        expect(form.login.value).toBe("ada");
      }),
      expectNoOutMessage(),
      message(Message.SubmittedForm()),
      Command.expectExact(RequestSession),
      Command.resolve(
        RequestSession,
        Message.SucceededRequestSession({ user: ada })
      ),
      expectOutMessage(OutMessage.SucceededSignIn({ user: ada }))
    );
  });

  it("a submission while one runs does nothing", () => {
    story(
      update,
      given(
        modifyFields(filled, { submission: () => Submission.Submitting() })
      ),
      message(Message.SubmittedForm()),
      Command.expectNone(),
      model((form) => {
        expect(form.submission._tag).toBe("Submitting");
      }),
      expectNoOutMessage()
    );
  });
});
