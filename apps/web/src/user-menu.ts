/**
 * The header's user menu (Foldkit UI Menu): the signed-in user's name and
 * the one action on the session, signing out.
 */
import { Menu } from "@foldkit/ui";

/** What the user menu offers. */
export type UserMenuItem = "SignOut";

/** The menu's items, in order. */
export const USER_MENU_ITEMS: readonly UserMenuItem[] = ["SignOut"];

/** The menu's ID; its button is `Menu.buttonId(USER_MENU_ID)`. */
export const USER_MENU_ID = "user-menu";

/** The user menu's Submodel, typed by its items. */
export const UserMenu = Menu.create<UserMenuItem>();

/**
 * The user menu of a new session: closed.
 *
 * @returns Its Model.
 */
export const initUserMenu = (): Menu.Model => Menu.init({ id: USER_MENU_ID });
