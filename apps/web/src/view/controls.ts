/**
 * Labelled form controls over Foldkit UI's render helpers (Select, Input,
 * Textarea, Checkbox, Button), with STD's markup and classes. The
 * components supply the ARIA wiring and the `data-*` state attributes that
 * `styles.css` styles; these helpers only lay them out, so every page
 * renders a control the same way.
 */
import { Button, Checkbox, Input, Select, Textarea } from "@foldkit/ui";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

const CONTROL_CLASS = "control";

const LABEL_CLASS = "control-label";

const INPUT_CLASS = "control-input";

/** One option of a select. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

const hintView = <Message>(
  maybeDescription: Option.Option<string>,
  attributes: readonly Attribute<Message>[],
  h: HtmlBuilder<Message>
): Html =>
  Option.match(maybeDescription, {
    onNone: () => h.empty,
    onSome: (text) => h.p([...attributes, h.Class("control-hint")], [text]),
  });

/** A labelled select. */
export interface SelectFieldConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => Message;
  readonly isDisabled?: boolean;
  readonly maybeDescription?: Option.Option<string>;
}

/**
 * A labelled select (Foldkit UI Select, a native `select`).
 *
 * @param config - Its ID, label, value, options and change Message.
 * @param h - The builder.
 * @returns The control.
 */
export const selectField = <Message>(
  config: SelectFieldConfig<Message>,
  h: HtmlBuilder<Message>
): Html => {
  const maybeDescription = config.maybeDescription ?? Option.none();

  return Select.view(
    {
      hasDescription: Option.isSome(maybeDescription),
      id: config.id,
      isDisabled: config.isDisabled ?? false,
      onChange: config.onChange,
      toView: (attributes) =>
        h.div(
          [h.Class(CONTROL_CLASS)],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [config.label]
            ),
            h.select(
              [...attributes.select, h.Class(INPUT_CLASS)],
              config.options.map((option) =>
                h.option(
                  [
                    h.Value(option.value),
                    h.Selected(option.value === config.value),
                  ],
                  [option.label]
                )
              )
            ),
            hintView(maybeDescription, attributes.description, h),
          ]
        ),
      value: config.value,
    },
    h
  );
};

/** A labelled text input. */
export interface InputFieldConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => Message;
  readonly type?: string;
  readonly isInvalid?: boolean;
  readonly maybeDescription?: Option.Option<string>;
}

/**
 * A labelled input (Foldkit UI Input).
 *
 * @param config - Its ID, label, value and input Message.
 * @param h - The builder.
 * @returns The control.
 */
export const inputField = <Message>(
  config: InputFieldConfig<Message>,
  h: HtmlBuilder<Message>
): Html => {
  const maybeDescription = config.maybeDescription ?? Option.none();

  return Input.view(
    {
      hasDescription: Option.isSome(maybeDescription),
      id: config.id,
      isInvalid: config.isInvalid ?? false,
      onInput: config.onInput,
      toView: (attributes) =>
        h.div(
          [h.Class(CONTROL_CLASS)],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [config.label]
            ),
            h.input([
              ...attributes.input,
              h.Spellcheck(false),
              h.Class(INPUT_CLASS),
            ]),
            hintView(maybeDescription, attributes.description, h),
          ]
        ),
      type: config.type ?? "text",
      value: config.value,
    },
    h
  );
};

/** A labelled multi-line input. */
export interface TextareaFieldConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => Message;
  readonly isInvalid?: boolean;
  readonly maybeDescription?: Option.Option<string>;
}

const TEXTAREA_ROWS = 3;

/**
 * A labelled textarea (Foldkit UI Textarea).
 *
 * @param config - Its ID, label, value and input Message.
 * @param h - The builder.
 * @returns The control.
 */
export const textareaField = <Message>(
  config: TextareaFieldConfig<Message>,
  h: HtmlBuilder<Message>
): Html => {
  const maybeDescription = config.maybeDescription ?? Option.none();

  return Textarea.view(
    {
      hasDescription: Option.isSome(maybeDescription),
      id: config.id,
      isInvalid: config.isInvalid ?? false,
      onInput: config.onInput,
      rows: TEXTAREA_ROWS,
      toView: (attributes) =>
        h.div(
          [h.Class(CONTROL_CLASS)],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [config.label]
            ),
            h.textarea([
              ...attributes.textarea,
              h.Spellcheck(false),
              h.Class(INPUT_CLASS),
            ]),
            hintView(maybeDescription, attributes.description, h),
          ]
        ),
      value: config.value,
    },
    h
  );
};

/** A labelled checkbox. */
export interface CheckboxFieldConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly isChecked: boolean;
  readonly onToggle: (isChecked: boolean) => Message;
}

/**
 * A labelled checkbox (Foldkit UI Checkbox).
 *
 * @param config - Its ID, label, state and toggle Message.
 * @param h - The builder.
 * @returns The control.
 */
export const checkboxField = <Message>(
  config: CheckboxFieldConfig<Message>,
  h: HtmlBuilder<Message>
): Html =>
  Checkbox.view(
    {
      id: config.id,
      isChecked: config.isChecked,
      onToggle: config.onToggle,
      toView: (attributes) =>
        h.div(
          [h.Class("control control-inline")],
          [
            h.button(
              [...attributes.checkbox, h.Class("checkbox")],
              config.isChecked ? ["✓"] : []
            ),
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [config.label]
            ),
          ]
        ),
    },
    h
  );

/** A button. */
export interface ButtonConfig<Message> {
  readonly text: string;
  readonly onClick: Message;
  readonly variant: "primary" | "quiet";
  readonly isDisabled?: boolean;
  /** An accessible name that differs from the visible text. */
  readonly maybeAriaLabel?: Option.Option<string>;
}

/**
 * A button (Foldkit UI Button).
 *
 * @param config - Its text, Message and look.
 * @param h - The builder.
 * @returns The button.
 */
export const buttonView = <Message>(
  config: ButtonConfig<Message>,
  h: HtmlBuilder<Message>
): Html =>
  Button.view(
    {
      isDisabled: config.isDisabled ?? false,
      onClick: config.onClick,
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            ...Option.match(config.maybeAriaLabel ?? Option.none(), {
              onNone: () => [],
              onSome: (label) => [h.AriaLabel(label)],
            }),
            h.Class(`button button-${config.variant}`),
          ],
          [config.text]
        ),
    },
    h
  );
