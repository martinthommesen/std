/**
 * What the shell remembers in the browser between visits: whether the
 * navigation's Administration group is open. It is kept in
 * `localStorage` under one key, read once at start-up as the app's flags
 * and written whenever the user opens or closes the group. It holds no
 * user data, so it is the same for every user of the browser.
 */
import { Effect, Option, Schema } from "effect";

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

/** The preferences and storage problem the app starts with. */
export const InitialShellPreferences = Schema.Struct({
  maybePreferenceProblem: Schema.Option(PreferenceProblem),
  preferences: ShellPreferences,
});

const decodeStored = Schema.decodeUnknownEffect(ShellPreferencesJson);

/**
 * Reads the stored preferences at start-up, applying defaults when absent
 * and reporting unreadable storage or invalid text alongside the defaults.
 */
export const readShellPreferences: Effect.Effect<
  typeof InitialShellPreferences.Type
> = Effect.try(() =>
  globalThis.localStorage.getItem(SHELL_PREFERENCES_KEY)
).pipe(
  Effect.matchEffect({
    onFailure: () =>
      Effect.succeed({
        maybePreferenceProblem: Option.some<PreferenceProblem>("Unreadable"),
        preferences: DEFAULT_SHELL_PREFERENCES,
      }),
    onSuccess: (stored) =>
      stored === null
        ? Effect.succeed({
            maybePreferenceProblem: Option.none<PreferenceProblem>(),
            preferences: DEFAULT_SHELL_PREFERENCES,
          })
        : decodeStored(stored).pipe(
            Effect.map((preferences) => ({
              maybePreferenceProblem: Option.none<PreferenceProblem>(),
              preferences,
            })),
            Effect.orElseSucceed(() => ({
              maybePreferenceProblem: Option.some<PreferenceProblem>("Invalid"),
              preferences: DEFAULT_SHELL_PREFERENCES,
            }))
          ),
  })
);
