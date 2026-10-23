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
import type {
  CurrentUser,
  Tables as TablesState,
  SignedInModel,
  SignedOutModel,
} from "./model.ts";
import { Model, SignOutRequest, Tables } from "./model.ts";
import { OutMessage as DeadLettersOutMessage } from "./page/dead-letters/message.ts";
import type { Message as DeadLettersMessage } from "./page/dead-letters/message.ts";
import type { Model as DeadLettersModel } from "./page/dead-letters/model.ts";
import {
  init as deadLettersInit,
  update as deadLettersUpdate,
} from "./page/dead-letters/update.ts";
import { OutMessage as RecordFormOutMessage } from "./page/record-form/message.ts";
import type { Message as RecordFormMessage } from "./page/record-form/message.ts";
import { FormMode } from "./page/record-form/model.ts";
import type { Model as RecordFormModel } from "./page/record-form/model.ts";
import {
  init as recordFormInit,
  update as recordFormUpdate,
} from "./page/record-form/update.ts";
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
    Match.tag(
      "Home",
      "DeadLetters",
      "NewRecord",
      "Record",
      "TableList",
      (signedInRoute) => ({
        commands: [ReplaceUrl({ url: signInRouter() })],
        model: toModel(AppRoute.SignIn(), Option.some(signedInRoute)),
      })
    ),
    Match.orElse((signedOutRoute) => ({
      model: toModel(signedOutRoute, Option.none()),
    }))
  );

/** The first page number of the app's run. */
const FIRST_PAGE_ID = 1;

/** The first session number of the app's run. */
const FIRST_SESSION_ID = 1;

/** The numbers the next session goes on from. */
interface Counters {
  readonly nextPageId: number;
  readonly nextSessionId: number;
}

const FIRST_COUNTERS: Counters = {
  nextPageId: FIRST_PAGE_ID,
  nextSessionId: FIRST_SESSION_ID,
};

// NOTE: page and session numbers go on across sign-out and sign-in (both
// counters are carried through the signed-out state), so an answer to a
// page or a root request of an earlier session never reaches the next one.
const initSignedOut = (
  route: SignedOutRoute,
  maybeReturnRoute: Option.Option<SignedInRoute>,
  counters: Counters = FIRST_COUNTERS
): Model =>
  Model.SignedOut({
    maybeReturnRoute,
    nextPageId: counters.nextPageId,
    nextSessionId: counters.nextSessionId,
    route,
    signIn: signInInit(),
  });

const initSignedIn =
  (
    user: CurrentUser,
    maybeRevision: Option.Option<SchemaRevision>,
    counters: Counters = FIRST_COUNTERS
  ) =>
  (route: SignedInRoute): Model =>
    Model.SignedIn({
      maybeDeadLetters: Option.none(),
      maybeRecordForm: Option.none(),
      maybeRevision,
      maybeTableList: Option.none(),
      nextPageId: counters.nextPageId,
      route,
      sessionId: counters.nextSessionId,
      signOutRequest: SignOutRequest.Idle(),
      tables: Tables.Idle(),
      user,
    });

/**
 * The counters a session leaves to the next one: its page counter, and
 * the session number after its own.
 *
 * @param signedInModel - The session that ends.
 * @returns The counters for the signed-out state.
 */
const countersAfter = (signedInModel: SignedInModel): Counters => ({
  nextPageId: signedInModel.nextPageId,
  nextSessionId: signedInModel.sessionId + 1,
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

/**
 * The open list page, if it is the one with this number: an answer to a
 * Command of a page the user has left reaches no page.
 *
 * @param pageId - The page's number.
 * @returns The reader.
 */
const readTableListPage =
  (pageId: number) =>
  (model: Model): Option.Option<TableListModel> =>
    Option.filter(readTableList(model), (page) => page.id === pageId);

const writeTableList = (model: Model, nextTableList: TableListModel): Model =>
  Model.guards.SignedIn(model)
    ? modifyFields(model, { maybeTableList: () => Option.some(nextTableList) })
    : model;

const withTableList =
  (model: Model) =>
  (page: TableListModel): Model =>
    writeTableList(model, page);

const toGotTableListMessage =
  (pageId: number) =>
  (message: TableListMessage): Message =>
    Message.GotTableListMessage({ message, pageId });

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
 * Reloads the table list at the app's revision, keeping it on screen.
 *
 * @param model - The state.
 * @returns It, reloading.
 */
const reloadTableList: Step = (model) =>
  Model.guards.SignedIn(model) && !AsyncData.isPending(model.tables)
    ? {
        commands: [
          LoadTables({
            maybeRevision: model.maybeRevision,
            sessionId: model.sessionId,
          }),
        ],
        model: modifyFields(model, { tables: reloadTables }),
      }
    : { model };

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

    return isCatalogStale ? reloadTableList(noted) : { model: noted };
  };

/**
 * Takes the database's current revision from a `SchemaChanged` refusal,
 * even when it is lower than the app's (the database was restored), and
 * reloads the table list when the list was loaded at another one.
 *
 * @param revision - The current revision the refusal stated.
 * @returns The step.
 */
const replaceRevision =
  (revision: SchemaRevision): Step =>
  (model) => {
    if (!Model.guards.SignedIn(model)) {
      return { model };
    }

    const replaced = modifyFields(model, {
      maybeRevision: () => Option.some(revision),
    });

    const isCatalogOther = Option.match(AsyncData.getData(model.tables), {
      onNone: () => false,
      onSome: (catalog) => catalog.revision !== revision,
    });

    return isCatalogOther ? reloadTableList(replaced) : { model: replaced };
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
        model: initSignedOut(
          AppRoute.SignIn(),
          Option.some(model.route),
          countersAfter(model)
        ),
      })
    : { model };

