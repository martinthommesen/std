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

import { StdApi } from "../../std-client.ts";

// MODEL

const PASSWORD_LABEL = "password";

/**
 * A password as typed. It stays `Redacted` in the Model, in Messages and in
 * Command arguments, so DevTools and its MCP server show only
 * `<redacted:password>`, and JSON encoding refuses it. Only the sign-in
 * request unwraps it.
 */
export const Password = Schema.Redacted(Schema.String, {
  disallowJsonEncode: true,
  label: PASSWORD_LABEL,
});

/**
 * What the password input holds: nothing, or a redacted password.
 *
 * @param typed - The input's text.
 * @returns `None` when empty, else the redacted password.
 */
export const toMaybePassword = (
  typed: string
): Option.Option<typeof Password.Type> =>
  typed === ""
    ? Option.none()
    : Option.some(Redacted.make(typed, { label: PASSWORD_LABEL }));

/** Why a sign-in did not succeed. */
export const SignInError = Schema.Literals([
  "InvalidCredentials",
  "Unavailable",
]);

/** Where the form's submission stands. */
export const Submission = defineTaggedUnion({
  Failed: { error: SignInError },
  Idle: {},
  Submitting: {},
});

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

// MESSAGE

/** What happens on the sign-in form. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Message = defineMessageUnion({
  CompletedFocusField: {},
  FailedRequestSession: { error: SignInError },
  SubmittedForm: {},
  SucceededRequestSession: { user: CurrentUserSchema },
  UpdatedLogin: { value: Schema.String },
  UpdatedPassword: { maybePassword: Schema.Option(Password) },
});

/** What happens on the sign-in form. */
export type Message = typeof Message.Type;

// OUT MESSAGE

/** What the form tells the app. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const OutMessage = defineMessageUnion({
  SucceededSignIn: { user: CurrentUserSchema },
});

/** What the form tells the app. */
export type OutMessage = typeof OutMessage.Type;

// VALIDATION

const loginRules = makeRules({ required: "Enter your login." });

const passwordRules = makeRules<Option.Option<typeof Password.Type>>({
  isEmpty: Option.isNone,
  required: "Enter your password.",
});

const validateLogin = validate(loginRules);

const validatePassword = validate(passwordRules);

const isLoginValid = isValid(loginRules);

/** The login input's element ID. */
export const LOGIN_INPUT_ID = "sign-in-login";

/** The password input's element ID. */
export const PASSWORD_INPUT_ID = "sign-in-password";

// COMMAND

/**
 * Signs in for a cookie session (the server sets the HTTP-only cookie, the
 * body carries no token), then reads who the session acts as.
 */
