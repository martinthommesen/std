/**
 * The setup `pnpm tmf621-example:ci` and `pnpm ctk:ci` share: `std upgrade`
 * with the helpdesk set v3, `std bootstrap-admin` and `std serve` on a
 * disposable database, as a user the caller names.
 */
import { fileURLToPath } from "node:url";

import { TestDatabase } from "@std/testing/test-database";
import { Effect } from "effect";

import { listeningAt, run, startServer } from "./steps.ts";

/** The `std` command's entry module. */
export const CLI = fileURLToPath(
  new URL("../../../packages/server/src/cli/main.ts", import.meta.url)
);

/** The helpdesk definition set v3 (TMF621 is served over it). */
export const HELPDESK_SET = fileURLToPath(
  new URL("../../helpdesk/v3", import.meta.url)
);

/** The repository's root. */
export const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../", import.meta.url)
);

/** The administrator a helpdesk server is bootstrapped with. */
export interface HelpdeskAdmin {
  readonly login: string;
  readonly password: string;
}

/** A running helpdesk `std serve`. */
export interface HelpdeskServer {
  /** The server's environment, for child processes. */
  readonly env: NodeJS.ProcessEnv;
  /** The server's log so far. */
  readonly log: () => string;
  /** The server's origin, such as `http://127.0.0.1:41234`. */
  readonly url: string;
}

/**
 * Brings up STD with the helpdesk set v3 on the harness's disposable
 * database and waits until it listens. The server ends with the scope.
 * @param admin - The first administrator.
 * @returns The running server.
 */
export const startHelpdeskServer = Effect.fn("HelpdeskServer.start")(
  function* startHelpdeskServer(admin: HelpdeskAdmin) {
    const database = yield* TestDatabase;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STD_ADMIN_LOGIN: admin.login,
      STD_ADMIN_PASSWORD: admin.password,
      STD_DATABASE_DIRECT_URL: database.url,
      STD_DATABASE_URL: database.url,
      STD_HTTP_HOST: "127.0.0.1",
      STD_HTTP_PORT: "0",
    };

    yield* run(
      "std upgrade --set examples/helpdesk/v3",
      process.execPath,
      [CLI, "upgrade", "--set", HELPDESK_SET],
      env
    );
    yield* run(
      "std bootstrap-admin",
      process.execPath,
      [CLI, "bootstrap-admin"],
      env
    );

    const server = yield* startServer(CLI, env);
    const url = yield* listeningAt(server);

    return { env, log: server.log, url } satisfies HelpdeskServer;
  }
);
