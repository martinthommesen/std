import { isTmfError } from "@std/api/client";
import { Effect, Option, Schema } from "effect";
import { Command, Dom } from "foldkit";
import { load, pushUrl, replaceUrl } from "foldkit/navigation";

import { SchemaRevision } from "./domain/schema-revision.ts";
import { Message } from "./message.ts";
import {
  SHELL_PREFERENCES_KEY,
  ShellPreferences,
  ShellPreferencesJson,
} from "./shell-preferences.ts";
import { StdApi, atRevision, responseRevision } from "./std-client.ts";

/** The element ID of every page's `main`. */
export const MAIN_ID = "main";

/**
 * The ID of the navigation drawer's disclosure: its button is
 * `navigation-button`, its panel (the sidebar) `navigation-panel`.
 */
export const NAVIGATION_TOGGLE_ID = "navigation";

/**
 * Asks the server who the browser's session acts as (the current
 * session). The session cookie is HTTP-only, so this is the only way the
 * app learns
 * whether it is signed in: `Unauthenticated` is a normal answer (no
 * session), anything else that goes wrong means the server is unavailable.
 */
export const LoadCurrentUser = Command.define("LoadCurrentUser", {
  execute: Effect.gen(function* loadCurrentUser() {
    const client = yield* StdApi;

    const [user, response] = yield* client.session.current({
      responseMode: "decoded-and-response",
    });

    return Message.SucceededLoadCurrentUser({
      maybeRevision: responseRevision(response),
      maybeUser: Option.some(user),
    });
  }).pipe(
    Effect.catchIf(isTmfError("Unauthenticated"), () =>
      Effect.succeed(
        Message.SucceededLoadCurrentUser({
          maybeRevision: Option.none(),
          maybeUser: Option.none(),
        })
      )
    ),
    Effect.orElseSucceed(() => Message.FailedLoadCurrentUser())
  ),
  messages: [Message.SucceededLoadCurrentUser, Message.FailedLoadCurrentUser],
});

const loadTablesAt = (
  revision: Option.Option<SchemaRevision>,
  sessionId: number
) =>
  Effect.gen(function* loadTables() {
    const client = yield* StdApi;

    const [tables, response] = yield* client.tableMetadata
      .list({ responseMode: "decoded-and-response" })
      .pipe(atRevision(revision));

    return Option.match(responseRevision(response), {
      onNone: () => Message.FailedLoadTables({ sessionId }),
      onSome: (stated) =>
        Message.SucceededLoadTables({
          revision: stated,
          sessionId,
          tables,
        }),
    });
  });

/**
 * Loads the tables the user can open (`GET tableMetadata`), for the
 * navigation and the home page, at the latest revision the app has seen.
 * A revision the database never had (after a restore) is dropped and the
 * list asked for again without one. Every answer names the session that
 * asked, so it counts in no other.
 */
export const LoadTables = Command.define("LoadTables", {
  args: {
    maybeRevision: Schema.Option(SchemaRevision),
    sessionId: Schema.Int,
  },
  execute: ({ maybeRevision, sessionId }) =>
    loadTablesAt(maybeRevision, sessionId).pipe(
      Effect.catchIf(isTmfError("SchemaChanged"), () =>
        loadTablesAt(Option.none(), sessionId)
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication({ sessionId }))
      ),
      Effect.orElseSucceed(() => Message.FailedLoadTables({ sessionId }))
    ),
  messages: [
    Message.SucceededLoadTables,
    Message.FailedLoadTables,
    Message.FailedAuthentication,
  ],
});

/**
 * Ends the session (`DELETE session/current`); the server clears the
 * cookie. A
 * session that had already ended counts as signed out. The answer names
 * the session that asked, so it counts in no other.
 */
export const SignOut = Command.define("SignOut", {
  args: {
    maybeRevision: Schema.Option(SchemaRevision),
    sessionId: Schema.Int,
  },
  execute: ({ maybeRevision, sessionId }) =>
    Effect.gen(function* signOut() {
      const client = yield* StdApi;

      yield* client.session.signOut().pipe(atRevision(maybeRevision));

      return Message.SucceededSignOut({ sessionId });
    }).pipe(
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.SucceededSignOut({ sessionId }))
      ),
      Effect.orElseSucceed(() => Message.FailedSignOut({ sessionId }))
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

/**
 * Stores the shell's preferences in the browser (`localStorage`), so the
 * next visit opens the navigation as the user left it. A browser that
 * refuses (storage disabled or full) answers `FailedSaveShellPreferences`,
 * which the navigation says.
 */
export const SaveShellPreferences = Command.define("SaveShellPreferences", {
  args: { preferences: ShellPreferences },
  execute: ({ preferences }) =>
    Schema.encodeEffect(ShellPreferencesJson)(preferences).pipe(
      Effect.flatMap((text) =>
        Effect.try(() => {
          globalThis.localStorage.setItem(SHELL_PREFERENCES_KEY, text);
        })
      ),
      Effect.as(Message.CompletedSaveShellPreferences()),
      Effect.orElseSucceed(() => Message.FailedSaveShellPreferences())
    ),
  messages: [
    Message.CompletedSaveShellPreferences,
    Message.FailedSaveShellPreferences,
  ],
});

/**
 * Moves focus into the navigation drawer once it opens on a narrow
 * screen, to its first link, so keyboard users land in what they opened.
 */
export const FocusNavigation = Command.define("FocusNavigation", {
  execute: Dom.focus(`#${NAVIGATION_TOGGLE_ID}-panel a`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusNavigation())
  ),
  messages: [Message.CompletedFocusNavigation],
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
