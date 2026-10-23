import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { ada, adaAtHome, urlOf } from "../../fixture.ts";
import { Message as AppMessage } from "../../message.ts";
import { Model as AppModel } from "../../model.ts";
import { AppRoute, deadLettersRouter } from "../../route.ts";
import { REVISION_3 } from "../../table-fixture.ts";
import { update } from "../../update.ts";
import { Message as SignInMessage } from "../sign-in/sign-in.ts";
import { emptyPage } from "./fixture.ts";
import { Message } from "./message.ts";

const opened = update(
  adaAtHome,
  AppMessage.ChangedUrl({ url: urlOf(deadLettersRouter()) })
).model;

describe("dead-letter session integration", () => {
  it("expiry returns to sign-in, successful sign-in returns to this page, and old session replies are ignored", () => {
    if (!AppModel.guards.SignedIn(opened)) {
      throw new Error("Expected the fixture to be signed in.");
    }

    const page = Option.getOrThrow(opened.maybeDeadLetters);

    const expired = update(
      opened,
      AppMessage.GotDeadLettersMessage({
        message: Message.LoadDeadLettersSessionEnded({
          requestId: page.requestId,
        }),
        pageId: page.id,
      })
    ).model;

    if (!AppModel.guards.SignedOut(expired)) {
      throw new Error("Expected session expiry.");
    }

    expect(expired.route).toStrictEqual(AppRoute.SignIn());
    expect(expired.maybeReturnRoute).toStrictEqual(
      Option.some(AppRoute.DeadLetters())
    );

    const returned = update(
      expired,
      AppMessage.GotSignInMessage({
        message: SignInMessage.SucceededSignIn({
          maybeRevision: Option.some(REVISION_3),
          user: ada,
        }),
      })
    ).model;

    if (!AppModel.guards.SignedIn(returned)) {
      throw new Error("Expected the new session.");
    }

    expect({
      route: returned.route,
      sessionId: returned.sessionId,
    }).toStrictEqual({
      route: AppRoute.DeadLetters(),
      sessionId: opened.sessionId + 1,
    });
    expect(Option.getOrThrow(returned.maybeDeadLetters).id).not.toBe(page.id);

    const stale = AppMessage.GotDeadLettersMessage({
      message: Message.LoadDeadLettersSessionEnded({
        requestId: page.requestId,
      }),
      pageId: page.id,
    });

    expect(update(returned, stale).model).toBe(returned);
  });

  it("a reply to an abandoned page cannot change the next page or end its session", () => {
    if (!AppModel.guards.SignedIn(opened)) {
      throw new Error("Expected the fixture session.");
    }

    const first = Option.getOrThrow(opened.maybeDeadLetters);

    const away = update(
      opened,
      AppMessage.ChangedUrl({ url: urlOf("/") })
    ).model;

    const returned = update(
      away,
      AppMessage.ChangedUrl({ url: urlOf(deadLettersRouter()) })
    ).model;

    const reply = AppMessage.GotDeadLettersMessage({
      message: emptyPage(first.requestId),
      pageId: first.id,
    });

    expect(update(returned, reply).model).toBe(returned);

    const ended = AppMessage.GotDeadLettersMessage({
      message: Message.LoadDeadLettersSessionEnded({
        requestId: first.requestId,
      }),
      pageId: first.id,
    });

    expect(update(returned, ended).model).toBe(returned);
  });
});
