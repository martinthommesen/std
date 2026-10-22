import { Effect, Option, Schema } from "effect";
import { Command, Dom } from "foldkit";
import { load, pushUrl, replaceUrl } from "foldkit/navigation";

import { Message } from "./message.ts";
import { StdApi } from "./std-client.ts";

/** The element ID of every page's `main`. */
export const MAIN_ID = "main";

/**
 * Asks the server who the browser's session acts as (`GET auth/me`). The
 * session cookie is HTTP-only, so this is the only way the app learns
 * whether it is signed in: `Unauthenticated` is a normal answer (no
 * session), anything else that goes wrong means the server is unavailable.
 */
export const LoadCurrentUser = Command.define("LoadCurrentUser", {
  execute: Effect.gen(function* loadCurrentUser() {
    const client = yield* StdApi;
    const user = yield* client.session.me();

    return Message.SucceededLoadCurrentUser({ maybeUser: Option.some(user) });
  }).pipe(
    Effect.catchTag("Unauthenticated", () =>
      Effect.succeed(
        Message.SucceededLoadCurrentUser({ maybeUser: Option.none() })
      )
    ),
    Effect.orElseSucceed(() => Message.FailedLoadCurrentUser())
  ),
  messages: [Message.SucceededLoadCurrentUser, Message.FailedLoadCurrentUser],
});

/**
 * Ends the session (`POST auth/sign-out`); the server clears the cookie. A
 * session that had already ended counts as signed out.
 */
export const SignOut = Command.define("SignOut", {
  execute: Effect.gen(function* signOut() {
    const client = yield* StdApi;

    yield* client.session.signOut();

    return Message.SucceededSignOut();
  }).pipe(
    Effect.catchTag("Unauthenticated", () =>
      Effect.succeed(Message.SucceededSignOut())
    ),
    Effect.orElseSucceed(() => Message.FailedSignOut())
  ),
  messages: [Message.SucceededSignOut, Message.FailedSignOut],
});

/**
 * Moves focus to the new page's `main`, so keyboard and screen-reader
 * users start from the page that replaced the one they were on.
 */
export const FocusMain = Command.define("FocusMain", {
  execute: Dom.focus(`#${MAIN_ID}`, {
    makeFocusable: true,
    preventScroll: true,
  }).pipe(Effect.ignore, Effect.as(Message.CompletedFocusMain())),
  messages: [Message.CompletedFocusMain],
});

/** Follows an in-app link. */
export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
  messages: [Message.CompletedNavigateInternal],
});

/** Follows a link to another site. */
export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
  messages: [Message.CompletedLoadExternal],
});

/**
 * Replaces the address without a new history entry: redirects between the
 * sign-in page and the signed-in pages.
 */
export const ReplaceUrl = Command.define("ReplaceUrl", {
  args: { url: Schema.String },
  execute: ({ url }) =>
    replaceUrl(url).pipe(Effect.as(Message.CompletedReplaceUrl())),
  messages: [Message.CompletedReplaceUrl],
});
