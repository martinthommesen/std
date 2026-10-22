import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { load, pushUrl, replaceUrl } from "foldkit/navigation";

import { Message } from "./message.ts";
import { StdApi } from "./std-client.ts";

/**
 * Asks the server who the browser's session acts as (`GET auth/me`). The
 * session cookie is HTTP-only, so this is the only way the app learns
 * whether it is signed in.
 */
export const LoadCurrentUser = Command.define("LoadCurrentUser", {
  execute: Effect.gen(function* loadCurrentUser() {
    const client = yield* StdApi;
    const user = yield* client.session.me();

    return Message.SucceededLoadCurrentUser({ user });
  }).pipe(
    Effect.catchTag("Unauthenticated", () =>
      Effect.succeed(Message.FailedLoadCurrentUser({ error: "NoSession" }))
    ),
    Effect.orElseSucceed(() =>
      Message.FailedLoadCurrentUser({ error: "Unavailable" })
    )
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
