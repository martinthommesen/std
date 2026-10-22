import { describe, expect, it } from "vitest";

import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

// check-postgres signs in to STD_DATABASE_URL; CI provides the server as a
// service container, `pnpm db:up` locally.
const databaseUrl =
  process.env.STD_DATABASE_URL ?? "postgres://std:std@127.0.0.1:54329/std";

const checkPostgres = async (url: string) =>
  await runCommand(process.execPath, ["tooling/check-postgres.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STD_DATABASE_DIRECT_URL: url,
      STD_DATABASE_URL: url,
    },
  });

describe("postgres-check", () => {
  it("signs in and finds Postgres 18 with a UTF8 database", async () => {
    const result = await checkPostgres(databaseUrl);

    expect(result.output).toMatch(/: Postgres 18\d{4}, UTF8, /u);
    expect(result.code).toBe(0);
  });

  it("fails with the server's error for a wrong password", async () => {
    const url = new URL(databaseUrl);

    url.password = "not-the-password";

    const result = await checkPostgres(url.href);

    expect(result.code).toBe(1);
    expect(result.output).toContain("SQLSTATE 28P01");
  });
});
