/**
 * The web app's files (decision 0018): `std serve` serves the built app
 * (`apps/web`, `pnpm --filter @std/web build`) at `/`, beside the API
 * under `/api/v1`.
 *
 * - `STD_WEB_ROOT` names the build directory; the default is this
 *   checkout's `apps/web/dist`. Without an `index.html` there the server
 *   serves the API only and logs how to build the app.
 * - A GET for an existing file serves it; a navigation (it accepts HTML)
 *   to any missing path gets `index.html`, so the app's client
 *   routes load on a reload or a deep link. Paths under `/api/` are never
 *   files: an unknown API path stays a plain `404`, as before.
 * - Only files whose real path lies inside the real web root are served.
 *   The request path is decoded once; one with a NUL or a backslash, one
 *   that resolves outside the root, or one whose `realpath` (symlinks
 *   followed) lies outside it, gets an empty
 *   `404` naming nothing, never the client-route fallback. A directory's
 *   `index.html` and the client-route
 *   fallback are checked the same way, so a symlinked `index.html` that
 *   points outside the root is refused too.
 * - Hashed build assets (`/assets/...`) are cached for a year; everything
 *   else is revalidated on every load, so a new build is picked up.
 * - Every file carries a strict Content-Security-Policy (scripts, styles
 *   and connections from this origin only, no framing) and `nosniff`.
 */
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Config, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

/** This checkout's web build, used when `STD_WEB_ROOT` is not set. */
export const DEFAULT_WEB_ROOT = fileURLToPath(
  new URL("../../../../apps/web/dist", import.meta.url)
);

/** The headers of every file the web app is served from. */
export const WEB_APP_HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const IMMUTABLE = "public, max-age=31536000, immutable";

const REVALIDATE = "no-cache";

const API_PREFIX = "/api/";

const ASSETS_DIRECTORY = "assets/";

const INDEX = "index.html";

/** Content types of the files a Vite build writes, by extension. */
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
]);

