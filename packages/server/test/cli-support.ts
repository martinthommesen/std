/**
 * Running the `std` command in a child process from tests.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Duration, Effect, Schema } from "effect";

const CLI_SCRIPT = fileURLToPath(
  new URL("../src/cli/main.ts", import.meta.url)
);

/** The output and exit code of one `std` command. */
export interface CliResult {
  readonly code: number | null;
  /** Standard output only. */
  readonly stdout: string;
  /** Standard output and standard error, interleaved. */
  readonly output: string;
}

/**
 * Kills a child process and waits until it has exited.
 * @param child - The child.
 * @returns Succeeds once the child is gone.
 */
export const killAndAwait = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback<boolean>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(true));

      return;
    }

    const done = () => {
      resume(Effect.succeed(true));
    };

    child.once("exit", done);
    child.once("error", done);
    child.kill("SIGKILL");
  }).pipe(Effect.asVoid);

/** `std serve` exited, or did not listen in time; its log is attached. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class ServeNotListening extends Schema.TaggedError<
  ServeNotListening,
  { readonly brand: unique symbol }
>()("ServeNotListening", { log: Schema.String }) {}

/** A running `std serve` process. */
export interface ServeProcess {
  /** Its origin, such as `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** The OS process. */
  readonly child: ChildProcess;
  /** What it has logged so far. */
  readonly log: () => string;
}

/** The line `std serve` logs once it listens (Effect's HTTP server). */
const LISTENING = /Listening on (?<origin>http:\/\/[\d.:]+)/u;

/** How long `std serve` may take to start listening. */
const LISTEN_TIMEOUT = Duration.seconds(60);

const listeningOrigin = (child: ChildProcess, log: () => string) =>
  Effect.callback<string, ServeNotListening>((resume) => {
    const check = () => {
      const origin = LISTENING.exec(log())?.groups?.origin;

      if (origin !== undefined) {
        resume(Effect.succeed(origin));
      }
    };

    const exited = () => {
      resume(Effect.fail(new ServeNotListening({ log: log() })));
    };

    child.stdout?.on("data", check);
    child.stderr?.on("data", check);
    child.once("exit", exited);
    check();

    if (child.exitCode !== null || child.signalCode !== null) {
      exited();
    }

    return Effect.sync(() => {
      child.stdout?.off("data", check);
      child.stderr?.off("data", check);
      child.off("exit", exited);
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: LISTEN_TIMEOUT,
      orElse: () => Effect.fail(new ServeNotListening({ log: log() })),
    })
  );

/**
 * Starts `std serve` on a port the system picks, against a database, and
 * waits until it listens. The process belongs to the scope: closing the
 * scope, on success, failure or interruption, kills it and waits for it
 * to exit.
 * @param url - The database.
 * @returns The running server.
 */
export const startServe = (url: string) =>
  Effect.gen(function* startServeProcess() {
    const chunks: string[] = [];
    const log = () => chunks.join("");

    const keep = (chunk: Uint8Array) => {
      chunks.push(String(chunk));
    };

    const child = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const spawned = spawn(process.execPath, [CLI_SCRIPT, "serve"], {
          env: {
            ...process.env,
            STD_DATABASE_DIRECT_URL: url,
            STD_DATABASE_URL: url,
            STD_HTTP_HOST: "127.0.0.1",
            STD_HTTP_PORT: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        spawned.stdout.on("data", keep);
        spawned.stderr.on("data", keep);

        return spawned;
      }),
      killAndAwait
    );

    const origin = yield* listeningOrigin(child, log);

    const server: ServeProcess = { child, log, origin };

    return server;
  });

/**
 * Runs `std <args>` against a database. Interrupting it kills the command
 * and waits for it to exit.
 * @param url - The database.
 * @param args - The command line.
 * @param env - Further environment variables.
 * @returns Exit code and output.
 */
export const runCli = (
  url: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {}
) =>
  Effect.callback<CliResult>((resume) => {
    const child = spawn(process.execPath, [CLI_SCRIPT, ...args], {
      env: {
        ...process.env,
        STD_DATABASE_DIRECT_URL: url,
        ...env,
        STD_DATABASE_URL: url,
      },
    });

    const chunks: string[] = [];
    const out: string[] = [];

    child.stdout.on("data", (chunk: Uint8Array) => {
      chunks.push(String(chunk));
      out.push(String(chunk));
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      chunks.push(String(chunk));
    });
    child.once("error", (error) => {
      resume(Effect.die(error));
    });
    child.on("close", (code) => {
      resume(
        Effect.succeed({ code, output: chunks.join(""), stdout: out.join("") })
      );
    });

    return killAndAwait(child);
  });
