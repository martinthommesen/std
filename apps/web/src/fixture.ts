import { Option } from "effect";
import type { Url } from "foldkit/url";

import type { CurrentUser } from "./model.ts";
import { Model, SignOutRequest, Tables } from "./model.ts";
import { init as signInInit } from "./page/sign-in/sign-in.ts";
import { AppRoute } from "./route.ts";
import { REVISION_3, adaTables } from "./table-fixture.ts";

/** A signed-in user, as `session/current` describes her. */
export const ada: CurrentUser = {
  "@type": "Session",
  href: "http://localhost:5173/api/v2/session/current",
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
  maybeRecordForm: Option.none(),
  maybeRevision: Option.some(REVISION_3),
  maybeTableList: Option.none(),
  nextPageId: 1,
  route: AppRoute.Home(),
  sessionId: 1,
  signOutRequest: SignOutRequest.Idle(),
  tables: Tables.Success({
    data: { revision: REVISION_3, tables: adaTables.tables },
  }),
  user: ada,
});

/** Ada, just signed in, on the home page: her tables are loading. */
export const adaEnteringHome = Model.SignedIn({
  maybeRecordForm: Option.none(),
  maybeRevision: Option.some(REVISION_3),
  maybeTableList: Option.none(),
  nextPageId: 1,
  route: AppRoute.Home(),
  sessionId: 1,
  signOutRequest: SignOutRequest.Idle(),
  tables: Tables.Loading(),
  user: ada,
});

/** The sign-in page after a redirect from the home page. */
export const signInRedirectedFromHome = Model.SignedOut({
  maybeReturnRoute: Option.some(AppRoute.Home()),
  nextPageId: 1,
  nextSessionId: 1,
  route: AppRoute.SignIn(),
  signIn: signInInit(),
});

/** The sign-in page, opened directly. */
export const signInOpenedDirectly = Model.SignedOut({
  maybeReturnRoute: Option.none(),
  nextPageId: 1,
  nextSessionId: 1,
  route: AppRoute.SignIn(),
  signIn: signInInit(),
});

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
