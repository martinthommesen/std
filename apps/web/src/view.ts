import { Button, Disclosure, Nav } from "@foldkit/ui";
import { Match, Option } from "effect";
import { AsyncData } from "foldkit";
import { childAttributes } from "foldkit/html";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { MAIN_ID, NAVIGATION_TOGGLE_ID } from "./command.ts";
import type { MetaTableSummary } from "./domain/metadata.ts";
import {
  ADMINISTRATION_LABEL,
  navigationGroupsOf,
} from "./domain/navigation.ts";
import { Message } from "./message.ts";
import { SignOutRequest } from "./model.ts";
import type { Model, SignedInModel, SignedOutModel } from "./model.ts";
import { view as deadLettersView } from "./page/dead-letters/view.ts";
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
import { deadLettersRouter, homeRouter, signInRouter } from "./route.ts";
import type { AppRoute } from "./route.ts";
import { USER_MENU_ITEMS, UserMenu } from "./user-menu.ts";
import type { UserMenuItem } from "./user-menu.ts";
import {
  chevronDown,
  chevronRight,
  menuLines,
  signOut as signOutIcon,
} from "./view/icons.ts";

const APP_NAME = "STD";

const MAIN_CLASS = "main";

const NARROW_MAIN_CLASS = "main main-narrow";

const SIDEBAR_SECTION_CLASS = "sidebar-section";

const ADMINISTRATION_ID = "administration";

/** The route links of the navigation, by route tag. */
type NavItem = "Home" | "DeadLetters";

/** The links of the primary navigation. */
const PRIMARY_ITEMS: readonly NavItem[] = ["Home"];

const NAV_LABELS = {
  DeadLetters: "Dead letters",
  Home: "Home",
} as const satisfies Record<NavItem, string>;

const NAV_HREFS = {
  DeadLetters: deadLettersRouter,
  Home: homeRouter,
} as const satisfies Record<NavItem, () => string>;

/**
 * What every state renders: a skip link, the header, `main` holding the
 * page and, when signed in, the navigation beside it.
 */
interface ShellConfig {
  readonly header: readonly Html[];
  readonly mainClass: string;
  readonly page: Html;
  readonly side?: readonly Html[];
}

const shellView = (config: ShellConfig, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("app")],
    [
      h.a([h.Href(`#${MAIN_ID}`), h.Class("skip-link")], ["Skip to content"]),
      h.header([h.Class("app-header")], config.header),
      h.div(
        [
          h.Class(
            config.side === undefined ? "app-body app-body-plain" : "app-body"
          ),
        ],
        [
          // NOTE: the navigation follows `main` in the document, so the
          // page's h1 comes first; the stylesheet shows it on the left.
          h.main(
            [h.Id(MAIN_ID), h.Class(config.mainClass), h.Tabindex(-1)],
            [config.page]
          ),
          ...(config.side ?? []),
        ]
      ),
    ]
  );

const brandLinkView = (href: string, h: HtmlBuilder<Message>): Html =>
  h.a([h.Href(href), h.Class("brand")], [APP_NAME]);

const brandView = (h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("brand")], [APP_NAME]);

// THE NAVIGATION

const currentTable = (route: AppRoute): Option.Option<string> =>
  Match.value(route).pipe(
    Match.tag("TableList", "Record", "NewRecord", ({ table }) =>
      Option.some(table)
    ),
    Match.orElse(() => Option.none())
  );

/**
 * A navigation of route links (Foldkit UI Nav: `aria-current` on the
 * current one): the primary navigation, and the Administration group's
 * pages.
 *
 * @param config - Its label, items, current route and class.
 * @param h - The builder.
 * @returns The navigation.
 */
