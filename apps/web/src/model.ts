import { CurrentUserSchema } from "@std/api/session";
import { MetaTableSummarySchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import { SchemaRevision } from "./domain/schema-revision.ts";
import { Model as SignInModel } from "./page/sign-in/sign-in.ts";
import { Model as TableListModel } from "./page/table-list/model.ts";
import { AppRoute, SignedInRoute, SignedOutRoute } from "./route.ts";

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
 * The tables the user can open (`GET meta/tables`), with the revision the
 * response stated: the navigation and the home page list them.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const TableCatalog = Schema.Struct({
  revision: SchemaRevision,
  tables: Schema.Array(MetaTableSummarySchema),
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
 * - `CheckingSession`: at start-up, while `auth/me` says whether the
 *   browser holds a session cookie (scripts cannot read it).
 * - `SessionUnavailable`: the server could not be asked; the user can
 *   retry.
 * - `SignedOut`: the sign-in page or a not-found page. A signed-in page
 *   asked for while signed out is kept as `maybeReturnRoute`, to go to
 *   after sign-in.
 * - `SignedIn`: the user, the page and any sign-out in progress; the
 *   tables the user can open; the latest schema revision a response
 *   stated (Contracts 6.2), seeded from `auth/me` or sign-in; the list
 *   page's state on a list route, and the number the next list page gets.
 *   The
 *   session token is never here: it lives in the HTTP-only cookie.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Model = defineTaggedUnion({
  CheckingSession: { route: AppRoute },
  SessionUnavailable: { route: AppRoute },
  SignedIn: {
    maybeRevision: Schema.Option(SchemaRevision),
    maybeTableList: Schema.Option(TableListModel),
    nextPageId: Schema.Int,
    route: SignedInRoute,
    signOutRequest: SignOutRequest,
    tables: Tables.schema,
    user: CurrentUserSchema,
  },
  SignedOut: {
    maybeReturnRoute: Schema.Option(SignedInRoute),
    route: SignedOutRoute,
    signIn: SignInModel,
  },
});

/** The app's state. */
export type Model = typeof Model.Type;

/** The signed-in state. */
export type SignedInModel = typeof Model.SignedIn.Type;

/** The signed-out state. */
export type SignedOutModel = typeof Model.SignedOut.Type;
