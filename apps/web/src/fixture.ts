import type { CurrentUser } from "@std/api/session";
import { Option } from "effect";

import { Model, SignOutRequest } from "./model.ts";
import { init as initSignIn } from "./page/sign-in/sign-in.ts";
import { AppRoute } from "./route.ts";

/** A signed-in user, as `auth/me` describes her. */
export const ada: CurrentUser = {
  name: "Ada Lovelace",
  roles: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      label: "Asset manager",
      name: "asset_manager",
    },
  ],
  schemaRevision: 3,
  userId: "019a0000-0000-7000-8000-000000000001",
};

/** Ada, signed in, on the home page. */
export const adaAtHome = Model.SignedIn({
  route: AppRoute.Home(),
  signOut: SignOutRequest.Idle(),
  user: ada,
});

/** The sign-in page, after a redirect from the home page. */
export const signInFromHome = Model.SignedOut({
  maybeReturnRoute: Option.some(AppRoute.Home()),
  route: AppRoute.SignIn(),
  signIn: initSignIn(),
});
