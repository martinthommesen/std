import { Menu } from "@foldkit/ui";
import { CurrentSession } from "@std/api/session";
import { TableMetadataSummary } from "@std/api/table-metadata";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import { SchemaRevision } from "./domain/schema-revision.ts";
import { Model as DeadLettersModel } from "./page/dead-letters/model.ts";
import { Model as RecordFormModel } from "./page/record-form/model.ts";
import { Model as SignInModel } from "./page/sign-in/sign-in.ts";
import { Model as TableListModel } from "./page/table-list/model.ts";
import { AppRoute, SignedInRoute, SignedOutRoute } from "./route.ts";
import { ShellPreferences } from "./shell-preferences.ts";

/** Where a sign-out request stands. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SignOutRequest = defineTaggedUnion({
  Failed: {},
  Idle: {},
  Pending: {},
});

/** Where a sign-out request stands. */
export type SignOutRequest = typeof SignOutRequest.Type;

/**
 * The tables the user can open (`GET tableMetadata`), with the revision the
 * response stated: the navigation and the home page list them.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const TableCatalog = Schema.Struct({
  revision: SchemaRevision,
  tables: Schema.Array(TableMetadataSummary),
});

/** The tables the user can open. */
export type TableCatalog = typeof TableCatalog.Type;

/** The tables the user can open, as they load and refresh. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Tables = AsyncData.Schema(
  TableCatalog,
  Schema.Literal("Unavailable")
);

/** The tables the user can open, as they load and refresh. */
export type Tables = typeof Tables.schema.Type;

/**
 * The app: whether there is a session, and the page.
 *
 * - `CheckingSession`: at start-up, while `session/current` says whether the
 *   browser holds a session cookie (scripts cannot read it).
 * - `SessionUnavailable`: the server could not be asked; the user can
 *   retry.
 * - `SignedOut`: the sign-in page or a not-found page. A signed-in page
 *   asked for while signed out is kept as `maybeReturnRoute`, to go to
 *   after sign-in.
 * - `SignedIn`: the user, the page and any sign-out in progress; the
 *   tables the user can open; the latest schema revision a response
 *   stated (Contracts 6.2), seeded from `session/current` or sign-in; the list
 *   page's state on a list route, the form page's on a record's or the
 *   new-record route, and the number the next page gets. `sessionId`
 *   numbers the session within the app's run: every root request carries
 *   it and its answer counts only in the session that sent it, so a late
 *   answer meant for an earlier session (another user's tables, a
 *   sign-out or an ended session) changes nothing. The session token is
 *   never here: it lives in the HTTP-only cookie.
 * - `SignedOut` carries both counters (`nextPageId`, `nextSessionId`), so
 *   the next session's pages and requests get numbers no earlier one had.
 * - Every state carries the shell's `preferences`, read from the browser at
 *   start-up, so a session that starts later still opens the navigation as
 *   the user left it. Signed in, the shell also holds whether the
 *   navigation drawer is open on a narrow screen (`isNavigationOpen`), the
 *   user menu (Foldkit UI Menu) and whether the browser refused to store
 *   the preferences (`isPreferenceSaveFailed`).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Model = defineTaggedUnion({
  CheckingSession: { preferences: ShellPreferences, route: AppRoute },
  SessionUnavailable: { preferences: ShellPreferences, route: AppRoute },
  SignedIn: {
    isNavigationOpen: Schema.Boolean,
    isPreferenceSaveFailed: Schema.Boolean,
    maybeDeadLetters: Schema.Option(DeadLettersModel),
    maybeRecordForm: Schema.Option(RecordFormModel),
    maybeRevision: Schema.Option(SchemaRevision),
    maybeTableList: Schema.Option(TableListModel),
    nextPageId: Schema.Int,
    preferences: ShellPreferences,
    route: SignedInRoute,
    sessionId: Schema.Int,
    signOutRequest: SignOutRequest,
    tables: Tables.schema,
    user: CurrentSession,
    userMenu: Menu.Model,
  },
  SignedOut: {
    maybeReturnRoute: Schema.Option(SignedInRoute),
    nextPageId: Schema.Int,
    nextSessionId: Schema.Int,
    preferences: ShellPreferences,
    route: SignedOutRoute,
    signIn: SignInModel,
  },
});

/** The app's state. */
export type Model = typeof Model.Type;

/** The signed-in state. */
export type SignedInModel = typeof Model.SignedIn.Type;

/** The start-up state, while the server is asked for the session. */
export type CheckingSessionModel = typeof Model.CheckingSession.Type;

/** The signed-out state. */
export type SignedOutModel = typeof Model.SignedOut.Type;

/** Who the session acts as (`GET session/current`): never a token. */
export type CurrentUser = typeof CurrentSession.Type;
