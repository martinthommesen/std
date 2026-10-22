/**
 * The web app's files (decision 0018): `std serve` serves the built app
 * (`apps/web`, `pnpm --filter @std/web build`) at `/`, beside the API
 * under `/api/v1`.
 *
 * - `STD_WEB_ROOT` names the build directory; the default is this
 *   checkout's `apps/web/dist`. Without an `index.html` there the server
 *   serves the API only and logs how to build the app.
 * - A GET for an existing file serves it; a GET for any other path without
 *   an extension that accepts HTML gets `index.html`, so the app's client
 *   routes load on a reload or a deep link. Paths under `/api/` are never
 *   files: an unknown API path stays a plain `404`, as before.
 * - Hashed build assets (`/assets/...`) are cached for a year; everything
 *   else is revalidated on every load, so a new build is picked up.
 * - Every file carries a strict Content-Security-Policy (scripts, styles
 *   and connections from this origin only, no framing) and `nosniff`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Config, Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
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

const ASSETS_PREFIX = "/assets/";

/**
 * The cache policy of a served path: Vite's hashed assets never change.
 *
 * @param url - The request URL.
 * @returns The `Cache-Control` value.
 */
const cacheControlOf = (url: string): string =>
  url.startsWith(ASSETS_PREFIX) ? IMMUTABLE : REVALIDATE;

/**
 * The route that serves the built app from a directory.
 *
 * @param root - The build directory, holding `index.html`.
 * @returns The router layer.
 */
export const webAppRoutes = (root: string) =>
  Layer.unwrap(
    Effect.gen(function* buildWebAppRoutes() {
      const serveFile = yield* HttpStaticServer.make({ root, spa: true });

      const handler = (request: HttpServerRequest) =>
        (request.url.startsWith(API_PREFIX)
          ? Effect.fail(
              new HttpServerError.HttpServerError({
                reason: new HttpServerError.RouteNotFound({ request }),
              })
            )
          : serveFile.pipe(
              Effect.map((response) =>
                HttpServerResponse.setHeaders(response, {
                  ...WEB_APP_HEADERS,
                  "cache-control": cacheControlOf(request.url),
                })
              )
            )
        ).pipe(
          Effect.catchTag("HttpServerError", HttpServerRespondable.toResponse)
        );

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

    const built = yield* Effect.sync(() =>
      existsSync(path.join(root, "index.html"))
    );

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
