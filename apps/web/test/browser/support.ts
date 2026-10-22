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
import type { Browser, BrowserContext, Page } from "playwright";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";

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

/**
 * How much slower than the machine every page's CPU runs:
 * `STD_BROWSER_CPU_THROTTLE` (such as `4`), for Chromium's
 * `Emulation.setCPUThrottlingRate`. Slow pages bring out races between the
 * tests and the page that a fast machine hides (decision 0020, "CI:
 * deterministic response capture"). Unset, or 1 and below: full speed.
 *
 * @returns The rate.
 */
const cpuThrottleRate = (): number => {
  const rate = Number(process.env.STD_BROWSER_CPU_THROTTLE ?? "1");

  return Number.isFinite(rate) && rate > 1 ? rate : 1;
};

/**
 * Slows a page's CPU.
 *
 * @param page - The page.
 * @param rate - The slowdown factor.
 * @returns Nothing, once the page is slowed (or closed meanwhile).
 */
const throttlePage = async (page: Page, rate: number): Promise<void> => {
  try {
    const session = await page.context().newCDPSession(page);

    await session.send("Emulation.setCPUThrottlingRate", { rate });
  } catch {
    // The page closed before it could be slowed.
  }
};

/**
 * Makes every page of the browser's new contexts run slower, when
 * `STD_BROWSER_CPU_THROTTLE` asks for it.
 *
 * @param browser - The browser.
 * @returns The same browser.
 */
const withCpuThrottle = (browser: Browser): Browser => {
  const rate = cpuThrottleRate();

  if (rate === 1) {
    return browser;
  }

  const newContext = browser.newContext.bind(browser);

  browser.newContext = async (
    ...options: Parameters<Browser["newContext"]>
  ): Promise<BrowserContext> => {
    const context = await newContext(...options);

    context.on("page", (page) => {
      void throttlePage(page, rate);
    });

    return context;
  };

  return browser;
};

/**
 * Chromium, headless, with its own fontconfig file, closed with the scope;
 * its pages slowed when `STD_BROWSER_CPU_THROTTLE` asks for it.
 */
export const launchBrowser = Effect.gen(function* browserWithFonts() {
  const file = yield* fontConfigFile;

  return yield* Effect.acquireRelease(
    Effect.promise(async () =>
      withCpuThrottle(
        await chromium.launch({
          env: { ...process.env, FONTCONFIG_FILE: file },
        })
      )
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
 * Warms the Vite dev server's client module graph and waits for its
 * dependency pre-bundling to commit before the browser navigates to it, so
 * the first `page.goto` does not race Playwright's navigation timeout
 * against a cold transform and optimizer run.
 *
 * @param server - A listening Vite dev server.
 * @returns Nothing, once the entry graph and optimized deps are ready.
 */
const warmViteServer = (server: ViteDevServer) =>
  Effect.promise(async () => {
    await server.warmupRequest("/@vite/client");
    await server.warmupRequest("virtual:foldkit-devtools-overlay");
    await server.warmupRequest("/src/entry.ts");
    await server.waitForRequestsIdle();

    const optimizer = server.environments.client.depsOptimizer;

    await optimizer?.scanProcessing;
    await Promise.all(
      (optimizer?.metadata.depInfoList ?? []).flatMap((dep) =>
        dep.processing === undefined ? [] : [dep.processing]
      )
    );
  });

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
    Effect.tap(warmViteServer),
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

const decodeRuntimeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ currentIndex: Schema.Int, startIndex: Schema.Int })
  )
);

/** The largest page of Message history the MCP server lists. */
const LARGEST_HISTORY_PAGE = 500;

// NOTE: the MCP server writes the runtime's response as JSON, an Option
// as Effect's own JSON (`{ "_tag": "Some", "value": 7 }`).
const decodeMessagesPage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      maybeNextIndex: Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("None") }),
        Schema.Struct({ _tag: Schema.Literal("Some"), value: Schema.Int }),
      ]),
    })
  )
);

/**
 * Every Message history entry from an index on, page by page.
 *
 * @param mcp - The client.
 * @param fromIndex - The first absolute history index.
 * @returns The text of each page.
 */
const historyFrom = (
  mcp: DevToolsMcp,
  fromIndex: number
): Effect.Effect<readonly string[]> =>
  callWhenConnected(mcp, "foldkit_list_messages", {
    limit: LARGEST_HISTORY_PAGE,
    since_index: fromIndex,
  }).pipe(
    Effect.flatMap((text) => {
      const next = decodeMessagesPage(text).maybeNextIndex;

      return next._tag === "Some" && next.value > fromIndex
        ? historyFrom(mcp, next.value).pipe(
            Effect.map((rest) => [text, ...rest])
          )
        : Effect.succeed([text]);
    })
  );

/** What the DevTools of the connected runtime recorded. */
export interface DevToolsRecord {
  /** The Model now, the initial Model and the Messages, as JSON text. */
  readonly text: string;
  /** The history index after the last Message read. */
  readonly nextIndex: number;
}

/**
 * Reads what DevTools holds for the connected runtime: the current Model
 * in full, the initial Model with its Commands, and every Message history
 * entry (payloads, Commands and their arguments) from an index on. Fails
 * when the rolling history already dropped an entry from that index on,
 * which would then go unread.
 *
 * @param mcp - The client.
 * @param fromIndex - The first history index not read before (0 at first).
 * @returns The text and where the next read starts.
 */
export const devToolsRecord = Effect.fn("BrowserSupport.devToolsRecord")(
  function* devToolsRecord(mcp: DevToolsMcp, fromIndex: number) {
    const state = decodeRuntimeState(
      yield* callWhenConnected(mcp, "foldkit_get_runtime_state", {})
    );

    if (state.startIndex > fromIndex) {
      return yield* Effect.die(
        new Error(
          `DevTools dropped history entries ${fromIndex} to ${state.startIndex - 1} before they were read`
        )
      );
    }

    const model = yield* callWhenConnected(mcp, "foldkit_get_model", {
      expand: true,
    });

    const init = yield* callWhenConnected(mcp, "foldkit_get_init", {});

    const history =
      fromIndex > state.currentIndex ? [] : yield* historyFrom(mcp, fromIndex);

    return {
      nextIndex: state.currentIndex + 1,
      text: [model, init, ...history].join("\n"),
    } satisfies DevToolsRecord;
  }
);
