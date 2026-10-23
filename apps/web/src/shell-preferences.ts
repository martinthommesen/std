/**
 * What the shell remembers in the browser between visits: whether the
 * navigation's Administration group is open. It is kept in
 * `localStorage` under one key, read once at start-up as the app's flags
 * and written whenever the user opens or closes the group. It holds no
 * user data, so it is the same for every user of the browser.
 */
import { Effect, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

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

/**
 * What the browser's storage held at start-up (the app's flags):
 *
 * - `Absent`: nothing stored yet, a first visit; the defaults apply.
 * - `Stored`: the preferences stored last time.
 * - `Unreadable`: the storage refused to be read (disabled, or blocked for
 *   the page).
 * - `Invalid`: something is stored under the key that is not the
 *   preferences' JSON.
 *
 * The last two are failures the navigation says; the app then starts
 * with the defaults.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const StoredShellPreferences = defineTaggedUnion({
  Absent: {},
  Invalid: {},
  Stored: { preferences: ShellPreferences },
  Unreadable: {},
});

/** What the browser's storage held at start-up. */
export type StoredShellPreferences = typeof StoredShellPreferences.Type;

/**
 * Why the shell's preferences are not as the user left them, which the
 * navigation says: the storage could not be read (`Unreadable`), held
 * something else (`Invalid`), or refused the last write (`Unsaved`).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const PreferenceProblem = Schema.Literals([
  "Invalid",
  "Unreadable",
  "Unsaved",
]);

/** Why the shell's preferences are not as the user left them. */
export type PreferenceProblem = typeof PreferenceProblem.Type;

const decodeStored = Schema.decodeUnknownEffect(ShellPreferencesJson);

/**
 * Reads the stored preferences at start-up, telling a first visit apart
 * from storage that cannot be read and from text that does not decode.
 */
export const readShellPreferences: Effect.Effect<StoredShellPreferences> =
  Effect.try(() => globalThis.localStorage.getItem(SHELL_PREFERENCES_KEY)).pipe(
    Effect.matchEffect({
      onFailure: (): Effect.Effect<StoredShellPreferences> =>
        Effect.succeed(StoredShellPreferences.Unreadable()),
      onSuccess: (stored): Effect.Effect<StoredShellPreferences> =>
        stored === null
          ? Effect.succeed(StoredShellPreferences.Absent())
          : decodeStored(stored).pipe(
              Effect.map((preferences) =>
                StoredShellPreferences.Stored({ preferences })
              ),
              Effect.orElseSucceed(() => StoredShellPreferences.Invalid())
            ),
    })
  );
