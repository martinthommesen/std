import { Button, Nav } from "@foldkit/ui";
import { Match, Option } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { MAIN_ID } from "./command.ts";
import type { MetaTableSummary } from "./domain/metadata.ts";
import { Message } from "./message.ts";
import { SignOutRequest } from "./model.ts";
import type { Model, SignedInModel, SignedOutModel } from "./model.ts";
import { tableHref, view as homeView } from "./page/home.ts";
import { view as notFoundView } from "./page/not-found.ts";
import {
  title as recordFormTitle,
  view as recordFormView,
} from "./page/record-form/view.ts";
import { view as signInView } from "./page/sign-in/sign-in.ts";
import {
  title as tableListTitle,
  view as tableListView,
} from "./page/table-list/view.ts";
import { homeRouter, signInRouter } from "./route.ts";
import type { AppRoute } from "./route.ts";

const APP_NAME = "STD";

const WIDE_MAIN_CLASS = "main";

const NARROW_MAIN_CLASS = "main main-narrow";

/** The links of the primary navigation, by route tag. */
const NAV_ITEMS = ["Home"] as const;

type NavItem = (typeof NAV_ITEMS)[number];

const NAV_LABELS = { Home: "Home" } as const satisfies Record<NavItem, string>;

const NAV_HREFS = { Home: homeRouter } as const satisfies Record<
  NavItem,
  () => string
>;

/**
 * What every state renders: a header, a `main` holding the page and, when
 * signed in, the navigation to the tables beside it.
 */
interface ShellConfig {
  readonly header: readonly Html[];
  readonly mainClass: string;
  readonly page: Html;
  readonly side?: Html;
}

const shellView = (config: ShellConfig, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("app")],
    [
      h.header([h.Class("app-header")], config.header),
      h.div(
        [h.Class("app-body")],
        [
          // NOTE: the navigation follows `main` in the document, so the
          // page's h1 comes first; the stylesheet shows it on the left.
          h.main([h.Id(MAIN_ID), h.Class(config.mainClass)], [config.page]),
          config.side ?? h.empty,
        ]
      ),
    ]
  );

const brandLinkView = (href: string, h: HtmlBuilder<Message>): Html =>
  h.a([h.Href(href), h.Class("brand")], [APP_NAME]);

const brandView = (h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("brand")], [APP_NAME]);

const navView = (current: AppRoute, h: HtmlBuilder<Message>): Html =>
  Nav.view<NavItem>({
    ariaLabel: "Primary",
    isItemCurrent: (item) => current._tag === item,
    items: NAV_ITEMS,
    toHref: (item) => NAV_HREFS[item](),
    toView: ({ items, nav }) =>
      h.nav(
        [...nav, h.Class("primary-nav")],
        [
          h.ul(
            [h.Class("nav-list")],
            items.map((item) =>
              h.keyed("li")(
                item.value,
                [],
                [
                  h.a(
                    [...item.link, h.Class("nav-link")],
                    [NAV_LABELS[item.value]]
                  ),
                ]
              )
            )
          ),
        ]
      ),
  });

const currentTable = (route: AppRoute): Option.Option<string> =>
  Match.value(route).pipe(
    Match.tag("TableList", "Record", "NewRecord", ({ table }) =>
      Option.some(table)
    ),
    Match.orElse(() => Option.none())
  );

/**
 * A table's namespace: the part of its name before the first dot.
 *
 * @param table - The table's name, such as `helpdesk.incident`.
 * @returns The namespace, such as `helpdesk`.
 */
const namespaceOf = (table: string): string => table.split(".")[0] ?? table;

