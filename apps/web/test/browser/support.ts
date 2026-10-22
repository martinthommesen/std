/**
 * What the browser tests run against, each released with its scope: a real
 * `std serve` process on the test database, Chromium, a page on another
 * port of the same host (the same site, another origin), the Vite dev
 * server with Foldkit DevTools, and a client of the DevTools MCP server.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Effect, Predicate, Schedule, Schema } from "effect";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { createServer as createViteServer } from "vite";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));

const CLI = fileURLToPath(
  new URL("../../../../packages/server/src/cli/main.ts", import.meta.url)
);

const DEVTOOLS_MCP = fileURLToPath(
  new URL(
    "../../node_modules/@foldkit/devtools-mcp/dist/server.js",
    import.meta.url
  )
);

/** The line `std serve` logs once it listens. */
const LISTENING = /Listening on (?<url>http:\/\/[\d.:]+)/u;

const LISTEN_POLLS = 150;

/** A running `std serve`. */
export interface StdServer {
  /** Where it listens, such as `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** Everything it has logged. */
  readonly log: () => string;
}

/** `std serve` did not start listening. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class ServerNotListening extends Schema.TaggedError<ServerNotListening>()(
  "ServerNotListening",
  { exited: Schema.Boolean }
) {}

/**
 * Ends a process and every process it started (its process group), and
 * waits for it to exit.
 *
 * @param child - A process spawned with `detached: true`.
 * @returns Nothing, once it has exited.
 */
const endProcessGroup = (child: ChildProcess) =>
  Effect.callback<ChildProcess>((resume) => {
    const exited = () => {
      resume(Effect.succeed(child));
    };

    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      exited();

      return;
    }

    child.once("exit", exited);

    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      exited();
    }
  });

/**
 * Starts `std serve` on the test database, serving the built app, on a port
 * the system picks; it ends with the scope.
 *
 * @param databaseUrl - The test database.
 * @param webRoot - The built web app.
 * @returns The server, once it listens.
 */
export const stdServe = Effect.fn("BrowserSupport.stdServe")(function* stdServe(
  databaseUrl: string,
  webRoot: string
) {
  const chunks: string[] = [];

  const keep = (chunk: Uint8Array) => {
    chunks.push(String(chunk));
  };

  const child = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const spawned = spawn(process.execPath, [CLI, "serve"], {
        detached: true,
        env: {
          ...process.env,
          STD_DATABASE_URL: databaseUrl,
          STD_HTTP_HOST: "127.0.0.1",
          STD_HTTP_PORT: "0",
          STD_WEB_ROOT: webRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      spawned.stdout.on("data", keep);
      spawned.stderr.on("data", keep);

      return spawned;
    }),
    endProcessGroup
  );

  const log = () => chunks.join("");

  const origin = yield* Effect.suspend(() => {
    const url = LISTENING.exec(log())?.groups?.url;

    return url === undefined
      ? Effect.fail(new ServerNotListening({ exited: child.exitCode !== null }))
      : Effect.succeed(url);
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("200 millis"),
      times: LISTEN_POLLS,
      while: (failure) => !failure.exited,
    }),
    Effect.mapError(
      () => new Error(`std serve did not start listening:\n${log()}`)
    ),
    Effect.orDie
  );

  return { log, origin } satisfies StdServer;
});

/** The DejaVu fonts of the `dejavu-fonts-ttf` dev dependency. */
const TEST_FONTS = fileURLToPath(
  new URL("../../node_modules/dejavu-fonts-ttf/ttf", import.meta.url)
);

/**
 * A fontconfig file of its own for the browser: the system's configuration
 * where there is one, plus the DejaVu fonts of a pinned dev dependency.
 * Without any font (no `/etc/fonts` and no font files, as on minimal
 * machines) Chromium's headless shell aborts (Skia's
 * `SkFontMgr_FontConfigInterface` "Not implemented") as soon as a layout
 * measures text, such as a flex row sized to its content. The file and the
 * font cache live in a directory made for the run and removed with the
 * scope, so nothing is set up by hand and nothing outlives the run.
 *
 * @param cacheDirectory - Where fontconfig may write its cache.
 * @returns The file's text.
 */
const fontConfig = (cacheDirectory: string): string => `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${TEST_FONTS}</dir>
  <cachedir>${cacheDirectory}</cachedir>
</fontconfig>
`;

/** The browser's fontconfig file, in a directory removed with the scope. */
const fontConfigFile = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(tmpdir(), "std-browser-fonts-"));
    const file = path.join(directory, "fonts.conf");

    writeFileSync(file, fontConfig(path.join(directory, "cache")));

    return { directory, file };
  }),
  ({ directory }) =>
    Effect.sync(() => {
      rmSync(directory, { force: true, recursive: true });
    })
).pipe(Effect.map(({ file }) => file));

/** Chromium, headless, with its own fontconfig file, closed with the scope. */
export const launchBrowser = Effect.gen(function* browserWithFonts() {
  const file = yield* fontConfigFile;

  return yield* Effect.acquireRelease(
    Effect.promise(
      async () =>
        await chromium.launch({
          env: { ...process.env, FONTCONFIG_FILE: file },
        })
    ),
    (browser: Browser) =>
      Effect.promise(async () => {
        await browser.close();
      })
  );
});

/**
 * The loopback origin a listening server answers at.
 *
 * @param server - The server.
 * @returns `http://127.0.0.1:<port>`.
 */