const routeNavView = (
  config: {
    readonly ariaLabel: string;
    readonly className: string;
    readonly current: AppRoute;
    readonly items: readonly NavItem[];
  },
  h: HtmlBuilder<Message>
): Html =>
  Nav.view<NavItem>({
    ariaLabel: config.ariaLabel,
    isItemCurrent: (item) => config.current._tag === item,
    items: config.items,
    toHref: (item) => NAV_HREFS[item](),
    toView: ({ items, nav }) =>
      h.nav(
        [...nav, h.Class(config.className)],
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

/**
 * The Administration group's pages the user may open: the dead letters
 * of the event hubs for whoever may read `core.subscription` (the page's
 * own rule, `page/dead-letters`).
 *
 * @param tables - The tables the user can open.
 * @returns The pages.
 */
const administrationPagesOf = (
  tables: readonly MetaTableSummary[]
): readonly NavItem[] =>
  tables.some(({ name }) => name === "core.subscription")
    ? ["DeadLetters"]
    : [];

const tablesNavList = (
  model: SignedInModel,
  tables: readonly MetaTableSummary[],
  h: HtmlBuilder<Message>
): Html => {
  const groups = navigationGroupsOf(tables);

  const ordered = [
    ...groups.apps.flatMap((group) => group.tables),
    ...groups.administration,
  ];

  const labels = new Map(ordered.map((table) => [table.name, table.label]));

  return Nav.view({
    ariaLabel: "Tables",
    isItemCurrent: (table) => Option.contains(currentTable(model.route), table),
    items: ordered.map((table) => table.name),
    toHref: tableHref,
    toView: ({ items, nav }) => {
      const links = new Map(items.map((item) => [item.value, item.link]));

      const listOf = (shown: readonly MetaTableSummary[]) =>
        h.ul(
          [h.Class("nav-list")],
          shown.map((table) =>
            h.keyed("li")(
              table.name,
              [],
              [
                h.a(
                  [...(links.get(table.name) ?? []), h.Class("nav-link")],
                  [labels.get(table.name) ?? table.name]
                ),
              ]
            )
          )
        );

      const pages = administrationPagesOf(tables);

      const administrationCount = pages.length + groups.administration.length;

      const administrationView =
        administrationCount === 0
          ? h.empty
          : Disclosure.view(
              {
                id: ADMINISTRATION_ID,
                isOpen: model.preferences.isAdministrationOpen,
                onToggle: (isOpen) => Message.ToggledAdministration({ isOpen }),
                toView: ({ animatePanel, button, panel }) =>
                  h.div(
                    [h.Class(SIDEBAR_SECTION_CLASS)],
                    [
                      h.button(
                        [...button, h.Class("nav-group-button")],
                        [
                          chevronRight(),
                          h.span([], [ADMINISTRATION_LABEL]),
                          h.span(
                            [h.Class("nav-group-count")],
                            [
                              h.span(
                                [h.Class("visually-hidden")],
                                [", entries: "]
                              ),
                              String(administrationCount),
                            ]
                          ),
                        ]
                      ),
                      animatePanel(
                        h.div(
                          [...panel, h.Class("nav-group-panel")],
                          [
                            // NOTE: the group's pages come first, as their
                            // own navigation inside the tables'; the
                            // platform's tables follow.
                            pages.length === 0
                              ? h.empty
                              : routeNavView(
                                  {
                                    ariaLabel: "Administration pages",
                                    className: "nav-group-pages",
                                    current: model.route,
                                    items: pages,
                                  },
                                  h
                                ),
                            listOf(groups.administration),
                          ]
                        )
                      ),
                    ]
                  ),
              },
              h
            );

      return h.nav(
        [...nav, h.Class("tables-nav")],
        [
          ...groups.apps.map((group) =>
            h.keyed("div")(
              group.namespace,
              [h.Class(SIDEBAR_SECTION_CLASS)],
              [
                h.h2([h.Class("sidebar-heading")], [group.namespace]),
                listOf(group.tables),
              ]
            )
          ),
          administrationView,
        ]
      );
    },
  });
};

const tablesNavView = (model: SignedInModel, h: HtmlBuilder<Message>): Html =>
  Option.match(AsyncData.getData(model.tables), {
    onNone: () => h.empty,
    onSome: (catalog) => tablesNavList(model, catalog.tables, h),
  });

/**
 * The navigation drawer is a disclosure whose button sits in the header
 * and whose panel is the sidebar; both halves are rendered from the same
 * state, each by its own `Disclosure.view` call.
 *
 * @param model - The signed-in state.
 * @returns The disclosure's state and toggle.
 */
const navigationDisclosure = (model: SignedInModel) => ({
  id: NAVIGATION_TOGGLE_ID,
  isOpen: model.isNavigationOpen,
  onToggle: (isOpen: boolean) => Message.ToggledNavigation({ isOpen }),
});

/**
 * Escape closes the navigation drawer when it is open.
 *
 * @param isOpen - Whether the drawer is open.
 * @returns The key handler's Message, if any.
 */
const closeOnEscape =
  (isOpen: boolean) =>
  (key: string): Option.Option<Message> =>
    isOpen && key === "Escape"
      ? Option.some(Message.ToggledNavigation({ isOpen: false }))
      : Option.none();

/**
 * Behind the open drawer on a narrow screen: a scrim over the page, which
 * closes the drawer when clicked (the stylesheet shows it only there).
 *
 * @param model - The signed-in state.
 * @param h - The builder.
 * @returns The scrim, or nothing while the drawer is closed.
 */
const navigationScrimView = (
  model: SignedInModel,
  h: HtmlBuilder<Message>
): Html =>
  model.isNavigationOpen
    ? h.div([
        h.Class("nav-scrim"),
        h.AriaHidden(true),
        h.OnClick(Message.ToggledNavigation({ isOpen: false })),
      ])
    : h.empty;

const sidebarView = (model: SignedInModel, h: HtmlBuilder<Message>): Html =>
  Disclosure.view(
    {
      ...navigationDisclosure(model),
      toView: ({ panel }) =>
        h.aside(
          [
            ...panel,
            h.Class("sidebar"),
            h.AriaLabel("Navigation"),
            h.OnKeyDownPreventDefault(closeOnEscape(model.isNavigationOpen)),
          ],
          [
            routeNavView(
              {
                ariaLabel: "Primary",
                className: SIDEBAR_SECTION_CLASS,
                current: model.route,
                items: PRIMARY_ITEMS,
              },
              h
            ),
            tablesNavView(model, h),
            model.isPreferenceSaveFailed
              ? h.p(
                  [h.Role("status"), h.Class("control-hint sidebar-section")],
                  [
                    "This browser did not store whether Administration is open; it starts closed next time.",
                  ]
                )
              : h.empty,
          ]
        ),
    },
    h
  );

const navigationToggleView = (
  model: SignedInModel,
  h: HtmlBuilder<Message>
): Html =>
  Disclosure.view(
    {
      ...navigationDisclosure(model),
      ariaLabel: "Navigation",
      toView: ({ button }) =>
        h.button(
          [...button, h.Class("header-button nav-toggle")],
          [menuLines()]
        ),
    },
    h
  );

// THE USER MENU

const initialsOf = (name: string): string =>
  name
    .split(/\s+/u)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

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

const userMenuView = (model: SignedInModel, h: HtmlBuilder<Message>): Html => {
  const isSigningOut = SignOutRequest.guards.Pending(model.signOutRequest);

  return h.submodel({
    model: model.userMenu,
    slotId: model.userMenu.id,
    toParentMessage: (message) => Message.GotUserMenuMessage({ message }),
    view: UserMenu.view,
    viewInputs: {
      anchor: { gap: 4, padding: 8, placement: "bottom-end" },
      attributes: childAttributes([h.Class("user-menu")]),
      backdropAttributes: childAttributes([h.Class("menu-backdrop")]),
      buttonAttributes: childAttributes([
        h.Class("header-button user-menu-button"),
      ]),
      buttonContent: h.span(
        [h.Class("user-menu-button-content")],
        [
          h.span(
            [h.Class("avatar"), h.AriaHidden(true)],
            [initialsOf(model.user.name)]
          ),
          h.span([h.Class("user-menu-name")], [model.user.name]),
          chevronDown(),
        ]
      ),
      groupToHeading: () => ({
        className: "menu-heading",
        content: h.div([], ["Signed in as", h.strong([], [model.user.name])]),
      }),
      isItemDisabled: () => isSigningOut,
      itemGroupKey: () => "account",
      itemToConfig: (item: UserMenuItem) =>
        Match.value(item).pipe(
          Match.when("SignOut", () => ({
            className: "menu-item",
            content: h.span(
              [h.Class("menu-item-content")],
              [signOutIcon(), isSigningOut ? "Signing out…" : "Sign out"]
            ),
          })),
          Match.exhaustive
        ),
      items: USER_MENU_ITEMS,
      itemsAttributes: childAttributes([h.Class("menu-items")]),
    },
  });
};

// THE PAGES

const signedInPageView = (
  model: SignedInModel,
  h: HtmlBuilder<Message>
): Html =>
  Match.value(model.route).pipe(
    Match.tag("Home", () => homeView(model.user, model.tables, h)),
    Match.tag("DeadLetters", () =>
      Option.match(model.maybeDeadLetters, {
        onNone: () => h.empty,
        onSome: (page) =>
          h.submodel({
            model: page,
            slotId: "dead-letters",
            toParentMessage: (message) =>
              Message.GotDeadLettersMessage({ message, pageId: page.id }),
            view: deadLettersView,
          }),
      })
    ),
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
        navigationToggleView(model, h),
        brandLinkView(homeRouter(), h),
        h.div(
          [h.Class("header-end")],
          [
            SignOutRequest.guards.Pending(model.signOutRequest)
              ? h.p(
                  [h.Role("status"), h.Class("header-status")],
                  ["Signing out…"]
                )
              : h.empty,
            signOutFailureView(model.signOutRequest, h),
            userMenuView(model, h),
          ]
        ),
      ],
      mainClass:
        model.route._tag === "DeadLetters"
          ? `${MAIN_CLASS} dead-letters-main`
          : MAIN_CLASS,
      page: signedInPageView(model, h),
      side: [navigationScrimView(model, h), sidebarView(model, h)],
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
            [h.Role("alert"), h.Class("form-alert")],
            [
              "The server did not answer. Check that it is running, then try again.",
            ]
          ),
          h.div(
            [],
            [
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
    Match.tag("DeadLetters", () => "Dead letters"),
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