/** What a request path names inside the web root. */
type Resolution =
  | { readonly _tag: "File"; readonly file: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Refused" };

const missing: Resolution = { _tag: "Missing" };

/** Outside the root, by path or through a symlink: never a client route. */
const refused: Resolution = { _tag: "Refused" };

/**
 * A refusal: the same empty 404 as a missing file.
 *
 * @returns The response.
 */
const notFound = () => HttpServerResponse.empty({ status: 404 });

/**
 * Whether a path is the root or inside it.
 *
 * @param root - A canonical directory.
 * @param candidate - An absolute path.
 * @returns Whether it lies within.
 */
const isWithin = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

/**
 * The request path, decoded once, relative to the root.
 *
 * @param url - The request URL (path and query).
 * @returns The relative path, or `None` for one that does not decode or
 *   holds a NUL or a backslash.
 */
const requestPath = (url: string): Option.Option<string> => {
  const [pathname = ""] = url.split(/[?#]/u, 1);

  return Option.liftThrowable(decodeURIComponent)(pathname).pipe(
    Option.filter((decoded) => !/[\0\\]/u.test(decoded)),
    Option.map((decoded) => decoded.replace(/^\/+/u, ""))
  );
};

const realPathOf = (file: string) =>
  Effect.option(Effect.tryPromise(async () => await realpath(file)));

const statOf = (file: string) =>
  Effect.option(Effect.tryPromise(async () => await stat(file)));

/**
 * Resolves a path to a regular file whose real path lies inside the real
 * root; a directory resolves to its `index.html`, checked the same way.
 * Anything else, escapes included, is missing.
 *
 * @param root - The canonical web root.
 * @param candidate - The absolute path asked for.
 * @returns The file's real path, or missing.
 */
const resolveFile = (
  root: string,
  candidate: string
): Effect.Effect<Resolution> =>
  Effect.gen(function* resolveWebFile() {
    if (!isWithin(root, candidate)) {
      return refused;
    }

    const maybeReal = yield* realPathOf(candidate);

    if (Option.isNone(maybeReal)) {
      return missing;
    }

    if (!isWithin(root, maybeReal.value)) {
      return refused;
    }

    const maybeInfo = yield* statOf(maybeReal.value);

    if (Option.isNone(maybeInfo)) {
      return missing;
    }

    if (maybeInfo.value.isDirectory()) {
      return yield* resolveFile(root, path.join(maybeReal.value, INDEX));
    }

    return maybeInfo.value.isFile()
      ? ({ _tag: "File", file: maybeReal.value } satisfies Resolution)
      : missing;
  });

/**
 * A file's response with the web app's headers.
 *
 * @param file - The file's real path.
 * @param cacheControl - Its `Cache-Control`.
 * @returns The response; an empty 404 if it cannot be read.
 */
const fileResponse = (file: string, cacheControl: string) =>
  HttpServerResponse.file(file, {
    contentType:
      CONTENT_TYPES.get(path.extname(file).toLowerCase()) ??
      "application/octet-stream",
  }).pipe(
    Effect.map((response) =>
      HttpServerResponse.setHeaders(response, {
        ...WEB_APP_HEADERS,
        "cache-control": cacheControl,
      })
    ),
    Effect.orElseSucceed(notFound)
  );

/**
 * Whether a request for a missing file may get `index.html`: a navigation,
 * which accepts HTML. Paths may contain dots (`/tables/acme.asset`), so
 * the extension decides nothing.
 *
 * @param request - The request.
 * @returns Whether to fall back.
 */
const isNavigation = (request: HttpServerRequest) =>
  (request.headers.accept ?? "").includes("text/html");

/**
 * The route that serves the built app from a directory.
 *
 * @param root - The build directory, holding `index.html`.
 * @returns The router layer.
 */
export const webAppRoutes = (root: string) =>
  Layer.unwrap(
    Effect.gen(function* buildWebAppRoutes() {
      const realRoot = yield* Effect.orDie(
        Effect.tryPromise(async () => await realpath(root))
      );

      const serve = (request: HttpServerRequest, relative: string) =>
        Effect.gen(function* serveWebFile() {
          const resolved = yield* resolveFile(
            realRoot,
            path.resolve(realRoot, relative)
          );

          if (resolved._tag === "File") {
            return yield* fileResponse(
              resolved.file,
              relative.startsWith(ASSETS_DIRECTORY) ? IMMUTABLE : REVALIDATE
            );
          }

          if (resolved._tag === "Refused" || !isNavigation(request)) {
            return notFound();
          }

          const index = yield* resolveFile(
            realRoot,
            path.join(realRoot, INDEX)
          );

          return index._tag === "File"
            ? yield* fileResponse(index.file, REVALIDATE)
            : notFound();
        });

      const handler = (request: HttpServerRequest) =>
        request.url.startsWith(API_PREFIX)
          ? Effect.succeed(notFound())
          : Option.match(requestPath(request.url), {
              onNone: () => Effect.succeed(notFound()),
              onSome: (relative) => serve(request, relative),
            });

      return HttpRouter.add("GET", "/*", handler);
    })
  );

/**
 * The web app's route, when `STD_WEB_ROOT` (or the default) holds a build;
 * otherwise nothing, with a log line saying how to build it.
 */
export const WebAppLayer = Layer.unwrap(
  Effect.gen(function* findWebApp() {
    const root = yield* Config.String("STD_WEB_ROOT").pipe(
      Config.withDefault(DEFAULT_WEB_ROOT)
    );

    const built = yield* Effect.sync(() => existsSync(path.join(root, INDEX)));

    if (!built) {
      yield* Effect.logWarning(
        `No web app build at ${root}; serving the API only. Build it with: pnpm --filter @std/web build`
      );

      return Layer.empty;
    }

    yield* Effect.logInfo(`Serving the web app from ${root}`);

    return webAppRoutes(root);
  })
);
