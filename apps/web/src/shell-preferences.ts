/**
 * What the shell remembers in the browser between visits: whether the
 * navigation's Administration group is open. It is kept in
 * `localStorage` under one key, read once at start-up as the app's flags
 * and written whenever the user opens or closes the group. It holds no
 * user data, so it is the same for every user of the browser.
 */
import { Effect, Schema } from "effect";

/** The shell's remembered state. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const ShellPreferences = Schema.Struct({
  isAdministrationOpen: Schema.Boolean,
});

/** The shell's remembered state. */
export type ShellPreferences = typeof ShellPreferences.Type;

/** The `localStorage` key the preferences live under. */
export const SHELL_PREFERENCES_KEY = "std.web.shell";

/** The preferences of a browser that stored none: the group is closed. */
export const DEFAULT_SHELL_PREFERENCES: ShellPreferences = {
  isAdministrationOpen: false,
};

/** The preferences as the stored JSON text. */
export const ShellPreferencesJson = Schema.fromJsonString(ShellPreferences);

const decodeStored = Schema.decodeUnknownEffect(ShellPreferencesJson);

/**
 * Reads the stored preferences at start-up. A browser that stored none, or
 * whose storage is unavailable (disabled, or blocked for the page), or
 * whose stored text does not decode, starts with the defaults: the
 * navigation still works, only the group starts closed.
 */
export const readShellPreferences: Effect.Effect<ShellPreferences> = Effect.try(
  () => globalThis.localStorage.getItem(SHELL_PREFERENCES_KEY)
).pipe(
  Effect.flatMap((stored) =>
    stored === null
      ? Effect.succeed(DEFAULT_SHELL_PREFERENCES)
      : decodeStored(stored)
  ),
  Effect.orElseSucceed(() => DEFAULT_SHELL_PREFERENCES)
);
