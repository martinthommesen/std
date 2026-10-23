/**
 * Reading the shell's preferences at start-up, against the test
 * environment's `localStorage`: a first visit, the stored preferences,
 * text that is not theirs, and storage that refuses to be read.
 */
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SHELL_PREFERENCES_KEY,
  DEFAULT_SHELL_PREFERENCES,
  readShellPreferences,
} from "./shell-preferences.ts";

describe("the shell's stored preferences", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.localStorage.clear();
  });

  it("are absent on a first visit", async () => {
    await expect(
      Effect.runPromise(readShellPreferences)
    ).resolves.toStrictEqual({
      maybePreferenceProblem: Option.none(),
      preferences: DEFAULT_SHELL_PREFERENCES,
    });
  });

  it("are read back as stored", async () => {
    globalThis.localStorage.setItem(
      SHELL_PREFERENCES_KEY,
      '{"isAdministrationOpen":true}'
    );

    await expect(
      Effect.runPromise(readShellPreferences)
    ).resolves.toStrictEqual({
      maybePreferenceProblem: Option.none(),
      preferences: { isAdministrationOpen: true },
    });
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["JSON of another shape", '{"isAdministrationOpen":"yes"}'],
  ])("are invalid when the key holds %s", async (_case, stored) => {
    globalThis.localStorage.setItem(SHELL_PREFERENCES_KEY, stored);

    await expect(
      Effect.runPromise(readShellPreferences)
    ).resolves.toStrictEqual({
      maybePreferenceProblem: Option.some("Invalid"),
      preferences: DEFAULT_SHELL_PREFERENCES,
    });
  });

  it("are unreadable when the storage throws", async () => {
    // NOTE: a browser that blocks storage for the page throws as soon as
    // `localStorage` is read; the test environment's never does, so it is
    // made to here.
    vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    });

    await expect(
      Effect.runPromise(readShellPreferences)
    ).resolves.toStrictEqual({
      maybePreferenceProblem: Option.some("Unreadable"),
      preferences: DEFAULT_SHELL_PREFERENCES,
    });
  });
});
