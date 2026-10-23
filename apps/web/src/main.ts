import { Option, Schema, Stream } from "effect";
import { Dom, Subscription } from "foldkit";
import type { Runtime } from "foldkit";
import type { Url } from "foldkit/url";

import { LoadCurrentUser } from "./command.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { urlToAppRoute } from "./route.ts";
import {
  DEFAULT_SHELL_PREFERENCES,
  StoredShellPreferences,
} from "./shell-preferences.ts";
import type {
  PreferenceProblem,
  ShellPreferences,
} from "./shell-preferences.ts";
import type { StdApi } from "./std-client.ts";
import { isLeavingUnsavedEdits } from "./update.ts";

// FLAGS

/**
 * What the app is started with: what the browser stored of the shell's
 * preferences. A struct around the union, because Foldkit's init type
 * distributes over a union of flags and would take only one case.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Flags = Schema.Struct({
  storedPreferences: StoredShellPreferences,
});

/** What the app is started with. */
export type Flags = typeof Flags.Type;

// INIT

/**
 * Starts on the address's route and asks the server whether the browser
 * holds a session (the HTTP-only cookie, which no script can read).
 *
 * @param flags - The app's flags: what the browser stored of the shell's
 *   preferences; the defaults apply when it stored none or could not say.
 * @param url - The address the app was opened at.
 * @returns The checking state and the `session/current` request.
 */
export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  Flags,
  StdApi
> = ({ storedPreferences }: Flags, url: Url) => {
  const [preferences, maybePreferenceProblem] = StoredShellPreferences.match<
    readonly [ShellPreferences, Option.Option<PreferenceProblem>]
  >(storedPreferences, {
    // oxlint-disable-next-line sonarjs/function-name -- a match case is keyed by its case's tag
    Absent: () => [DEFAULT_SHELL_PREFERENCES, Option.none()],
    // oxlint-disable-next-line sonarjs/function-name -- a match case is keyed by its case's tag
    Invalid: () => [DEFAULT_SHELL_PREFERENCES, Option.some("Invalid")],
    // oxlint-disable-next-line sonarjs/function-name -- a match case is keyed by its case's tag
    Stored: ({ preferences: kept }) => [kept, Option.none()],
    // oxlint-disable-next-line sonarjs/function-name -- a match case is keyed by its case's tag
    Unreadable: () => [DEFAULT_SHELL_PREFERENCES, Option.some("Unreadable")],
  });

  return {
    commands: [LoadCurrentUser()],
    model: Model.CheckingSession({
      maybePreferenceProblem,
      preferences,
      route: urlToAppRoute(url),
    }),
  };
};

// SUBSCRIPTIONS

/**
 * While the form page holds unsaved edits, the browser asks before the
 * page unloads (a reload, a typed address, closing the tab, an external
 * link): the `beforeunload` event is cancelled, and the browser shows its
 * own question. In-app links and Sign out ask through the leave
 * confirmation instead.
 * The browser's Back and Forward buttons change the address of this
 * single-page app without unloading it, and a history move cannot be held
 * back, so they leave the form without asking.
 */
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  unsavedEdits: entry(
    { isLeavingUnsavedEdits: Schema.Boolean },
    {
      dependenciesToStream: ({ isLeavingUnsavedEdits: isGuarded }) =>
        isGuarded
          ? Dom.streamFromEventFilterMapPreventDefault({
              filterMapEvent: () =>
                Option.some(Message.RequestedUnloadWithUnsavedEdits()),
              target: globalThis.window,
              type: "beforeunload",
            })
          : Stream.empty,
      modelToDependencies: (model) => ({
        isLeavingUnsavedEdits: isLeavingUnsavedEdits(model),
      }),
    }
  ),
}));
