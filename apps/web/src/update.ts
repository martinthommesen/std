import type { CurrentUser } from "@std/api/session";
import { Match, Option, pipe } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";

import {
  FocusMain,
  LoadCurrentUser,
  LoadExternal,
  LoadTables,
  NavigateInternal,
  ReplaceUrl,
  SignOut,
} from "./command.ts";
import { isNewerRevision, latestRevision } from "./domain/schema-revision.ts";
import type { SchemaRevision } from "./domain/schema-revision.ts";
import { Message } from "./message.ts";
import { Model, SignOutRequest, Tables } from "./model.ts";
import type {
  Tables as TablesState,
  SignedInModel,
  SignedOutModel,
} from "./model.ts";
import {
  OutMessage as SignInOutMessage,
  forgetPassword,
  init as signInInit,
  update as signInUpdate,
} from "./page/sign-in/sign-in.ts";
import { OutMessage as TableListOutMessage } from "./page/table-list/message.ts";
import type { Message as TableListMessage } from "./page/table-list/message.ts";
import type { Model as TableListModel } from "./page/table-list/model.ts";
import {
  followAddress,
  init as tableListInit,
  update as tableListUpdate,
} from "./page/table-list/update.ts";
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
    Match.tag("Home", "Record", "TableList", (signedInRoute) => ({
      commands: [ReplaceUrl({ url: signInRouter() })],
      model: toModel(AppRoute.SignIn(), Option.some(signedInRoute)),
    })),
    Match.orElse((signedOutRoute) => ({
      model: toModel(signedOutRoute, Option.none()),
    }))
  );

const initSignedOut = (
  route: SignedOutRoute,
  maybeReturnRoute: Option.Option<SignedInRoute>
): Model => Model.SignedOut({ maybeReturnRoute, route, signIn: signInInit() });

const initSignedIn =
  (user: CurrentUser) =>
  (route: SignedInRoute): Model =>
    Model.SignedIn({
      maybeRevision: Option.none(),
      maybeTableList: Option.none(),
      route,
      signOutRequest: SignOutRequest.Idle(),
      tables: Tables.Loading(),
      user,
    });

/**
 * Adds the move of focus to the new page's `main` to a result.
 *
 * @param result - A result that shows another page.
 * @returns It, with `FocusMain`.
 */
const focusingMain = (result: UpdateReturn): UpdateReturn => ({
  commands: [...(result.commands ?? []), FocusMain()],
  model: result.model,
});

// THE LIST PAGE

const readTableList = (model: Model): Option.Option<TableListModel> =>
  Model.guards.SignedIn(model) ? model.maybeTableList : Option.none();

const writeTableList = (model: Model, nextTableList: TableListModel): Model =>
  Model.guards.SignedIn(model)
    ? modifyFields(model, { maybeTableList: () => Option.some(nextTableList) })
    : model;

const withTableList =
  (model: Model) =>
  (page: TableListModel): Model =>
    writeTableList(model, page);

const toGotTableListMessage = (message: TableListMessage): Message =>
  Message.GotTableListMessage({ message });

/**
 * The table list after a failed load: the last list stays, marked stale.
 *
 * @param tables - The table list.
 * @returns It, failed.
 */
const failTables = (tables: TablesState): TablesState =>
  Option.match(AsyncData.getData(tables), {
    onNone: () => Tables.Failure({ error: "Unavailable" }),
    onSome: (data) => Tables.Stale({ data, error: "Unavailable" }),
  });

/**
 * The table list while it reloads: the last list stays on screen.
 *
 * @param tables - The table list.
 * @returns It, refreshing.
 */
const reloadTables = (tables: TablesState): TablesState =>
  Option.match(AsyncData.getData(tables), {
    onNone: () => Tables.Loading(),
    onSome: (data) => Tables.Refreshing({ data }),
  });

/**
 * Keeps the latest revision a response stated, and reloads the table list
 * when it is newer than the one the list was loaded at (Contracts 6.4: a
 * newer revision triggers a background metadata refresh).
 *
 * @param revision - The revision a response stated.
 * @returns The step.
 */
const noteRevision =
  (revision: SchemaRevision): Step =>
  (model) => {
    if (!Model.guards.SignedIn(model)) {
      return { model };
    }

    const isCatalogStale = Option.match(AsyncData.getData(model.tables), {
      onNone: () => false,
      onSome: (catalog) => isNewerRevision(revision, catalog.revision),
    });

    const noted = modifyFields(model, {
      maybeRevision: (maybeRevision) =>
        Option.some(latestRevision(maybeRevision, revision)),
    });

    return isCatalogStale && !AsyncData.isPending(model.tables)
      ? {
          commands: [LoadTables({ maybeRevision: Option.some(revision) })],
          model: modifyFields(noted, { tables: reloadTables }),
        }
      : { model: noted };
  };

