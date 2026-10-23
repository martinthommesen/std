import { Option, Schema, Stream } from "effect";
import { Dom, Subscription } from "foldkit";
import type { Runtime } from "foldkit";
import type { Url } from "foldkit/url";

import { LoadCurrentUser } from "./command.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { urlToAppRoute } from "./route.ts";
import type { InitialShellPreferences } from "./shell-preferences.ts";
import type { StdApi } from "./std-client.ts";
import { isLeavingUnsavedEdits } from "./update.ts";

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
  typeof InitialShellPreferences.Type,
  StdApi
> = ({ preferences, maybePreferenceProblem }, url: Url) => ({
  commands: [LoadCurrentUser()],
  model: Model.CheckingSession({
    maybePreferenceProblem,
    preferences,
    route: urlToAppRoute(url),
  }),
});

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