const foldTableListOutMessage = TableListOutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SawCurrentRevision: ({ revision }) => replaceRevision(revision),
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SawRevision: ({ revision }) => noteRevision(revision),
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SessionEnded: () => endSession,
});

const foldTableList = (pageId: number) =>
  Update.foldChild({
    foldOutMessage: foldTableListOutMessage,
    read: readTableListPage(pageId),
    toParentMessage: toGotTableListMessage(pageId),
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
                id: model.nextPageId,
                maybeAppRevision: model.maybeRevision,
                table: route.table,
              }),
              {
                foldOutMessage: foldTableListOutMessage,
                toParentMessage: toGotTableListMessage(model.nextPageId),
                toParentModel: withTableList(
                  modifyFields(model, { nextPageId: (next) => next + 1 })
                ),
              }
            ),
          onSome: (page) =>
            Update.foldChildStep({
              foldOutMessage: foldTableListOutMessage,
              read: readTableListPage(page.id),
              toParentMessage: toGotTableListMessage(page.id),
              update: (openPage: TableListModel) =>
                followAddress(openPage, address),
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

// THE DEAD-LETTER PAGE
const readDeadLetters = (model: Model): Option.Option<DeadLettersModel> =>
  Model.guards.SignedIn(model) ? model.maybeDeadLetters : Option.none();

const writeDeadLetters = (
  model: Model,
  nextDeadLetters: DeadLettersModel
): Model =>
  Model.guards.SignedIn(model)
    ? modifyFields(model, {
        maybeDeadLetters: () => Option.some(nextDeadLetters),
      })
    : model;

const toGotDeadLettersMessage =
  (pageId: number) =>
  (message: DeadLettersMessage): Message =>
    Message.GotDeadLettersMessage({ message, pageId });

const foldDeadLettersOutMessage = DeadLettersOutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- keyed by the child's OutMessage tag
  SessionEnded: () => endSession,
});

const foldDeadLetters = (pageId: number) =>
  Update.foldChild({
    foldOutMessage: foldDeadLettersOutMessage,
    read: (model: Model) =>
      Option.filter(readDeadLetters(model), (page) => page.id === pageId),
    toParentMessage: toGotDeadLettersMessage(pageId),
    update: deadLettersUpdate,
    write: writeDeadLetters,
  });

const syncDeadLetters: Step = (model) => {
  if (!Model.guards.SignedIn(model)) {
    return { model };
  }

  if (model.route._tag !== "DeadLetters") {
    return {
      model: modifyFields(model, { maybeDeadLetters: () => Option.none() }),
    };
  }

  if (Option.isSome(model.maybeDeadLetters)) {
    return { model };
  }

  return Update.foldChildInit(deadLettersInit(model.nextPageId), {
    foldOutMessage: foldDeadLettersOutMessage,
    toParentMessage: toGotDeadLettersMessage(model.nextPageId),
    toParentModel: (page: DeadLettersModel) =>
      writeDeadLetters(
        modifyFields(model, { nextPageId: (next) => next + 1 }),
        page
      ),
  });
};

// THE FORM PAGE

/**
 * The open form page, if it is the one with this number: an answer to a
 * Command of a page the user has left reaches no page.
 *
 * @param pageId - The page's number.
 * @returns The reader.
 */
const readRecordFormPage =
  (pageId: number) =>
  (model: Model): Option.Option<RecordFormModel> =>
    Model.guards.SignedIn(model)
      ? pipe(
          model.maybeRecordForm,
          Option.filter((page) => page.id === pageId)
        )
      : Option.none();