/**
 * Leaves for the sign-in page when the server no longer accepts the
 * session (it expired or was ended elsewhere), keeping the page to return
 * to after sign-in.
 *
 * @param model - The state.
 * @returns The signed-out state and the redirect.
 */
const endSession: Step = (model) =>
  Model.guards.SignedIn(model)
    ? focusingMain({
        commands: [ReplaceUrl({ url: signInRouter() })],
        model: initSignedOut(AppRoute.SignIn(), Option.some(model.route)),
      })
    : { model };

const foldTableListOutMessage = TableListOutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SawRevision: ({ revision }) => noteRevision(revision),
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SessionEnded: () => endSession,
});

const foldTableList = Update.foldChild({
  foldOutMessage: foldTableListOutMessage,
  read: readTableList,
  toParentMessage: toGotTableListMessage,
  update: tableListUpdate,
  write: writeTableList,
});

/**
 * Brings the list page in line with the route: a list route opens the
 * table's page, or makes the open page follow a changed address; any
 * other route closes it.
 *
 * @param model - The state after a route change.
 * @returns The state and the page's Commands.
 */
const syncTableList: Step = (model) => {
  if (!Model.guards.SignedIn(model)) {
    return { model };
  }

  return Match.value(model.route).pipe(
    withUpdateReturn,
    Match.tag("TableList", (route) => {
      const address = {
        filter: route.filter,
        limit: route.limit,
        sort: route.sort,
      };

      return Option.match(
        pipe(
          model.maybeTableList,
          Option.filter((page) => page.table === route.table)
        ),
        {
          onNone: () =>
            Update.foldChildInit(
              tableListInit({
                address,
                maybeAppRevision: model.maybeRevision,
                table: route.table,
              }),
              {
                foldOutMessage: foldTableListOutMessage,
                toParentMessage: toGotTableListMessage,
                toParentModel: withTableList(model),
              }
            ),
          onSome: () =>
            Update.foldChildStep({
              foldOutMessage: foldTableListOutMessage,
              read: readTableList,
              toParentMessage: toGotTableListMessage,
              update: (page: TableListModel) => followAddress(page, address),
              write: writeTableList,
            })(model),
        }
      );
    }),
    Match.orElse(() => ({
      model: modifyFields(model, { maybeTableList: () => Option.none() }),
    }))
  );
};

/**
 * What a newly signed-in state starts: loading the tables the user can
 * open, and the list page when the route is one.
 *
 * @param model - The signed-in state.
 * @returns It, with those Commands.
 */
const enterSignedIn: Step = (model) =>
  Update.combine(model, [
    (stepModel) => ({
      commands: [LoadTables({ maybeRevision: Option.none() })],
      model: stepModel,
    }),
    syncTableList,
  ]);

/**
 * Moves the signed-out state to another page. The redirect to sign-in
 * comes back as a `ChangedUrl` of its own, so a page to return to is never
 * forgotten here.
 *
 * NOTE: the password input is uncontrolled; leaving or entering the
 * sign-in page remounts it empty, so the Model forgets the password too.
 *
 * @param signedOutModel - The state.
 * @returns The state on the page landed on.
 */
const moveSignedOut =
  (signedOutModel: SignedOutModel) =>
  (
    nextRoute: SignedOutRoute,
    maybeReturnRoute: Option.Option<SignedInRoute>
  ): Model => {
    const isSamePage = nextRoute._tag === signedOutModel.route._tag;

    return modifyFields(signedOutModel, {
      maybeReturnRoute: (current) =>
        Option.isSome(maybeReturnRoute) ? maybeReturnRoute : current,
      route: () => nextRoute,
      signIn: isSamePage ? (form) => form : forgetPassword,
    });
  };

/**
 * Applies a new address to the signed-in or signed-out state. The
 * redirects this app makes come back as a `ChangedUrl` of their own, so
 * landing on the same page again changes nothing.
 *
 * @param model - The state.
 * @param route - The new address's route.
 * @returns The next state and any redirect.
 */
const landOnRoute = (model: Model, route: AppRoute): UpdateReturn =>
  Match.value(model).pipe(
    withUpdateReturn,
    Match.tag("SignedIn", (signedInModel) =>
      landSignedIn(route, (nextRoute) =>
        modifyFields(signedInModel, { route: () => nextRoute })
      )
    ),
    Match.tag("SignedOut", (signedOutModel) =>
      landSignedOut(route, moveSignedOut(signedOutModel))
    ),
    Match.tag("CheckingSession", "SessionUnavailable", (waiting) => ({
      model: modifyFields(waiting, { route: () => route }),
    })),
    Match.exhaustive
  );

/**
 * Applies a new address, and moves focus when another page appears.
 *
 * @param model - The state.
 * @param route - The new address's route.
 * @returns The next state, any redirect, and the focus move.
 */
