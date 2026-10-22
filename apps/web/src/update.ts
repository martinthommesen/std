import type { CurrentUser } from "@std/api/session";
import { Match, Option } from "effect";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";

import {
  LoadCurrentUser,
  LoadExternal,
  NavigateInternal,
  ReplaceUrl,
  SignOut,
} from "./command.ts";
import { Message } from "./message.ts";
import type { LoadCurrentUserError } from "./message.ts";
import { Model, SignOutRequest } from "./model.ts";
import type { SignedInModel } from "./model.ts";
import {
  OutMessage as SignInOutMessage,
  init as initSignIn,
  update as updateSignIn,
} from "./page/sign-in/sign-in.ts";
import {
  AppRoute,
  homeRouter,
  signInRouter,
  signedInRouteToUrl,
  urlToAppRoute,
} from "./route.ts";
import type { SignedInRoute, SignedOutRoute } from "./route.ts";
import type { StdApi } from "./std-client.ts";

type UpdateReturn = Update.Return<Model, Message, StdApi>;

type Step = Update.Step<Model, Message, StdApi>;

const withUpdateReturn = Match.withReturnType<UpdateReturn>();

/**
 * Lands a signed-in user on a route: the sign-in page redirects home.
 *
 * @param route - The route asked for.
 * @param toModel - The signed-in state on the route landed on.
 * @returns The state and the redirect, if any.
 */
const landSignedIn = (
  route: AppRoute,
  toModel: (route: SignedInRoute) => Model
): UpdateReturn =>
  Match.value(route).pipe(
    withUpdateReturn,
    Match.tag("SignIn", () => ({
      commands: [ReplaceUrl({ url: homeRouter() })],
      model: toModel(AppRoute.Home()),
    })),
    Match.orElse((signedInRoute) => ({ model: toModel(signedInRoute) }))
  );

/**
 * Lands a signed-out visitor on a route: a signed-in page redirects to the
 * sign-in page and is kept to return to.
 *
 * @param route - The route asked for.
 * @param toModel - The signed-out state on the route landed on.
 * @returns The state and the redirect, if any.
 */
const landSignedOut = (
  route: AppRoute,
  toModel: (
    route: SignedOutRoute,
    maybeReturnRoute: Option.Option<SignedInRoute>
  ) => Model
): UpdateReturn =>
  Match.value(route).pipe(
    withUpdateReturn,
    Match.tag("Home", (home) => ({
      commands: [ReplaceUrl({ url: signInRouter() })],
      model: toModel(AppRoute.SignIn(), Option.some(home)),
    })),
    Match.orElse((signedOutRoute) => ({
      model: toModel(signedOutRoute, Option.none()),
    }))
  );

/**
 * A fresh signed-out state.
 *
 * @param route - The page.
 * @param maybeReturnRoute - The page to go to after sign-in.
 * @returns The state.
 */
const signedOut = (
  route: SignedOutRoute,
  maybeReturnRoute: Option.Option<SignedInRoute>
): Model => Model.SignedOut({ maybeReturnRoute, route, signIn: initSignIn() });

/**
 * A fresh signed-in state.
 *
 * @param user - Who is signed in.
 * @returns The state on a route.
 */
const signedIn =
  (user: CurrentUser) =>
  (route: SignedInRoute): Model =>
    Model.SignedIn({ route, signOut: SignOutRequest.Idle(), user });

/**
 * Settles start-up: `auth/me` answered with no user.
 *
 * @param route - The route the app started on.
 * @param error - Why there is no user.
 * @returns The signed-out or unavailable state.
 */
const settleWithoutUser = (
  route: AppRoute,
  error: typeof LoadCurrentUserError.Type
): UpdateReturn =>
  error === "NoSession"
    ? landSignedOut(route, signedOut)
    : { model: Model.SessionUnavailable({ route }) };

/**
 * Applies a new address to the state the app is in.
 *
 * @param model - The state.
 * @param route - The new address's route.
 * @returns The next state and any redirect.
 */
const changeRoute = (model: Model, route: AppRoute): UpdateReturn =>
  Match.value(model).pipe(
    withUpdateReturn,
    Match.tag("SignedIn", (signedInModel) =>
      landSignedIn(route, (nextRoute) =>
        modifyFields(signedInModel, { route: () => nextRoute })
      )
    ),
    Match.tag("SignedOut", (signedOutModel) =>
      landSignedOut(route, (nextRoute, maybeReturnRoute) =>
        modifyFields(signedOutModel, {
          maybeReturnRoute: () => maybeReturnRoute,
          route: () => nextRoute,
        })
      )
    ),
    Match.tag("CheckingSession", "SessionUnavailable", (waiting) => ({
      model: modifyFields(waiting, { route: () => route }),
    })),
    Match.exhaustive
  );