const tablesNavList = (
  tables: readonly MetaTableSummary[],
  current: AppRoute,
  h: HtmlBuilder<Message>
): Html => {
  const labels = new Map(tables.map((table) => [table.name, table.label]));

  return Nav.view({
    ariaLabel: "Tables",
    isItemCurrent: (table) => Option.contains(currentTable(current), table),
    items: tables.map((table) => table.name),
    toHref: tableHref,
    toView: ({ items, nav }) => {
      const namespaces = [
        ...new Set(items.map((item) => namespaceOf(item.value))),
      ];

      const listOf = (shown: typeof items) =>
        h.ul(
          [h.Class("nav-list nav-list-vertical")],
          shown.map((item) =>
            h.keyed("li")(
              item.value,
              [],
              [
                h.a(
                  [...item.link, h.Class("nav-link")],
                  [labels.get(item.value) ?? item.value]
                ),
              ]
            )
          )
        );

      return h.nav(
        [...nav, h.Class("tables-nav")],
        [
          h.h2([h.Class("tables-nav-heading")], ["Tables"]),
          ...(namespaces.length < 2
            ? [listOf(items)]
            : namespaces.map((namespace) =>
                h.keyed("div")(
                  namespace,
                  [h.Class("tables-nav-group")],
                  [
                    h.h3([h.Class("tables-nav-namespace")], [namespace]),
                    listOf(
                      items.filter(
                        (item) => namespaceOf(item.value) === namespace
                      )
                    ),
                  ]
                )
              )),
        ]
      );
    },
  });
};

const tablesNavView = (model: SignedInModel, h: HtmlBuilder<Message>): Html =>
  Option.match(AsyncData.getData(model.tables), {
    onNone: () => h.empty,
    onSome: (catalog) => tablesNavList(catalog.tables, model.route, h),
  });

const signOutFailureView = (
  signOutRequest: SignOutRequest,
  h: HtmlBuilder<Message>
): Html =>
  SignOutRequest.guards.Failed(signOutRequest)
    ? h.p(
        [h.Role("alert"), h.Class("account-alert")],
        ["Signing out did not work. Try again."]
      )
    : h.empty;

const signOutButtonView = (
  signOutRequest: SignOutRequest,
  h: HtmlBuilder<Message>
): Html => {
  const isPending = SignOutRequest.guards.Pending(signOutRequest);

  return Button.view(
    {
      isDisabled: isPending,
      onClick: Message.ClickedSignOut(),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.AriaLive("polite"),
            h.AriaAtomic(true),
            h.Class("button button-quiet"),
          ],
          [isPending ? "Signing out…" : "Sign out"]
        ),
    },
    h
  );
};

const accountView = (model: SignedInModel, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("account")],
    [
      h.p(
        [h.Class("account-user")],
        [
          h.span([h.Class("account-label")], ["Signed in as "]),
          h.strong([h.Class("account-name")], [model.user.name]),
        ]
      ),
      signOutButtonView(model.signOutRequest, h),
      signOutFailureView(model.signOutRequest, h),
    ]
  );

const signedInPageView = (
  model: SignedInModel,
  h: HtmlBuilder<Message>
): Html =>
  Match.value(model.route).pipe(
    Match.tag("Home", () => homeView(model.user, model.tables, h)),
    Match.tag("NotFound", ({ path }) =>
      notFoundView(path, { href: homeRouter(), text: "Go to the home page" }, h)
    ),
    Match.tag("Record", "NewRecord", () =>
      Option.match(model.maybeRecordForm, {
        onNone: () => h.empty,
        onSome: (page) =>
          h.submodel({
            model: page,
            slotId: "record-form",
            toParentMessage: (message) =>
              Message.GotRecordFormMessage({ message, pageId: page.id }),
            view: recordFormView,
          }),
      })
    ),
    Match.tag("TableList", () =>
      Option.match(model.maybeTableList, {
        onNone: () => h.empty,
        onSome: (page) =>
          h.submodel({
            model: page,
            slotId: "table-list",
            toParentMessage: (message) =>
              Message.GotTableListMessage({ message, pageId: page.id }),
            view: tableListView,
          }),
      })
    ),
    Match.exhaustive
  );

const signedInView = (model: SignedInModel, h: HtmlBuilder<Message>): Html =>
  shellView(
    {
      header: [
        brandLinkView(homeRouter(), h),
        navView(model.route, h),
        accountView(model, h),
      ],
      mainClass: WIDE_MAIN_CLASS,
      page: signedInPageView(model, h),
      side: tablesNavView(model, h),
    },
    h
  );