export const RequestSession = Command.define("RequestSession", {
  args: { login: Schema.String, password: Password },
  execute: ({ login, password }) =>
    Effect.gen(function* requestSession() {
      const client = yield* StdApi;

      yield* client.signIn.cookieSignIn({
        headers: { "std-client": "web" },
        payload: { login, password: Redacted.value(password) },
      });

      const user = yield* client.session.me();

      return Message.SucceededRequestSession({ user });
    }).pipe(
      Effect.catchTag("InvalidCredentials", () =>
        Effect.succeed(
          Message.FailedRequestSession({ error: "InvalidCredentials" })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedRequestSession({ error: "Unavailable" })
      )
    ),
  messages: [Message.SucceededRequestSession, Message.FailedRequestSession],
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
 * Submits the form: validates both fields, then requests a session, or
 * focuses the first field that needs attention. A second submission while
 * one is running does nothing.
 *
 * @param model - The form.
 * @returns The next form and its Commands.
 */
const submit = (model: Model): UpdateReturn => {
  if (Submission.guards.Submitting(model.submission)) {
    return { model };
  }

  const login = validateLogin(model.login.value);
  const password = validatePassword(model.password.value);

  const validated = modifyFields(model, {
    login: () => login,
    password: () => password,
  });

  if (!isLoginValid(login)) {
    return {
      commands: [FocusField({ id: LOGIN_INPUT_ID })],
      model: validated,
    };
  }

  return Option.match(password.value, {
    onNone: () => ({
      commands: [FocusField({ id: PASSWORD_INPUT_ID })],
      model: validated,
    }),
    onSome: (typed) => ({
      commands: [RequestSession({ login: login.value, password: typed })],
      model: modifyFields(validated, {
        submission: () => Submission.Submitting(),
      }),
    }),
  });
};

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
    FailedRequestSession: ({ error }) => ({
      model: modifyFields(model, {
        submission: () => Submission.Failed({ error }),
      }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SubmittedForm: () => submit(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededRequestSession: ({ user }) => ({
      model: modifyFields(model, { submission: () => Submission.Idle() }),
      outMessage: OutMessage.SucceededSignIn({ user }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedLogin: ({ value }) => ({
      model: modifyFields(model, { login: () => validateLogin(value) }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedPassword: ({ maybePassword }) => ({
      model: modifyFields(model, {
        password: () => validatePassword(maybePassword),
      }),
    }),
  });

// VIEW

const HEADING_ID = "sign-in-heading";

const errorText = (error: typeof SignInError.Type): string =>
  error === "InvalidCredentials"
    ? "The login or password is not correct."
    : "STD could not be reached. Try again in a moment.";

const fieldErrorView = <A>(
  field: Field<A>,
  description: readonly Attribute<Message>[],
  h: HtmlBuilder<Message>
): Html =>
  FieldValidation.match(field, {
    onInvalid: ({ errors }) =>
      h.p([...description, h.Class("field-error")], [errors[0]]),
    onNotValidated: () => h.empty,
    onValid: () => h.empty,
    onValidating: () => h.empty,
  });

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
        h.div(
          [h.Class("field")],
          [
            h.label([...attributes.label, h.Class("field-label")], ["Login"]),
            h.input([
              ...attributes.input,
              h.Autocomplete("username"),
              h.Spellcheck(false),
              h.Class("field-input"),
            ]),
            fieldErrorView(field, attributes.description, h),
          ]
        ),
      value: field.value,
    },
    h
  );
};

// NOTE: the password input is uncontrolled (no `value`): the Model holds
// only a redacted copy, which the view never unwraps.
const passwordView = (
  field: Field<Option.Option<typeof Password.Type>>,
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
        h.div(
          [h.Class("field")],
          [
            h.label(
              [...attributes.label, h.Class("field-label")],
              ["Password"]
            ),
            h.input([
              ...attributes.input,
              h.Autocomplete("current-password"),
              h.Class("field-input"),
            ]),
            fieldErrorView(field, attributes.description, h),
          ]
        ),
      type: "password",
    },
    h
  );
};

const failureView = (
  submission: typeof Submission.Type,
  h: HtmlBuilder<Message>
): Html =>
  Match.value(submission).pipe(
    Match.tag("Failed", ({ error }) =>
      h.p([h.Role("alert"), h.Class("form-alert")], [errorText(error)])
    ),
    Match.orElse(() => h.empty)
  );

const submitView = (isSubmitting: boolean, h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      isDisabled: isSubmitting,
      toView: (attributes) =>
        h.button(
          [...attributes.button, h.Class("button button-primary")],
          [isSubmitting ? "Signing in…" : "Sign in"]
        ),
      type: "submit",
    },
    h
  );

/** The sign-in page. */
export const view = Submodel.defineView<Model, Message>((model, h) => {
  const isSubmitting = Submission.guards.Submitting(model.submission);

  return h.section(
    [h.Class("sign-in"), h.AriaLabelledBy(HEADING_ID)],
    [
      h.h1([h.Id(HEADING_ID), h.Class("sign-in-heading")], ["Sign in to STD"]),
      h.form(
        [
          h.Class("sign-in-form"),
          h.AriaLabelledBy(HEADING_ID),
          h.AriaBusy(isSubmitting),
          h.Novalidate(true),
          h.OnSubmit(Message.SubmittedForm()),
        ],
        [
          failureView(model.submission, h),
          loginView(model.login, h),
          passwordView(model.password, h),
          submitView(isSubmitting, h),
        ]
      ),
    ]
  );
});
