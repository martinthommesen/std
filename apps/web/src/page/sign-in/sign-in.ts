import { Button, Input } from "@foldkit/ui";
import { CurrentUserSchema } from "@std/api/session";
import { Effect, Match, Option, Redacted, Schema } from "effect";
import { Command, Dom, FieldValidation, Submodel } from "foldkit";
import type { Update } from "foldkit";
import {
  Field,
  NotValidated,
  isValid,
  makeRules,
  validate,
} from "foldkit/fieldValidation";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";

import { SchemaRevision } from "../../domain/schema-revision.ts";
import { StdApi, responseRevision } from "../../std-client.ts";

// MODEL

const PASSWORD_LABEL = "password";

/**
 * A password as typed. It stays `Redacted` in the Model, in Messages and in
 * Command arguments, so DevTools and its MCP server show only
 * `<redacted:password>`, and JSON encoding refuses it. Only the sign-in
 * request unwraps it.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Password = Schema.Redacted(Schema.String, {
  disallowJsonEncode: true,
  label: PASSWORD_LABEL,
});

/** A password as typed. */
export type Password = typeof Password.Type;

/**
 * What the password input holds: nothing, or a redacted password.
 *
 * @param typed - The input's text.
 * @returns `None` when empty, else the redacted password.
 */
export const toMaybePassword = (typed: string): Option.Option<Password> =>
  typed === ""
    ? Option.none()
    : Option.some(Redacted.make(typed, { label: PASSWORD_LABEL }));

/**
 * Why a sign-in did not succeed: refused credentials, no answer, or a
 * session the browser did not keep (its cookie was refused).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SignInError = Schema.Literals([
  "InvalidCredentials",
  "SessionNotKept",
  "Unavailable",
]);

/** Why a sign-in did not succeed. */
export type SignInError = typeof SignInError.Type;

/** Where the form's submission stands. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Submission = defineTaggedUnion({
  Failed: { error: SignInError },
  Idle: {},
  Pending: {},
});

/** Where the form's submission stands. */
export type Submission = typeof Submission.Type;

/** The sign-in form. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Model = Schema.Struct({
  login: Field(Schema.String),
  password: Field(Schema.Option(Password)),
  submission: Submission,
});

/** The sign-in form. */
export type Model = typeof Model.Type;

/**
 * An empty form.
 *
 * @returns The form.
 */
export const init = (): Model => ({
  login: NotValidated({ value: "" }),
  password: NotValidated({ value: Option.none() }),
  submission: Submission.Idle(),
});

/**
 * The form without its password, for when the page is left or entered:
 * the password input is uncontrolled, so a remounted input is empty and
 * the Model must not keep a password the user no longer sees.
 *
 * @param form - The form.
 * @returns The form with no password.
 */
export const forgetPassword = (form: Model): Model =>
  modifyFields(form, {
    password: () => NotValidated({ value: Option.none() }),
  });

// MESSAGE

/** What happens on the sign-in form. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Message = defineMessageUnion({
  CompletedFocusField: {},
  FailedSignIn: { error: SignInError },
  SubmittedForm: {},
  SucceededSignIn: {
    maybeRevision: Schema.Option(SchemaRevision),
    user: CurrentUserSchema,
  },
  UpdatedLogin: { value: Schema.String },
  UpdatedPassword: { maybePassword: Schema.Option(Password) },
});

/** What happens on the sign-in form. */
export type Message = typeof Message.Type;

// OUT MESSAGE

/** What the form tells the app. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const OutMessage = defineMessageUnion({
  SucceededSignIn: {
    maybeRevision: Schema.Option(SchemaRevision),
    user: CurrentUserSchema,
  },
});

/** What the form tells the app. */
export type OutMessage = typeof OutMessage.Type;

// VALIDATION

const loginRules = makeRules({ required: "Enter your login." });

const passwordRules = makeRules<Option.Option<Password>>({
  isEmpty: Option.isNone,
  required: "Enter your password.",
});

const validateLogin = validate(loginRules);

const validatePassword = validate(passwordRules);

const isLoginValid = isValid(loginRules);

const isPasswordValid = isValid(passwordRules);

/** The login input's element ID. */
export const LOGIN_INPUT_ID = "sign-in-login";

/** The password input's element ID. */
export const PASSWORD_INPUT_ID = "sign-in-password";

