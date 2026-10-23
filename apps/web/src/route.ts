import { Match, Option, Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal, slash, string } from "foldkit/route";

/**
 * Every page of the app.
 *
 * - `TableList`: `/tables/:table`, a table's records. The query keeps the
 *   applied list state, so a reload or a shared link shows the same list
 *   (decision 0020): `filter` is the condition AST as JSON (fields by ID,
 *   so it survives renames), `sort` the sort keys as field IDs (`-` for
 *   descending, comma-separated), `limit` the page size. The page decodes
 *   them against the table's metadata; the route keeps them as text.
 * - `Record`: `/tables/:table/records/:id`, one record's form.
 * - `NewRecord`: `/tables/:table/new`, the form that creates a record.
 *
 * A form opened from a list keeps that list's `filter`, `sort` and
 * `limit` in its own query, so "Back to the list", a delete and a create
 * return to the list the user was working through; a form opened
 * otherwise has none and goes back to the table's plain list.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const AppRoute = defineRouteUnion({
  DeadLetters: {},
  Home: {},
  NewRecord: {
    filter: Schema.Option(Schema.String),
    limit: Schema.Option(Schema.String),
    sort: Schema.Option(Schema.String),
    table: Schema.String,
  },
  NotFound: { path: Schema.String },
  Record: {
    filter: Schema.Option(Schema.String),
    id: Schema.String,
    limit: Schema.Option(Schema.String),
    sort: Schema.Option(Schema.String),
    table: Schema.String,
  },
  SignIn: {},
  TableList: {
    filter: Schema.Option(Schema.String),
    limit: Schema.Option(Schema.String),
    sort: Schema.Option(Schema.String),
    table: Schema.String,
  },
});

/** A page of the app. */
export type AppRoute = typeof AppRoute.Type;

/** A table's list page. */
export type TableListRoute = typeof AppRoute.TableList.Type;

/**
 * A list's state as its address holds it: the filter, the sort and the
 * page size, as text (`TableList`), and the list a form was opened from
 * (`Record`, `NewRecord`).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const ListQuery = Schema.Struct({
  filter: Schema.Option(Schema.String),
  limit: Schema.Option(Schema.String),
  sort: Schema.Option(Schema.String),
});

/** A list's state as its address holds it. */
export type ListQuery = typeof ListQuery.Type;

/** The table's plain list: no filter, the default sort and page size. */
export const PLAIN_LIST: ListQuery = {
  filter: Option.none(),
  limit: Option.none(),
  sort: Option.none(),
};

const listQueryParameters = Route.query(
  Schema.Struct({
    filter: Schema.OptionFromOptional(Schema.String),
    limit: Schema.OptionFromOptional(Schema.String),
    sort: Schema.OptionFromOptional(Schema.String),
  })
);

/** The pages a signed-in user can be on. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SignedInRoute = AppRoute.subset([
  "Home",
  "DeadLetters",
  "NewRecord",
  "NotFound",
  "Record",
  "TableList",
]);

/** A page a signed-in user can be on. */
export type SignedInRoute = typeof SignedInRoute.Type;

/** The pages a signed-out visitor can be on. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SignedOutRoute = AppRoute.subset(["SignIn", "NotFound"]);

/** A page a signed-out visitor can be on. */
export type SignedOutRoute = typeof SignedOutRoute.Type;

/** `/`: the home page. */
export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

/** The outbox operator page under the admin area. */
export const deadLettersRouter = pipe(
  literal("administration"),
  slash(literal("dead-letters")),
  Route.mapTo(AppRoute.DeadLetters)
);

/** `/sign-in`: the sign-in page. */
export const signInRouter = pipe(
  literal("sign-in"),
  Route.mapTo(AppRoute.SignIn)
);

/** `/tables/:table?filter=&sort=&limit=`: a table's list. */
export const tableListRouter = pipe(
  literal("tables"),
  slash(string("table")),
  listQueryParameters,
  Route.mapTo(AppRoute.TableList)
);

/**
 * `/tables/:table/records/:id?filter=&sort=&limit=`: one record, opened
 * from the list the query names.
 */
export const recordRouter = pipe(
  literal("tables"),
  slash(string("table")),
  slash(literal("records")),
  slash(string("id")),
  listQueryParameters,
  Route.mapTo(AppRoute.Record)
);

/**
 * `/tables/:table/new?filter=&sort=&limit=`: the form that creates a
 * record, opened from the list the query names.
 */
export const newRecordRouter = pipe(
  literal("tables"),
  slash(string("table")),
  slash(literal("new")),
  listQueryParameters,
  Route.mapTo(AppRoute.NewRecord)
);

/** The route of a URL; an unknown path is `NotFound`. */
export const urlToAppRoute = Route.parseUrlWithFallback(
  Route.oneOf(
    deadLettersRouter,
    newRecordRouter,
    recordRouter,
    tableListRouter,
    signInRouter,
    homeRouter
  ),
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
    Match.tag("DeadLetters", () => deadLettersRouter()),
    Match.tag("NewRecord", ({ filter, limit, sort, table }) =>
      newRecordRouter({ filter, limit, sort, table })
    ),
    Match.tag("NotFound", ({ path }) => path),
    Match.tag("Record", ({ filter, id, limit, sort, table }) =>
      recordRouter({ filter, id, limit, sort, table })
    ),
    Match.tag("TableList", ({ filter, limit, sort, table }) =>
      tableListRouter({ filter, limit, sort, table })
    ),
    Match.exhaustive
  );
