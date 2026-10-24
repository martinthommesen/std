import { defineConfig } from "vitest/config";

import { listWorkspacePackages, repoRoot } from "./tooling/lib/workspace.ts";

const projects = listWorkspacePackages()
  .filter((pkg) => pkg.dir !== repoRoot)
  .map((pkg) => pkg.dir);

export default defineConfig({
  test:
    projects.length > 0
      ? { passWithNoTests: true, projects }
      : { include: [], passWithNoTests: true },
});
