/**
 * Global setup of the browser tests: refuses to run without Playwright's
 * Chromium, then builds the web app once, into a temporary directory that
 * each test's `std serve` serves (`STD_WEB_ROOT`).
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { build } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation of Vitest's ProvidedContext needs an interface
  interface ProvidedContext {
    /** The built web app, for `STD_WEB_ROOT`. */
    webRoot: string;
  }
}

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** How to install the browser, in the failure message. */
export const INSTALL_HINT =
  "pnpm --filter @std/web exec playwright install chromium";

/**
 * Checks the browser, builds the app and provides its directory.
 *
 * @param project - The Vitest project.
 * @returns The teardown, which removes the build.
 */
export default async function setup(project: TestProject) {
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      `The browser tests need Playwright's Chromium, which is not installed (looked for ${chromium.executablePath()}). Install it into your user cache with: ${INSTALL_HINT}`
    );
  }

  const webRoot = await mkdtemp(path.join(tmpdir(), "std-web-browser-"));

  await build({
    build: { emptyOutDir: true, outDir: webRoot },
    configFile: path.join(APP_DIR, "vite.config.ts"),
    logLevel: "warn",
    root: APP_DIR,
  });

  project.provide("webRoot", webRoot);

  return async () => {
    await rm(webRoot, { force: true, recursive: true });
  };
}
