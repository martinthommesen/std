import { Effect, Option, Schema } from "effect";
import { Command, Dom } from "foldkit";
import { load, pushUrl, replaceUrl } from "foldkit/navigation";

import { SchemaRevision } from "./domain/schema-revision.ts";
import { Message } from "./message.ts";
import { StdApi, atRevision, responseRevision } from "./std-client.ts";

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

const loadTablesAt = (revision: Option.Option<SchemaRevision>) =>
  Effect.gen(function* loadTables() {
    const client = yield* StdApi;

    const [list, response] = yield* client.metadata
      .tables({ responseMode: "decoded-and-response" })
      .pipe(atRevision(revision));

    return Option.match(responseRevision(response), {
      onNone: () => Message.FailedLoadTables(),
      onSome: (stated) =>
        Message.SucceededLoadTables({ revision: stated, tables: list.tables }),
    });
  });

/**
 * Loads the tables the user can open (`GET meta/tables`), for the
 * navigation and the home page, at the latest revision the app has seen.
 * A revision the database never had (after a restore) is dropped and the
 * list asked for again without one.
 */
export const LoadTables = Command.define("LoadTables", {
  args: { maybeRevision: Schema.Option(SchemaRevision) },
  execute: ({ maybeRevision }) =>
    loadTablesAt(maybeRevision).pipe(
      Effect.catchTag("SchemaChanged", () => loadTablesAt(Option.none())),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() => Message.FailedLoadTables())
    ),
  messages: [
    Message.SucceededLoadTables,
    Message.FailedLoadTables,
    Message.FailedAuthentication,
  ],
});

/**
 * Ends the session (`POST auth/sign-out`); the server clears the cookie. A
 * session that had already ended counts as signed out.
 */
export const SignOut = Command.define("SignOut", {
  args: { maybeRevision: Schema.Option(SchemaRevision) },
  execute: ({ maybeRevision }) =>
    Effect.gen(function* signOut() {
      const client = yield* StdApi;

      yield* client.session.signOut().pipe(atRevision(maybeRevision));

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