// COMMAND

/**
 * Signs in for a cookie session (the server sets the HTTP-only cookie; the
 * body carries no token), then reads who the session acts as. If that read
 * is refused, the browser did not keep the cookie.
 */
export const SignIn = Command.define("SignIn", {
  args: { login: Schema.String, password: Password },
  execute: ({ login, password }) =>
    Effect.gen(function* signIn() {
      const client = yield* StdApi;

      yield* client.signIn.cookieSignIn({
        headers: { "std-client": "web" },
        payload: { login, password: Redacted.value(password) },
      });

      const maybeSession = yield* client.session
        .me({ responseMode: "decoded-and-response" })
        .pipe(
          Effect.map(Option.some),
          Effect.catchTag("Unauthenticated", () =>
            Effect.succeed(Option.none())
          )
        );

      return Option.match(maybeSession, {
        onNone: () => Message.FailedSignIn({ error: "SessionNotKept" }),
        onSome: ([user, response]) =>
          Message.SucceededSignIn({
            maybeRevision: responseRevision(response),
            user,
          }),
      });
    }).pipe(
      Effect.catchTag("InvalidCredentials", () =>
        Effect.succeed(Message.FailedSignIn({ error: "InvalidCredentials" }))
      ),
      Effect.orElseSucceed(() => Message.FailedSignIn({ error: "Unavailable" }))
    ),
  messages: [Message.SucceededSignIn, Message.FailedSignIn],
});

/** Moves focus to a field that needs the user's attention. */
export const FocusField = Command.define("FocusField", {
  args: { id: Schema.String },
  execute: ({ id }) =>
    Dom.focus(`#${id}`).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedFocusField())
    ),
  messages: [Message.CompletedFocusField],
});

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  StdApi
>;

/**
 * Submits the form: validates both fields, then signs in, or focuses the
 * first field that needs attention. A submission while one is pending does
 * nothing.
 *
 * @param model - The form.
 * @returns The next form and its Commands.
 */
const submit = (model: Model): UpdateReturn => {
  if (Submission.guards.Pending(model.submission)) {
    return { model };
  }

  const validated = modifyFields(model, {
    login: ({ value }) => validateLogin(value),
    password: ({ value }) => validatePassword(value),
  });

  if (!isLoginValid(validated.login)) {
    return {
      commands: [FocusField({ id: LOGIN_INPUT_ID })],
      model: validated,
    };
  }

  const maybePassword = isPasswordValid(validated.password)
    ? validated.password.value
    : Option.none();

  return Option.match(maybePassword, {
    onNone: () => ({
      commands: [FocusField({ id: PASSWORD_INPUT_ID })],
      model: validated,
    }),
    onSome: (password) => ({
      commands: [SignIn({ login: validated.login.value, password })],
      model: modifyFields(validated, {
        submission: () => Submission.Pending(),
      }),
    }),
  });
};

/**
 * Editing a field takes back a failure's alert; a pending submission stays.
 *
 * @param submission - The submission.
 * @returns It, or `Idle` after a failure.
 */
const acknowledgeFailure = (submission: Submission): Submission =>
  Submission.guards.Failed(submission) ? Submission.Idle() : submission;

/**
 * The sign-in form's update.
 *
 * @param model - The form.
 * @param message - What happened.
 * @returns The next form, its Commands, and a successful sign-in.
 */