/**
 * Runs an update only in the signed-in state; elsewhere the Message
 * answers a request from an earlier state and changes nothing.
 *
 * @param model - The state.
 * @param whenSignedIn - The update for the signed-in state.
 * @returns Its result, or the unchanged state.
 */
const inSignedIn = (
  model: Model,
  whenSignedIn: (signedInModel: SignedInModel) => UpdateReturn
): UpdateReturn =>
  Match.value(model).pipe(
    withUpdateReturn,
    Match.tag("SignedIn", whenSignedIn),
    Match.orElse(() => ({ model }))
  );

/**
 * Runs an update only while start-up asks for the session.
 *
 * @param model - The state.
 * @param whenChecking - The update for the start-up state, given its route.
 * @returns Its result, or the unchanged state.
 */
const inCheckingSession = (
  model: Model,
  whenChecking: (route: AppRoute) => UpdateReturn
): UpdateReturn =>
  Match.value(model).pipe(
    withUpdateReturn,
    Match.tag("CheckingSession", ({ route }) => whenChecking(route)),
    Match.orElse(() => ({ model }))
  );

/**
 * After sign-in: the signed-in state, on the page asked for before
 * sign-in or on the home page.
 *
 * @param user - Who signed in.
 * @returns The step from the signed-out state.
 */
const enterAfterSignIn =
  (user: CurrentUser): Step =>
  (model) => {
    const route = Match.value(model).pipe(
      Match.tag("SignedOut", ({ maybeReturnRoute }): SignedInRoute =>
        Option.getOrElse(maybeReturnRoute, () => AppRoute.Home())
      ),
      Match.orElse((): SignedInRoute => AppRoute.Home())
    );

    return {
      commands: [ReplaceUrl({ url: signedInRouteToUrl(route) })],
      model: signedIn(user)(route),
    };
  };

const foldSignIn = Update.foldChild({
  foldOutMessage: SignInOutMessage.match<Step>({
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededSignIn: ({ user }) => enterAfterSignIn(user),
  }),
  read: (model: Model) =>
    Match.value(model).pipe(
      Match.tag("SignedOut", ({ signIn }) => Option.some(signIn)),
      Match.orElse(() => Option.none())
    ),
  toParentMessage: (message) => Message.GotSignInMessage({ message }),
  update: updateSignIn,
  write: (model, nextSignIn) =>
    Match.value(model).pipe(
      Match.tag("SignedOut", (signedOutModel): Model =>
        modifyFields(signedOutModel, { signIn: () => nextSignIn })
      ),
      Match.orElse((): Model => model)
    ),
});

/**
 * The app's update.
 *
 * @param model - The state.
 * @param message - What happened.
 * @returns The next state and its Commands.
 */
export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ChangedUrl: ({ url }) => changeRoute(model, urlToAppRoute(url)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedLink: ({ request }) =>
      Match.value(request).pipe(
        withUpdateReturn,
        Match.tag("Internal", ({ url }) => ({
          commands: [NavigateInternal({ url: urlToString(url) })],
          model,
        })),
        Match.tag("External", ({ href }) => ({
          commands: [LoadExternal({ href })],
          model,
        })),
        Match.exhaustive
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedRetry: () =>
      Match.value(model).pipe(
        withUpdateReturn,
        Match.tag("SessionUnavailable", ({ route }) => ({
          commands: [LoadCurrentUser()],
          model: Model.CheckingSession({ route }),
        })),
        Match.orElse(() => ({ model }))
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedSignOut: () =>
      inSignedIn(model, (signedInModel) =>
        SignOutRequest.guards.Pending(signedInModel.signOut)
          ? { model }
          : {
              commands: [SignOut()],
              model: modifyFields(signedInModel, {
                signOut: () => SignOutRequest.Pending(),
              }),
            }
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedLoadExternal: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedNavigateInternal: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedReplaceUrl: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadCurrentUser: ({ error }) =>
      inCheckingSession(model, (route) => settleWithoutUser(route, error)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSignOut: () =>
      inSignedIn(model, (signedInModel) => ({
        model: modifyFields(signedInModel, {
          signOut: () => SignOutRequest.Failed(),
        }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotSignInMessage: ({ message: signInMessage }) =>
      foldSignIn(model, signInMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadCurrentUser: ({ user }) =>
      inCheckingSession(model, (route) => landSignedIn(route, signedIn(user))),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededSignOut: () =>
      inSignedIn(model, () => ({
        commands: [ReplaceUrl({ url: signInRouter() })],
        model: signedOut(AppRoute.SignIn(), Option.none()),
      })),
  });