const signedOutPageView = (
  model: SignedOutModel,
  h: HtmlBuilder<Message>
): Html =>
  Match.value(model.route).pipe(
    Match.tag("SignIn", () =>
      h.submodel({
        model: model.signIn,
        slotId: "sign-in",
        toParentMessage: (message) => Message.GotSignInMessage({ message }),
        view: signInView,
      })
    ),
    Match.tag("NotFound", ({ path }) =>
      notFoundView(path, { href: signInRouter(), text: "Go to sign in" }, h)
    ),
    Match.exhaustive
  );

const signedOutView = (model: SignedOutModel, h: HtmlBuilder<Message>): Html =>
  shellView(
    {
      header: [brandLinkView(signInRouter(), h)],
      mainClass: NARROW_MAIN_CLASS,
      page: signedOutPageView(model, h),
    },
    h
  );

const checkingSessionView = (h: HtmlBuilder<Message>): Html =>
  shellView(
    {
      header: [brandView(h)],
      mainClass: NARROW_MAIN_CLASS,
      page: h.div(
        [h.Class("page")],
        [
          h.h1([], [APP_NAME]),
          h.p([h.Role("status")], ["Checking your session…"]),
        ]
      ),
    },
    h
  );

const sessionUnavailableView = (h: HtmlBuilder<Message>): Html =>
  shellView(
    {
      header: [brandView(h)],
      mainClass: NARROW_MAIN_CLASS,
      page: h.div(
        [h.Class("page")],
        [
          h.h1([], [`${APP_NAME} is not reachable`]),
          // NOTE: an alert, so that each failed retry, which mounts it
          // again, is announced.
          h.p(
            [h.Role("alert")],
            [
              "The server did not answer. Check that it is running, then try again.",
            ]
          ),
          Button.view(
            {
              onClick: Message.ClickedRetrySessionCheck(),
              toView: (attributes) =>
                h.button(
                  [...attributes.button, h.Class("button button-primary")],
                  ["Try again"]
                ),
            },
            h
          ),
        ]
      ),
    },
    h
  );

const routeTitle = (
  route: AppRoute,
  maybeTableList: Option.Option<Parameters<typeof tableListTitle>[0]>,
  maybeRecordForm: Option.Option<Parameters<typeof recordFormTitle>[0]>
): string =>
  Match.value(route).pipe(
    Match.tag("Home", () => "Home"),
    Match.tag("NotFound", () => "Page not found"),
    Match.tag("Record", "NewRecord", ({ table }) =>
      Option.match(maybeRecordForm, {
        onNone: () => table,
        onSome: recordFormTitle,
      })
    ),
    Match.tag("SignIn", () => "Sign in"),
    Match.tag("TableList", ({ table }) =>
      Option.match(maybeTableList, {
        onNone: () => table,
        onSome: tableListTitle,
      })
    ),
    Match.exhaustive
  );

const documentTitle = (model: Model): string =>
  Match.value(model).pipe(
    Match.tag("CheckingSession", () => APP_NAME),
    Match.tag("SessionUnavailable", () => `Not reachable · ${APP_NAME}`),
    Match.tag(
      "SignedIn",
      ({ maybeRecordForm, maybeTableList, route }) =>
        `${routeTitle(route, maybeTableList, maybeRecordForm)} · ${APP_NAME}`
    ),
    Match.tag(
      "SignedOut",
      ({ route }) =>
        `${routeTitle(route, Option.none(), Option.none())} · ${APP_NAME}`
    ),
    Match.exhaustive
  );

const bodyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model).pipe(
    Match.tag("CheckingSession", () => checkingSessionView(h)),
    Match.tag("SessionUnavailable", () => sessionUnavailableView(h)),
    Match.tag("SignedIn", (signedInModel) => signedInView(signedInModel, h)),
    Match.tag("SignedOut", (signedOutModel) =>
      signedOutView(signedOutModel, h)
    ),
    Match.exhaustive
  );

/**
 * The app's view.
 *
 * @param model - The state.
 * @param h - The builder.
 * @returns The document.
 */
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  body: bodyView(model, h),
  lang: "en",
  title: documentTitle(model),
});
