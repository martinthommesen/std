/**
 * The web app's files (`web-app.ts`, decision 0018): only files whose real
 * path lies inside the real web root are served. Symlinks out of the root
 * (to a file, to a directory, as the root's own `index.html`) and every
 * spelling of traversal (`..`, percent-encoded dots and slashes,
 * backslashes, NUL) get the same empty `404` as a missing file. Requests go
 * over a real socket, so raw paths reach the server unnormalized.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterAll } from "vitest";

import { WEB_APP_HEADERS, webAppRoutes } from "../src/http/web-app.ts";

const SECRET = "OUTSIDE-SECRET";

const OUTSIDE_INDEX = "OUTSIDE-INDEX";

const APP = "<app>";

const temporary = mkdtempSync(path.join(tmpdir(), "std-web-app-"));

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const outside = path.join(temporary, "outside");

write(path.join(outside, "secret.txt"), SECRET);

write(path.join(outside, "index.html"), OUTSIDE_INDEX);

/** A root with symlinks out of it, and one that stays inside. */
const root = path.join(temporary, "root");

write(path.join(root, "index.html"), APP);

write(path.join(root, "assets", "app.js"), "app();");

symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));

symlinkSync(outside, path.join(root, "linked"));

symlinkSync(path.join(root, "assets", "app.js"), path.join(root, "inner.js"));

/** A root whose own `index.html` is a symlink out of it. */
const linkedIndexRoot = path.join(temporary, "linked-index-root");

mkdirSync(linkedIndexRoot, { recursive: true });

symlinkSync(
  path.join(outside, "index.html"),
  path.join(linkedIndexRoot, "index.html")
);

/** A response as received. */
interface Received {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Sends a GET with this exact request target.
 *
 * @param port - The server's port.
 * @param target - The raw path, sent as is.
 * @param accept - The `Accept` header.
 * @returns The response.
 */
const rawGet = (port: number, target: string, accept = "text/html") =>
  Effect.callback<Received>((resume) => {
    const outgoing = request(
      {
        headers: { accept },
        host: "127.0.0.1",
        method: "GET",
        path: target,
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resume(
            Effect.succeed({
              body: Buffer.concat(chunks).toString("utf-8"),
              headers: response.headers,
              status: response.statusCode ?? 0,
            })
          );
        });
      }
    );

    outgoing.on("error", (error) => {
      resume(Effect.die(error));
    });
    outgoing.end();
  });

/**
 * Serves a web root on a free port for the scope.
 *
 * @param webRoot - The directory.
 * @returns The port.
 */
const serving = (webRoot: string) =>
  Effect.gen(function* serveWebRoot() {
    const server = yield* Layer.build(
      HttpRouter.serve(webAppRoutes(webRoot), { disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
        )
      )
    );

    const { address } = yield* HttpServer.HttpServer.pipe(
      Effect.provide(server)
    );

    return address._tag === "UnixPathAddress" ? 0 : address.port;
  });

/**
 * Asserts a refusal: the empty 404 of a missing file, naming nothing.
 *
 * @param received - The response.
 * @param target - The request path, for the message.
 */
const assertNotFound = (received: Received, target: string) => {
  assert.strictEqual(received.status, 404, target);
  assert.strictEqual(received.body, "", target);
  assert.notInclude(JSON.stringify(received.headers), "outside", target);
};

describe("web-app", () => {
  afterAll(() => {
    rmSync(temporary, { force: true, recursive: true });
  });

  it("the app's files forbid framing, plugins, foreign sources and sniffing", () => {
    assert.include(
      WEB_APP_HEADERS["content-security-policy"],
      "default-src 'self'"
    );
    assert.include(
      WEB_APP_HEADERS["content-security-policy"],
      "frame-ancestors 'none'"
    );
    assert.include(
      WEB_APP_HEADERS["content-security-policy"],
      "object-src 'none'"
    );
    assert.strictEqual(WEB_APP_HEADERS["x-content-type-options"], "nosniff");
    assert.strictEqual(WEB_APP_HEADERS["x-frame-options"], "DENY");
  });

  it.effect(
    "serves the app's files, a symlink inside the root and client routes",
    () =>
      Effect.gen(function* servesInside() {
        const port = yield* serving(root);

        const index = yield* rawGet(port, "/");
        const asset = yield* rawGet(port, "/assets/app.js", "*/*");
        const inner = yield* rawGet(port, "/inner.js", "*/*");
        const clientRoute = yield* rawGet(port, "/tables/acme.asset");

        assert.strictEqual(index.status, 200);
        assert.strictEqual(index.body, APP);
        assert.strictEqual(index.headers["cache-control"], "no-cache");
        assert.include(
          index.headers["content-security-policy"],
          "default-src 'self'"
        );
        assert.strictEqual(asset.body, "app();");
        assert.strictEqual(
          asset.headers["cache-control"],
          "public, max-age=31536000, immutable"
        );
        assert.strictEqual(inner.body, "app();");
        assert.strictEqual(clientRoute.body, APP);
      })
  );

  it.effect(
    "refuses symlinks out of the root: a file, a directory and its index",
    () =>
      Effect.gen(function* symlinks() {
        const port = yield* serving(root);

        for (const [target, accept] of [
          ["/leak.txt", "*/*"],
          ["/leak.txt", "text/html"],
          ["/linked/secret.txt", "*/*"],
          ["/linked/index.html", "text/html"],
          ["/linked/", "text/html"],
          ["/linked", "text/html"],
        ] as const) {
          assertNotFound(yield* rawGet(port, target, accept), target);
        }
      })
  );

  it.effect(
    "refuses an index.html that is a symlink out of the root, as the fallback too",
    () =>
      Effect.gen(function* linkedIndex() {
        const port = yield* serving(linkedIndexRoot);

        for (const target of ["/", "/index.html", "/some/client/route"]) {
          const received = yield* rawGet(port, target);

          assertNotFound(received, target);
          assert.notInclude(received.body, OUTSIDE_INDEX, target);
        }
      })
  );

  it.effect("refuses traversal however it is spelled", () =>
    Effect.gen(function* traversal() {
      const port = yield* serving(root);

      for (const target of [
        "/../outside/secret.txt",
        "/assets/../../outside/secret.txt",
        "/%2e%2e/outside/secret.txt",
        "/%2e%2e%2foutside%2fsecret.txt",
        "/assets%2f..%2f..%2foutside%2fsecret.txt",
        "/..%5coutside%5csecret.txt",
        "/..\\outside\\secret.txt",
        "/assets\\app.js",
        "/index.html%00.txt",
        "/%00",
        "/%E0%A4%A",
      ]) {
        for (const accept of ["*/*", "text/html"]) {
          const received = yield* rawGet(port, target, accept);

          assert.notInclude(received.body, SECRET, target);
          assertNotFound(received, `${target} (${accept})`);
        }
      }
    })
  );

  it.effect("leaves API paths to the API", () =>
    Effect.gen(function* apiPaths() {
      const port = yield* serving(root);

      assertNotFound(yield* rawGet(port, "/api/v1/nothing"), "/api/v1/nothing");
    })
  );
});
