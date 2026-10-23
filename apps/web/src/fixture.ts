import { Option } from "effect";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";

import type { CurrentUser, SignedInModel } from "./model.ts";
import { Model, SignOutRequest, Tables } from "./model.ts";
import { initLeaveDialog, initNavigationDrawer } from "./navigation-drawer.ts";
import { init as signInInit } from "./page/sign-in/sign-in.ts";
import { AppRoute } from "./route.ts";
import { DEFAULT_SHELL_PREFERENCES } from "./shell-preferences.ts";
import { REVISION_3, adaTables } from "./table-fixture.ts";
import { initUserMenu } from "./user-menu.ts";

/** A signed-in user, as `session/current` describes her. */
export const ada: CurrentUser = {
  "@type": "Session",
  href: "http://localhost:5173/api/v1/session/current",
  id: "current",
  name: "Ada Lovelace",
  roles: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      label: "Asset manager",
      name: "asset_manager",
    },
  ],
  schemaRevision: 3,
  user: { "@type": "CoreUserRef", id: "019a0000-0000-7000-8000-000000000001" },
};

/** Ada, signed in, on the home page. */
export const adaAtHome = Model.SignedIn({
  leaveDialog: initLeaveDialog(),
  maybeDeadLetters: Option.none(),
  maybeLeaveIntent: Option.none(),
  maybePreferenceProblem: Option.none(),
  maybeRecordForm: Option.none(),
  maybeRevision: Option.some(REVISION_3),
  maybeTableList: Option.none(),
  navigationDrawer: initNavigationDrawer(),
  nextPageId: 1,
  preferences: DEFAULT_SHELL_PREFERENCES,
  route: AppRoute.Home(),
  sessionId: 1,
  signOutRequest: SignOutRequest.Idle(),
  tables: Tables.Success({
    data: { revision: REVISION_3, tables: adaTables.tables },
  }),
  user: ada,
  userMenu: initUserMenu(),
});

/** Ada, just signed in, on the home page: her tables are loading. */
export const adaEnteringHome = modifyFields(adaAtHome, {
  tables: () => Tables.Loading(),
});

/** The sign-in page, opened directly. */
export const signInOpenedDirectly = Model.SignedOut({
  maybePreferenceProblem: Option.none(),
  maybeReturnRoute: Option.none(),
  nextPageId: 1,
  nextSessionId: 1,
  preferences: DEFAULT_SHELL_PREFERENCES,
  route: AppRoute.SignIn(),
  signIn: signInInit(),
});

/** The sign-in page after a redirect from the home page. */
export const signInRedirectedFromHome = modifyFields(signInOpenedDirectly, {
  maybeReturnRoute: () => Option.some(AppRoute.Home()),
});

/**
 * The signed-in state, or a failure naming the state found instead.
 * @param app - The app's state.
 * @returns It, signed in.
 */
export const signedIn = (app: Model): SignedInModel => {
  if (!Model.guards.SignedIn(app)) {
    throw new Error(`expected a signed-in state, found ${app._tag}`);
  }

  return app;
};

/**
 * An address of the app, as the runtime parses it.
 *
 * @param pathname - The path.
 * @returns The URL.
 */
export const urlOf = (pathname: string): Url => ({
  hash: Option.none(),
  host: "localhost:5173",
  pathname,
  port: Option.none(),
  protocol: "http:",
  search: Option.none(),
});
