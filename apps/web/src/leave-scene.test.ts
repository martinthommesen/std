/** The leave confirmation as the user meets it, through the rendered view. */
import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import {
  Command,
  Mount,
  click,
  expect,
  given,
  role,
  scene,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";
import { describe, it } from "vitest";

import { NavigateInternal, SignOut } from "./command.ts";
import { adaAtHome, urlOf } from "./fixture.ts";
import { TICKET } from "./form-fixture.ts";
import { Message } from "./message.ts";
import { LeaveIntent } from "./model.ts";
import { initLeaveDialog } from "./navigation-drawer.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const LIST_URL = urlToString(urlOf(`/tables/${TICKET}`));

describe("the leave confirmation", () => {
  it("the confirmation says what is lost, starts on Keep editing, and Discard changes leaves", () => {
    scene(
      { update, view },
      given(
        modifyFields(adaAtHome, {
          leaveDialog: () => Dialog.open(initLeaveDialog()).model,
          maybeLeaveIntent: () =>
            Option.some(LeaveIntent.FollowLink({ url: LIST_URL })),
        })
      ),
      Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(role("dialog", { name: "Leave without saving?" })).toHaveAttr(
        "aria-modal",
        "true"
      ),
      expect(role("button", { name: "Keep editing" })).toHaveAttr(
        "data-foldkit-dialog-initial-focus",
        ""
      ),
      click(role("button", { name: "Discard changes" })),
      Command.expectHas(NavigateInternal({ url: LIST_URL })),
      Command.resolveAll(
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
        [NavigateInternal, Message.CompletedNavigateInternal()]
      ),
      Mount.expectEnded(Dialog.AcquireResources)
    );
  });

  it("from Sign out, it says signing out loses the changes", () => {
    scene(
      { update, view },
      given(
        modifyFields(adaAtHome, {
          leaveDialog: () => Dialog.open(initLeaveDialog()).model,
          maybeLeaveIntent: () => Option.some(LeaveIntent.SignOut()),
        })
      ),
      Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(role("dialog", { name: "Leave without saving?" })).toContainText(
        "If you sign out, they are lost."
      ),
      click(role("button", { name: "Discard changes" })),
      Command.expectHas(
        SignOut({ maybeRevision: adaAtHome.maybeRevision, sessionId: 1 })
      ),
      Command.resolveAll(
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
        [SignOut, Message.FailedSignOut({ sessionId: 1 })]
      ),
      Mount.expectEnded(Dialog.AcquireResources)
    );
  });
});
