import { globSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

// Every workspace package is its own Vitest project. Vitest refuses a projects
// list that matches nothing, so with no packages yet the run is simply empty.
const projects = globSync([
  "packages/*/package.json",
  "apps/*/package.json",
  "examples/*/package.json",
  "bench/package.json",
]).map((file) => path.dirname(file));

export default defineConfig({
  test:
    projects.length > 0
      ? { passWithNoTests: true, projects }
      : { include: [], passWithNoTests: true },
});
