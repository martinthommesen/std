import type { Html, HtmlBuilder } from "foldkit/html";

/** Where the not-found page sends the user back to. */
export interface BackLink {
  readonly href: string;
  readonly text: string;
}

/**
 * The page for a path the app does not know.
 *
 * @param path - The unknown path.
 * @param back - The link back.
 * @param h - The builder.
 * @returns The page.
 */
export const view = <Message>(
  path: string,
  back: BackLink,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [
      h.h1([], ["Page not found"]),
      h.p([], ["There is no page at ", h.code([], [path]), "."]),
      h.p([], [h.a([h.Href(back.href), h.Class("link")], [back.text])]),
    ]
  );
