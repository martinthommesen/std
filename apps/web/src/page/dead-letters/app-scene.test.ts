import { Option } from "effect";
import {
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { describe, it } from "vitest";

import { FocusMain, LoadTables, ReplaceUrl } from "../../command.ts";
import { ada, adaAtHome, urlOf } from "../../fixture.ts";
import { Message as AppMessage } from "../../message.ts";
import { Tables } from "../../model.ts";
import { deadLettersRouter } from "../../route.ts";
import { REVISION_3, adaTables, summaryOf } from "../../table-fixture.ts";
import { update } from "../../update.ts";
import { view } from "../../view.ts";
import { Message as SignInMessage, SignIn } from "../sign-in/sign-in.ts";
import { LoadDeadLetters } from "./command.ts";
import { Message } from "./message.ts";

const tables = [
  ...adaTables.tables,
  summaryOf("core.subscription", "Subscription", false),
];

const atHome = modifyFields(adaAtHome, {
  tables: () => Tables.Success({ data: { revision: REVISION_3, tables } }),
});

const opened = update(
  atHome,
  AppMessage.ChangedUrl({ url: urlOf(deadLettersRouter()) })
).model;

const loadedPage = update(
  opened,
  AppMessage.GotDeadLettersMessage({
    message: Message.SucceededLoadDeadLetters({
      page: { deliveries: [], total: 0 },
      requestId: 1,
    }),
    pageId: 1,
  })
).model;

describe("dead-letter session view", () => {
  it("an expired page signs in again and returns to the operator list through its parent", () => {
    scene(
      { update, view },
      given(loadedPage),
      click(role("button", { name: "Refresh" })),
      Command.resolve(
        LoadDeadLetters,
        Message.LoadDeadLettersSessionEnded({ requestId: 2 })
      ),
      Command.resolveAll(
        [ReplaceUrl, AppMessage.CompletedReplaceUrl()],
        [FocusMain, AppMessage.CompletedFocusMain()]
      ),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Foldkit's scene assertion
      expect(role("heading", { name: "Sign in to STD" })).toExist(),
      Command.expectNone(),
      type(label("Login"), "ada"),
      type(label("Password"), "ada-password"),
      submit(role("form", { name: "Sign in to STD" })),
      Command.resolve(
        SignIn,
        SignInMessage.SucceededSignIn({
          maybeRevision: Option.some(REVISION_3),
          user: ada,
        })
      ),
      Command.expectHas(ReplaceUrl({ url: deadLettersRouter() })),
      Command.resolveAll(
        [ReplaceUrl, AppMessage.CompletedReplaceUrl()],
        [FocusMain, AppMessage.CompletedFocusMain()],
        [
          LoadTables,
          AppMessage.SucceededLoadTables({
            revision: REVISION_3,
            sessionId: 2,
            tables,
          }),
        ],
        [
          LoadDeadLetters,
          Message.SucceededLoadDeadLetters({
            page: { deliveries: [], total: 0 },
            requestId: 1,
          }),
        ]
      ),
      expect(role("heading", { level: 1, name: "Dead letters" })).toExist(),
      expect(text("No dead deliveries match these filters.")).toExist(),
      expect(role("heading", { name: "Sign in to STD" })).not.toExist()
    );
  });
});