const writeRecordForm = (model: Model, nextForm: RecordFormModel): Model =>
  Model.guards.SignedIn(model)
    ? modifyFields(model, { maybeRecordForm: () => Option.some(nextForm) })
    : model;

const toGotRecordFormMessage =
  (pageId: number) =>
  (message: RecordFormMessage): Message =>
    Message.GotRecordFormMessage({ message, pageId });

const foldRecordFormOutMessage = RecordFormOutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SawCurrentRevision: ({ revision }) => replaceRevision(revision),
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SawRevision: ({ revision }) => noteRevision(revision),
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  SessionEnded: () => endSession,
});

const foldRecordForm = (pageId: number) =>
  Update.foldChild({
    foldOutMessage: foldRecordFormOutMessage,
    read: readRecordFormPage(pageId),
    toParentMessage: toGotRecordFormMessage(pageId),
    update: recordFormUpdate,
    write: writeRecordForm,
  });

/** The form a route asks for: its table and mode. */
interface FormSpec {
  readonly table: string;
  readonly mode: FormMode;
}

const formSpecOf = (route: SignedInRoute): Option.Option<FormSpec> =>
  Match.value(route).pipe(
    Match.tag("Record", ({ id, table }) =>
      Option.some({ mode: FormMode.Edit({ recordId: id }), table })
    ),
    Match.tag("NewRecord", ({ table }) =>
      Option.some({ mode: FormMode.Create(), table })
    ),
    Match.orElse(() => Option.none<FormSpec>())
  );

const isSameForm = (page: RecordFormModel, spec: FormSpec): boolean =>
  page.table === spec.table &&
  (FormMode.guards.Create(page.mode)
    ? FormMode.guards.Create(spec.mode)
    : FormMode.guards.Edit(spec.mode) &&
      spec.mode.recordId === page.mode.recordId);

/**
 * Brings the form page in line with the route: a record's route or the
 * new-record route opens its form (a new page for another record, table
 * or mode); any other route closes it.
 *
 * @param model - The state after a route change.
 * @returns The state and the page's Commands.
 */
const syncRecordForm: Step = (model) => {
  if (!Model.guards.SignedIn(model)) {
    return { model };
  }

  return Option.match(formSpecOf(model.route), {
    onNone: () => ({
      model: modifyFields(model, { maybeRecordForm: () => Option.none() }),
    }),
    onSome: (spec) =>
      Option.exists(model.maybeRecordForm, (page) => isSameForm(page, spec))
        ? { model }
        : Update.foldChildInit(
            recordFormInit({
              id: model.nextPageId,
              maybeAppRevision: model.maybeRevision,
              mode: spec.mode,
              table: spec.table,
            }),
            {
              foldOutMessage: foldRecordFormOutMessage,
              toParentMessage: toGotRecordFormMessage(model.nextPageId),
              toParentModel: (page: RecordFormModel) =>
                writeRecordForm(
                  modifyFields(model, { nextPageId: (next) => next + 1 }),
                  page
                ),
            }
          ),
  });
};

/**
 * What a newly signed-in state starts: loading the tables the user can
 * open, and the list or form page when the route is one.
 *
 * @param model - The signed-in state.
 * @returns It, with those Commands.
 */
