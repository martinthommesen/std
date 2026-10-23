import type { Runtime } from "foldkit";
import type { Url } from "foldkit/url";

import { LoadCurrentUser } from "./command.ts";
import type { Message } from "./message.ts";
import { Model } from "./model.ts";
import { urlToAppRoute } from "./route.ts";
import type { StdApi } from "./std-client.ts";

// INIT

/**
 * Starts on the address's route and asks the server whether the browser
 * holds a session (the HTTP-only cookie, which no script can read).
 *
 * @param url - The address the app was opened at.
 * @returns The checking state and the `session/current` request.
 */
export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  void,
  StdApi
> = (url: Url) => ({
  commands: [LoadCurrentUser()],
  model: Model.CheckingSession({ route: urlToAppRoute(url) }),
});