const loopbackOrigin = (server: Server): string => {
  const address = server.address();

  const port =
    Predicate.hasProperty(address, "port") && Predicate.isNumber(address.port)
      ? address.port
      : undefined;

  if (port === undefined) {
    throw new TypeError("the server listens on no TCP port");
  }

  return `http://127.0.0.1:${port}`;
};

/**
 * A server on another port of the same host, closed with the scope: the
 * same site as `std serve` (a `SameSite=Strict` cookie still goes along)
 * but another origin. It answers a GET with the page of its path.
 *
 * @param pages - Pages by path, such as `/sign-out`.
 * @returns Its origin.
 */
export const sameSitePages = (pages: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createHttpServer((request, response) => {
        const page = pages[request.url ?? ""];

        response.writeHead(page === undefined ? 404 : 200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(page ?? "");
      });

      server.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<Server>((resume) => {
        server.close(() => {
          resume(Effect.succeed(server));
        });
        server.closeAllConnections();
      })
  ).pipe(Effect.map(loopbackOrigin));

/**
 * The Vite dev server with Foldkit DevTools and its MCP relay, proxying
 * `/api` to `std serve`; closed with the scope.
 *
 * @param apiOrigin - The `std serve` to proxy to.
 * @returns Its origin.
 */
export const viteDevServer = (apiOrigin: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      // NOTE: inside Vitest, Vite's mode would be `test`, in which the
      // Foldkit plugin starts no DevTools MCP relay; this is a developer's
      // dev server.
      const server = await createViteServer({
        configFile: `${APP_DIR}/vite.config.ts`,
        logLevel: "warn",
        mode: "development",
        root: APP_DIR,
        server: {
          host: "127.0.0.1",
          port: 0,
          proxy: { "/api": { target: apiOrigin } },
        },
      });

      return await server.listen();
    }),
    (server) =>
      Effect.promise(async () => {
        await server.close();
      })
  ).pipe(
    Effect.flatMap((server) => {
      const [local] = server.resolvedUrls?.local ?? [];

      return local === undefined
        ? Effect.die(new Error("Vite started without a local URL"))
        : Effect.succeed(new URL(local).origin);
    })
  );

/** Arguments of a DevTools MCP tool. */
export type ToolArguments = Readonly<Record<string, boolean | number | string>>;

/** A JSON value in a JSON-RPC message. */
type JsonRpcValue =
  | boolean
  | number
  | string
  | readonly JsonRpcValue[]
  | JsonRpcObject;

/** A JSON object in a JSON-RPC message. */
interface JsonRpcObject {
  readonly [key: string]: JsonRpcValue;
}

/** A JSON-RPC request or notification to the MCP server. */
interface JsonRpcMessage {
  readonly id?: number;
  readonly method: string;
  readonly params?: JsonRpcObject;
}

/** A client of the DevTools MCP server, as an agent would connect. */
export interface DevToolsMcp {
  /**
   * Calls a tool.
   *
   * @param name - The tool, such as `foldkit_get_model`.
   * @param args - Its arguments.
   * @returns The text of its result (`Error: ...` when it failed).
   */
  readonly callTool: (
    name: string,
    args: ToolArguments
  ) => Effect.Effect<string>;
}

const McpResponse = Schema.Struct({
  id: Schema.Number,
  result: Schema.optionalKey(
    Schema.Struct({
      content: Schema.optionalKey(
        Schema.Array(Schema.Struct({ text: Schema.String }))
      ),
    })
  ),
});

const decodeMcpResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(McpResponse)
);

/**
 * Starts the DevTools MCP server (stdio, the default per-user relay
 * registry, from the app's directory) and initializes a session; it ends
 * with the scope.
 */
export const devToolsMcp = Effect.gen(function* startDevToolsMcp() {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, [DEVTOOLS_MCP], {
        cwd: APP_DIR,
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      })
    ),
    endProcessGroup
  );

  const waiting = new Map<number, (text: string) => void>();
  let lastId = 0;

  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = decodeMcpResponse(line);

    if (response._tag === "Some") {
      const texts = response.value.result?.content ?? [];

      waiting.get(response.value.id)?.(texts.map((part) => part.text).join(""));
      waiting.delete(response.value.id);
    }
  });

  const send = (message: JsonRpcMessage) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const request = (method: string, params: JsonRpcObject) =>
    Effect.callback<string>((resume) => {
      lastId += 1;
      waiting.set(lastId, (text) => {
        resume(Effect.succeed(text));
      });
      send({ id: lastId, method, params });
    });

  yield* request("initialize", {
    capabilities: {},
    clientInfo: { name: "std-browser-tests", version: "0" },
    protocolVersion: "2025-06-18",
  });

  send({ method: "notifications/initialized" });

  return {
    callTool: (name, args) => request("tools/call", { arguments: args, name }),
  } satisfies DevToolsMcp;
});

/**
 * Calls a DevTools MCP tool until it answers: the dev server publishes its
 * relay, and the page connects to it, a moment after they start.
 *
 * @param mcp - The client.
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns The first answer that is not an error.
 */
export const callWhenConnected = (
  mcp: DevToolsMcp,
  name: string,
  args: ToolArguments
) =>
  mcp.callTool(name, args).pipe(
    Effect.filterOrFail(
      (text) => !text.startsWith("Error:"),
      (text) => new Error(text)
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
    Effect.orDie
  );
