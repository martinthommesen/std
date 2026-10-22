import { Button, Nav } from "@foldkit/ui";
import { Match } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { MAIN_ID } from "./command.ts";
import { Message } from "./message.ts";
import { SignOutRequest } from "./model.ts";
import type { Model, SignedInModel, SignedOutModel } from "./model.ts";
import { view as homeView } from "./page/home.ts";
import { view as notFoundView } from "./page/not-found.ts";
import { view as signInView } from "./page/sign-in/sign-in.ts";
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

/** What every state renders: a header and a `main` holding the page. */
interface ShellConfig {
  readonly header: readonly Html[];
  readonly mainClass: string;
  readonly page: Html;
}

const shellView = (config: ShellConfig, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("app")],
    [
      h.header([h.Class("app-header")], config.header),
      h.main([h.Id(MAIN_ID), h.Class(config.mainClass)], [config.page]),
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
    Match.tag("Home", () => homeView(model.user, h)),
    Match.tag("NotFound", ({ path }) =>
      notFoundView(path, { href: homeRouter(), text: "Go to the home page" }, h)
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

const routeTitle = (route: AppRoute): string =>
  Match.value(route).pipe(
    Match.tag("Home", () => "Home"),
    Match.tag("NotFound", () => "Page not found"),
    Match.tag("SignIn", () => "Sign in"),
    Match.exhaustive
  );

const documentTitle = (model: Model): string =>
  Match.value(model).pipe(
    Match.tag("CheckingSession", () => APP_NAME),
    Match.tag("SessionUnavailable", () => `Not reachable · ${APP_NAME}`),
    Match.tag(
      "SignedIn",
      "SignedOut",
      ({ route }) => `${routeTitle(route)} · ${APP_NAME}`
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
