import "./styles.css";
import { Layer } from "effect";
import { Http, Runtime } from "foldkit";

import { init, subscriptions } from "./main.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import {
  InitialShellPreferences,
  readShellPreferences,
} from "./shell-preferences.ts";
import { StdApi } from "./std-client.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const application = Runtime.makeApplication({
  Flags: InitialShellPreferences,
  Model,
  container: document.querySelector("#root") ?? document.body,
  devTools: { Message },
  init,
  resources: StdApi.layer.pipe(Layer.provide(Http.layer)),
  routing: {
    onUrlChange: (url) => Message.ChangedUrl({ url }),
    onUrlRequest: (request) => Message.ClickedLink({ request }),
  },
  subscriptions,
  update,
  view,
});

Runtime.run(application, {
  flags: readShellPreferences,
});
