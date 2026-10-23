import "./styles.css";
import { Effect } from "effect";
import { Runtime } from "foldkit";

import { Flags, init } from "./main.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { readShellPreferences } from "./shell-preferences.ts";
import { StdApi } from "./std-client.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const application = Runtime.makeApplication({
  Flags,
  Model,
  container: document.querySelector("#root") ?? document.body,
  devTools: { Message },
  init,
  resources: StdApi.layer,
  routing: {
    onUrlChange: (url) => Message.ChangedUrl({ url }),
    onUrlRequest: (request) => Message.ClickedLink({ request }),
  },
  update,
  view,
});

Runtime.run(application, {
  flags: readShellPreferences.pipe(
    Effect.map((storedPreferences) => ({ storedPreferences }))
  ),
});
