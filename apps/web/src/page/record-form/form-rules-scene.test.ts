/** Accessible form-rule states through the rendered Foldkit view. */
import { Option } from "effect";
import {
  Command,
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

import { LoadFormState, FocusField } from "./command.ts";
import { closedFormVerdict, pendingForm } from "./form-rules-fixture.ts";
import { Message } from "./message.ts";
import { FormStateVerdict, WriteError } from "./model.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

describe("accessible form rules", () => {
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
});
