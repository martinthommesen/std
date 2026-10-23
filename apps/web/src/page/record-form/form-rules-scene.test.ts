/** Accessible form-rule states through the rendered Foldkit view. */
import { Option } from "effect";
import {
  Command,
  Mount,
  click,
  expect,
  given,
  label,
  role,
  selector,
  scene,
  text,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { describe, it } from "vitest";

import { REVISION_5 } from "../../form-fixture.ts";
import {
  FocusField,
  KeepFocusClearOfActionBar,
  LoadFormState,
} from "./command.ts";
import {
  closedFormVerdict,
  pendingForm,
  pendingExistingForm,
  readOnlyVerdict,
} from "./form-rules-fixture.ts";
import { Message } from "./message.ts";
import { FormStateVerdict, WriteError } from "./model.ts";
import { FORM_MESSAGES_ID, update } from "./update.ts";
import { view } from "./view.ts";

/** The action bar's Mount, which keeps focused fields clear of it. */
const acknowledgeActionBar = Mount.resolve(
  KeepFocusClearOfActionBar,
  Message.CompletedKeepFocusClearOfActionBar()
);

describe("accessible form rules", () => {
  it("renders a colleague's readable record as values with a neutral note and no editable controls or Save", () => {
    scene(
      { update, view },
      given(
        update(
          pendingExistingForm,
          Message.SucceededLoadFormState({
            generation: pendingExistingForm.formGeneration,
            maybeRevision: Option.some(REVISION_5),
            verdict: readOnlyVerdict,
          })
        ).model
      ),
      acknowledgeActionBar,
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Foldkit's scene assertion step
      expect(text("You can view this record but not change it.")).toExist(),
      expect(selector("[data-field] input")).toBeAbsent(),
      expect(selector("[data-field] textarea")).toBeAbsent(),
      expect(selector("[data-field] select")).toBeAbsent(),
      expect(role("combobox")).toBeAbsent(),
      expect(role("checkbox")).toBeAbsent(),
      expect(role("button", { name: "Save" })).toBeAbsent(),
      expect(
        text("You are not allowed to make this proposed change.")
      ).toBeAbsent(),
      expect(text("Checking form rules…")).toBeAbsent(),
      expect(role("textbox", { name: "Description" })).toBeAbsent()
    );
  });

  it("shows pending state quietly, labels required fields, hides controls and displays the derived read-only value", () => {
    scene(
      { update, view },
      given(
        modifyFields(pendingForm, {
          formState: () =>
            FormStateVerdict.Failure({ error: WriteError.Unavailable() }),
          maybeFormStateInFlight: () => Option.none(),
        })
      ),
      acknowledgeActionBar,
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Foldkit's scene assertion step
      expect(
        text(
          "The server did not answer the form check. Your input is kept; try again."
        )
      ).toExist(),
      click(role("button", { name: "Check form again" })),
      expect(text("Checking form rules…")).toExist(),
      expect(selector('[aria-live="polite"][aria-atomic="true"]')).toHaveText(
        ""
      ),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 2,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      expect(
        text(
          "The server did not answer the form check. Your input is kept; try again."
        )
      ).toBeAbsent(),
      expect(label("Description (required)")).toExist(),
      expect(role("spinbutton", { name: "Points" })).toBeAbsent(),
      expect(text("42")).toExist(),
      expect(label("Tracking")).toBeAbsent(),
      click(role("button", { name: "Create" })),
      expect(text("This field is required.")).toExist(),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });

  it("while Save waits on a failed check, the action bar says so and leads to the alert", () => {
    scene(
      { update, view },
      given(
        modifyFields(pendingForm, {
          formState: () =>
            FormStateVerdict.Failure({ error: WriteError.Unavailable() }),
          maybeFormStateInFlight: () => Option.none(),
        })
      ),
      acknowledgeActionBar,
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Foldkit's scene assertion step
      expect(text("Save waits: the form check failed.")).toExist(),
      expect(text("Checking form rules…")).toBeAbsent(),
      expect(role("button", { name: "Create" })).toBeDisabled(),
      click(role("button", { name: "Show the reason" })),
      Command.expectExact(FocusField({ elementId: FORM_MESSAGES_ID })),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });
});
