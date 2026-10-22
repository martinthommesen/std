import { Match, Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal } from "foldkit/route";

/** Every page of the app. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const AppRoute = defineRouteUnion({
  Home: {},
  NotFound: { path: Schema.String },
  SignIn: {},
});

/** A page of the app. */
export type AppRoute = typeof AppRoute.Type;

/** The pages a signed-in user can be on. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SignedInRoute = AppRoute.subset(["Home", "NotFound"]);

/** A page a signed-in user can be on. */
export type SignedInRoute = typeof SignedInRoute.Type;

/** The pages a signed-out visitor can be on. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SignedOutRoute = AppRoute.subset(["SignIn", "NotFound"]);

/** A page a signed-out visitor can be on. */
export type SignedOutRoute = typeof SignedOutRoute.Type;

/** `/`: the home page. */
export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

/** `/sign-in`: the sign-in page. */
export const signInRouter = pipe(
  literal("sign-in"),
  Route.mapTo(AppRoute.SignIn)
);

/** The route of a URL; an unknown path is `NotFound`. */
export const urlToAppRoute = Route.parseUrlWithFallback(
  Route.oneOf(signInRouter, homeRouter),
  AppRoute.NotFound
);

/**
 * The URL of a signed-in page.
 *
 * @param route - The page.
 * @returns Its path.
 */
export const signedInRouteToUrl = (route: SignedInRoute): string =>
  Match.value(route).pipe(
    Match.tag("Home", () => homeRouter()),
    Match.tag("NotFound", ({ path }) => path),
    Match.exhaustive
  );