const changeRoute = (model: Model, route: AppRoute): UpdateReturn => {
  const routed = landOnRoute(model, route);
  const synced = syncTableList(routed.model);

  const landed = {
    commands: [...(routed.commands ?? []), ...(synced.commands ?? [])],
    model: synced.model,
  };

  const showsAnotherPage =
    (Model.guards.SignedIn(landed.model) ||
      Model.guards.SignedOut(landed.model)) &&
    landed.model.route._tag !== model.route._tag;

  return showsAnotherPage ? focusingMain(landed) : landed;
};

/**
 * Settles start-up with `auth/me`'s answer: signed in or signed out.
 *
 * @param route - The route the app started on.
 * @param maybeUser - The session's user, if there is a session.
 * @returns The state and any redirect.
 */
const settleSession = (
  route: AppRoute,
  maybeUser: Option.Option<CurrentUser>
): UpdateReturn =>
  Option.match(maybeUser, {
    onNone: () => landSignedOut(route, initSignedOut),
    onSome: (user) => {
      const landed = landSignedIn(route, initSignedIn(user));
      const entered = enterSignedIn(landed.model);

      return {
        commands: [...(landed.commands ?? []), ...(entered.commands ?? [])],
        model: entered.model,
      };
    },
  });

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
  Model.guards.SignedIn(model) ? whenSignedIn(model) : { model };

/**
 * Runs an update only while start-up asks for the session; a late answer
 * changes nothing.
 *
 * @param model - The state.
 * @param whenCheckingSession - The update for that state, given its route.
 * @returns Its result, or the unchanged state.
 */
const inCheckingSession = (
  model: Model,
  whenCheckingSession: (route: AppRoute) => UpdateReturn
): UpdateReturn =>
  Model.guards.CheckingSession(model)
    ? whenCheckingSession(model.route)
    : { model };

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
    if (!Model.guards.SignedOut(model)) {
      return { model };
    }

    const route = Option.getOrElse(model.maybeReturnRoute, (): SignedInRoute =>
      AppRoute.Home()
    );

    const entered = enterSignedIn(initSignedIn(user)(route));

    return focusingMain({
      commands: [
        ReplaceUrl({ url: signedInRouteToUrl(route) }),
        ...(entered.commands ?? []),
      ],
      model: entered.model,
    });
  };

const foldSignInOutMessage = SignInOutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
  SucceededSignIn: ({ user }) => enterAfterSignIn(user),
});

const foldSignIn = Update.foldChild({
  foldOutMessage: foldSignInOutMessage,
  read: (model: Model) =>
    Model.guards.SignedOut(model) ? Option.some(model.signIn) : Option.none(),
  toParentMessage: (message) => Message.GotSignInMessage({ message }),
  update: signInUpdate,
  write: (model, nextSignIn): Model =>
    Model.guards.SignedOut(model)
      ? modifyFields(model, { signIn: () => nextSignIn })
      : model,
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
    ClickedRetrySessionCheck: () =>
      Model.guards.SessionUnavailable(model)
        ? {
            commands: [LoadCurrentUser()],
            model: Model.CheckingSession({ route: model.route }),
          }
        : { model },
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedSignOut: () =>
      inSignedIn(model, (signedInModel) =>
        SignOutRequest.guards.Pending(signedInModel.signOutRequest)
          ? { model }
          : {
              commands: [
                SignOut({ maybeRevision: signedInModel.maybeRevision }),
              ],
              model: modifyFields(signedInModel, {
                signOutRequest: () => SignOutRequest.Pending(),
              }),
            }
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedFocusMain: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedLoadExternal: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedNavigateInternal: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedReplaceUrl: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedAuthentication: () => endSession(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadCurrentUser: () =>
      inCheckingSession(model, (route) => ({
        model: Model.SessionUnavailable({ route }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadTables: () =>
      inSignedIn(model, (signedInModel) => ({
        model: modifyFields(signedInModel, { tables: failTables }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSignOut: () =>
      inSignedIn(model, (signedInModel) => ({
        model: modifyFields(signedInModel, {
          signOutRequest: () => SignOutRequest.Failed(),
        }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotSignInMessage: ({ message: signInMessage }) =>
      foldSignIn(model, signInMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotTableListMessage: ({ message: tableListMessage }) =>
      foldTableList(model, tableListMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadCurrentUser: ({ maybeUser }) =>
      inCheckingSession(model, (route) => settleSession(route, maybeUser)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTables: ({ revision, tables }) =>
      inSignedIn(model, (signedInModel) => ({
        model: modifyFields(signedInModel, {
          maybeRevision: (maybeRevision) =>
            Option.some(latestRevision(maybeRevision, revision)),
          tables: () => Tables.Success({ data: { revision, tables } }),
        }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededSignOut: () =>
      inSignedIn(model, () =>
        focusingMain({
          commands: [ReplaceUrl({ url: signInRouter() })],
          model: initSignedOut(AppRoute.SignIn(), Option.none()),
        })
      ),
  });