const enterSignedIn: Step = (model) =>
  Update.combine(model, [
    reloadTableList,
    syncTableList,
    syncRecordForm,
    syncDeadLetters,
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
 * What a route shows besides its kind of page: the table, and the record.
 *
 * @param route - The route.
 * @returns Such as `acme.asset/<id>`.
 */
const pageKeyOf = (route: AppRoute): Option.Option<string> =>
  Match.value(route).pipe(
    Match.tag("TableList", "NewRecord", ({ table }) => Option.some(table)),
    Match.tag("Record", ({ id, table }) => Option.some(`${table}/${id}`)),
    Match.orElse(() => Option.none())
  );

/**
 * Applies a new address, and moves focus when another page appears.
 *
 * @param model - The state.
 * @param route - The new address's route.
 * @returns The next state, any redirect, and the focus move.
 */
const changeRoute = (model: Model, route: AppRoute): UpdateReturn => {
  const landed = Update.combine(model, [
    (stepModel) => landOnRoute(stepModel, route),
    syncTableList,
    syncRecordForm,
    syncDeadLetters,
  ]);

  const showsAnotherPage =
    (Model.guards.SignedIn(landed.model) ||
      Model.guards.SignedOut(landed.model)) &&
    (landed.model.route._tag !== model.route._tag ||
      !Option.makeEquivalence((a: string, b: string) => a === b)(
        pageKeyOf(landed.model.route),
        pageKeyOf(model.route)
      ));

  return showsAnotherPage ? focusingMain(landed) : landed;
};

/**
 * Settles start-up with `session/current`'s answer: signed in or signed out.
 *
 * @param route - The route the app started on.
 * @param maybeUser - The session's user, if there is a session.
 * @param maybeRevision - The revision `session/current`'s answer stated.
 * @returns The state and any redirect.
 */
const settleSession = (
  route: AppRoute,
  maybeUser: Option.Option<CurrentUser>,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn =>
  Option.match(maybeUser, {
    onNone: () => landSignedOut(route, initSignedOut),
    onSome: (user) =>
      Update.combine(initSignedIn(user, maybeRevision)(AppRoute.Home()), [
        () => landSignedIn(route, initSignedIn(user, maybeRevision)),
        enterSignedIn,
      ]),
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
 * Runs an update only in the signed-in session with this number; in any
 * other state or session the Message answers a request of an earlier one
 * and changes nothing.
 *
 * @param model - The state.
 * @param sessionId - The number of the session that sent the request.
 * @param whenInSession - The update for that session.
 * @returns Its result, or the unchanged state.
 */
const inSession = (
  model: Model,
  sessionId: number,
  whenInSession: (signedInModel: SignedInModel) => UpdateReturn
): UpdateReturn =>
  Model.guards.SignedIn(model) && model.sessionId === sessionId
    ? whenInSession(model)
    : { model };

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
 * @param maybeRevision - The revision the sign-in's answer stated.
 * @returns The step from the signed-out state.
 */
const enterAfterSignIn =
  (user: CurrentUser, maybeRevision: Option.Option<SchemaRevision>): Step =>
  (model) => {
    if (!Model.guards.SignedOut(model)) {
      return { model };
    }

    const route = Option.getOrElse(model.maybeReturnRoute, (): SignedInRoute =>
      AppRoute.Home()
    );

    return focusingMain(
      Update.combine(initSignedIn(user, maybeRevision, model)(route), [
        (stepModel) => ({
          commands: [ReplaceUrl({ url: signedInRouteToUrl(route) })],
          model: stepModel,
        }),
        enterSignedIn,
      ])
    );
  };

const foldSignInOutMessage = SignInOutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
  SucceededSignIn: ({ maybeRevision, user }) =>
    enterAfterSignIn(user, maybeRevision),
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
                SignOut({
                  maybeRevision: signedInModel.maybeRevision,
                  sessionId: signedInModel.sessionId,
                }),
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
    FailedAuthentication: ({ sessionId }) =>
      inSession(model, sessionId, endSession),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadCurrentUser: () =>
      inCheckingSession(model, (route) => ({
        model: Model.SessionUnavailable({ route }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadTables: ({ sessionId }) =>
      inSession(model, sessionId, (signedInModel) => ({
        model: modifyFields(signedInModel, { tables: failTables }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSignOut: ({ sessionId }) =>
      inSession(model, sessionId, (signedInModel) => ({
        model: modifyFields(signedInModel, {
          signOutRequest: () => SignOutRequest.Failed(),
        }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotDeadLettersMessage: ({ message: deadLettersMessage, pageId }) =>
      foldDeadLetters(pageId)(model, deadLettersMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotRecordFormMessage: ({ message: recordFormMessage, pageId }) =>
      foldRecordForm(pageId)(model, recordFormMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotSignInMessage: ({ message: signInMessage }) =>
      foldSignIn(model, signInMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotTableListMessage: ({ message: tableListMessage, pageId }) =>
      foldTableList(pageId)(model, tableListMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadCurrentUser: ({ maybeRevision, maybeUser }) =>
      inCheckingSession(model, (route) =>
        settleSession(route, maybeUser, maybeRevision)
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTables: ({ revision, sessionId, tables }) =>
      inSession(model, sessionId, (signedInModel) => ({
        model: modifyFields(signedInModel, {
          maybeRevision: (maybeRevision) =>
            Option.some(latestRevision(maybeRevision, revision)),
          tables: () => Tables.Success({ data: { revision, tables } }),
        }),
      })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededSignOut: ({ sessionId }) =>
      inSession(model, sessionId, (signedIn) =>
        focusingMain({
          commands: [ReplaceUrl({ url: signInRouter() })],
          model: initSignedOut(
            AppRoute.SignIn(),
            Option.none(),
            countersAfter(signedIn)
          ),
        })
      ),
  });
