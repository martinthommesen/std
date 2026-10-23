/**
 * The navigation of narrow screens (Foldkit UI Dialog): a modal drawer
 * behind the header's menu button. While it is open the page behind it is
 * inert, Tab stays inside it, Escape or the backdrop closes it, and focus
 * goes back to the menu button. Wide screens show the navigation beside
 * the page instead and hide the menu button.
 */
import { Dialog } from "@foldkit/ui";

/** The leave confirmation's ID: the native `dialog` element's. */
export const LEAVE_DIALOG_ID = "leave-confirmation";

/**
 * The leave confirmation of a new session: closed. It opens on "Keep
 * editing", the choice that loses nothing.
 *
 * @returns Its Model.
 */
export const initLeaveDialog = (): Dialog.Model =>
  Dialog.init({ id: LEAVE_DIALOG_ID });

/** The drawer's ID: the native `dialog` element's. */
export const NAVIGATION_DRAWER_ID = "navigation-drawer";

/**
 * The drawer of a new session: closed. Opening it focuses its first link,
 * so keyboard users land in what they opened.
 *
 * @returns Its Model.
 */
export const initNavigationDrawer = (): Dialog.Model =>
  Dialog.init({
    focusSelector: `#${NAVIGATION_DRAWER_ID} .nav-link`,
    id: NAVIGATION_DRAWER_ID,
  });