export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedFocusField: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSignIn: ({ error }) => ({
      model: modifyFields(model, {
        submission: () => Submission.Failed({ error }),
      }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SubmittedForm: () => submit(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededSignIn: ({ maybeRevision, user }) => ({
      model,
      outMessage: OutMessage.SucceededSignIn({ maybeRevision, user }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedLogin: ({ value }) => ({
      model: modifyFields(model, {
        login: () => validateLogin(value),
        submission: acknowledgeFailure,
      }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedPassword: ({ maybePassword }) => ({
      model: modifyFields(model, {
        password: () => validatePassword(maybePassword),
        submission: acknowledgeFailure,
      }),
    }),
  });

// VIEW

const HEADING_ID = "sign-in-heading";

const signInErrorText = (error: SignInError): string =>
  Match.value(error).pipe(
    Match.when(
      "InvalidCredentials",
      () => "The login or password is not correct."
    ),
    Match.when(
      "SessionNotKept",
      () =>
        "Signed in, but this browser did not keep the session. Allow cookies for this site and try again."
    ),
    Match.when(
      "Unavailable",
      () => "STD could not be reached. Try again in a moment."
    ),
    Match.exhaustive
  );

/** How one field of the form renders around its Foldkit UI attributes. */
interface FieldViewConfig<A> {
  readonly label: string;
  readonly field: Field<A>;
  readonly autocomplete: string;
  readonly label_: readonly Attribute<Message>[];
  readonly input: readonly Attribute<Message>[];
  readonly description: readonly Attribute<Message>[];
}

const fieldView = <A>(
  config: FieldViewConfig<A>,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("field")],
    [
      h.label([...config.label_, h.Class("field-label")], [config.label]),
      h.input([
        ...config.input,
        h.AriaRequired(true),
        h.Autocomplete(config.autocomplete),
        h.Spellcheck(false),
        h.Class("field-input"),
      ]),
      // NOTE: the live region stays mounted, so an error that appears in
      // it is announced even when focus does not move.
      h.div(
        [h.AriaLive("polite")],
        [
          FieldValidation.match(config.field, {
            onInvalid: ({ errors }) =>
              h.p([...config.description, h.Class("field-error")], [errors[0]]),
            onNotValidated: () => h.empty,
            onValid: () => h.empty,
            onValidating: () => h.empty,
          }),
        ]
      ),
    ]
  );

const loginView = (field: Field<string>, h: HtmlBuilder<Message>): Html => {
  const isInvalid = FieldValidation.isInvalid(field);

  return Input.view(
    {
      hasDescription: isInvalid,
      id: LOGIN_INPUT_ID,
      isAutofocus: true,
      isInvalid,
      name: "login",
      onInput: (value) => Message.UpdatedLogin({ value }),
      toView: (attributes) =>
        fieldView(
          {
            autocomplete: "username",
            description: attributes.description,
            field,
            input: attributes.input,
            label: "Login",
            label_: attributes.label,
          },
          h
        ),
      value: field.value,
    },
    h
  );
};

// NOTE: the password input is uncontrolled (no `value`): the Model holds
// only a redacted copy, which the view never unwraps.
const passwordView = (
  field: Field<Option.Option<Password>>,
  h: HtmlBuilder<Message>
): Html => {
  const isInvalid = FieldValidation.isInvalid(field);

  return Input.view(
    {
      hasDescription: isInvalid,
      id: PASSWORD_INPUT_ID,
      isInvalid,
      name: "password",
      onInput: (typed) =>
        Message.UpdatedPassword({ maybePassword: toMaybePassword(typed) }),
      toView: (attributes) =>
        fieldView(
          {
            autocomplete: "current-password",
            description: attributes.description,
            field,
            input: attributes.input,
            label: "Password",
            label_: attributes.label,
          },
          h
        ),
      type: "password",
    },
    h
  );
};

const submissionFailureView = (
  submission: Submission,
  h: HtmlBuilder<Message>
): Html =>
  Match.value(submission).pipe(
    Match.tag("Failed", ({ error }) =>
      h.p([h.Role("alert"), h.Class("form-alert")], [signInErrorText(error)])
    ),
    Match.orElse(() => h.empty)
  );

const submitButtonView = (isPending: boolean, h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      isDisabled: isPending,
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.AriaLive("polite"),
            h.AriaAtomic(true),
            h.Class("button button-primary"),
          ],
          [isPending ? "Signing in…" : "Sign in"]
        ),
      type: "submit",
    },
    h
  );

/** The sign-in page. */
export const view = Submodel.defineView<Model, Message>((model, h) => {
  const isPending = Submission.guards.Pending(model.submission);

  return h.div(
    [h.Class("sign-in")],
    [
      h.h1([h.Id(HEADING_ID), h.Class("sign-in-heading")], ["Sign in to STD"]),
      h.form(
        [
          h.Class("sign-in-form"),
          h.AriaLabelledBy(HEADING_ID),
          h.Novalidate(true),
          h.OnSubmit(Message.SubmittedForm()),
        ],
        [
          submissionFailureView(model.submission, h),
          loginView(model.login, h),
          passwordView(model.password, h),
          submitButtonView(isPending, h),
        ]
      ),
    ]
  );
});
