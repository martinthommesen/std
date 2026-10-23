/**
 * The app's icons: drawn for STD on a 16-unit grid with one 1.5-unit
 * round stroke, in `currentColor`, so they take the text colour of the
 * control they sit in. Every icon is decorative (`aria-hidden`): the
 * control around it carries the accessible name. Each takes an optional
 * extra class and returns the `svg`.
 */
import { inertHtml as ih } from "foldkit/html";
import type { Html } from "foldkit/html";

const icon = (paths: readonly string[], className: string): Html =>
  ih.svg(
    [
      ih.AriaHidden(true),
      ih.Class(`icon ${className}`),
      ih.Xmlns("http://www.w3.org/2000/svg"),
      ih.ViewBox("0 0 16 16"),
      ih.Fill("none"),
      ih.Stroke("currentColor"),
      ih.StrokeWidth("1.5"),
    ],
    paths.map((d) =>
      ih.path([ih.StrokeLinecap("round"), ih.StrokeLinejoin("round"), ih.D(d)])
    )
  );

/**
 * A chevron pointing right; rotated by CSS when its disclosure is open.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const chevronRight = (className = ""): Html =>
  icon(["M6 3.5 10.5 8 6 12.5"], `chevron ${className}`);

/**
 * A chevron pointing down, for a menu button.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const chevronDown = (className = ""): Html =>
  icon(["M3.5 6 8 10.5 12.5 6"], className);

/**
 * A chevron pointing left, for the previous page.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const chevronLeft = (className = ""): Html =>
  icon(["M10 3.5 5.5 8 10 12.5"], className);

/**
 * A chevron pointing right, for the next page.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const chevronNext = (className = ""): Html =>
  icon(["M6 3.5 10.5 8 6 12.5"], className);

/**
 * Three lines, for the button that shows the navigation.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const menuLines = (className = ""): Html =>
  icon(["M2.5 4h11", "M2.5 8h11", "M2.5 12h11"], className);

/**
 * A cross, for the button that closes the navigation drawer.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const close = (className = ""): Html =>
  icon(["M4 4l8 8", "M12 4l-8 8"], className);

/**
 * A funnel, for the filter.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const funnel = (className = ""): Html =>
  icon(["M2.5 3h11L9.25 8.25v4.25l-2.5 1.25V8.25Z"], className);

/**
 * A plus, for creating a record.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const plus = (className = ""): Html =>
  icon(["M8 3v10", "M3 8h10"], className);

/**
 * An arrow up and an arrow down: the column can be sorted.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const sortBoth = (className = ""): Html =>
  icon(["M5 6.5 8 3.5l3 3", "M5 9.5l3 3 3-3"], `sort-icon ${className}`);

/**
 * An arrow up: the column sorts ascending.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const sortAscending = (className = ""): Html =>
  icon(["M8 13V3.5", "M4.5 7 8 3.5 11.5 7"], `sort-icon ${className}`);

/**
 * An arrow down: the column sorts descending.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const sortDescending = (className = ""): Html =>
  icon(["M8 3v9.5", "M4.5 9 8 12.5 11.5 9"], `sort-icon ${className}`);

/**
 * A tick, for a saved record.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const check = (className = ""): Html =>
  icon(["M3 8.5 6.5 12 13 4.5"], className);

/**
 * A door with an arrow, for signing out.
 *
 * @param className - An extra class.
 * @returns The icon.
 */
export const signOut = (className = ""): Html =>
  icon(["M6.5 2.5h-3v11h3", "M10 5l3 3-3 3", "M13 8H6.5"], className);
