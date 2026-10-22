# 0018. The web foundation: Foldkit on Effect 4.0.5, cookie sessions with a CSRF header, serving, browser tests

Status: accepted, 2026-10-22 (workstream `ws/2b-web-foundation`, the start of Step 2B). Code: `apps/web/`, `packages/api/src/{session-cookie,authentication,auth,session,client}.ts`, `packages/server/src/http/{session-cookie,authentication,handlers,web-app,serve,schema-revision-header}.ts`, `packages/server/src/auth/sessions.ts`, `pnpm-workspace.yaml`, `patches/@foldkit__vite-plugin@0.28.0.patch`, `tooling/lib/{profiles,vendor}.ts`, `.mcp.json`, `.codex/config.toml`, `.github/workflows/ci.yml`, `docker/quickstart.Dockerfile`. Tests: `packages/server/test/{session-cookie,authz-paths,stale-paths}.test.ts`, `apps/web/src/**/{story,scene}.test.ts`, `apps/web/test/browser/shell.test.ts`.

## Foldkit on Effect 4.0.5

Foldkit 0.169.0 pins Effect 4.0.0 exactly; STD stays on 4.0.5 (AGENTS.md, "Effect version"). The bridge, all in `pnpm-workspace.yaml`:

- **Peers.** `peerDependencyRules.allowedVersions` accepts 4.0.5 for `effect` as a peer of `foldkit`, `@foldkit/ui`, `@foldkit/devtools`, `@foldkit/devtools-mcp` and `@foldkit/vite-plugin`, and for `@effect/platform-browser` as a peer of `foldkit` and `@foldkit/devtools`. `@effect/platform-browser` joins the catalog at 4.0.5.
- **Hard dependencies.** `overrides` resolve `@foldkit/vite-plugin`'s `@effect/platform-node` and `@effect/platform-node-shared` (pinned 4.0.0) to 4.0.5.
- **One copy.** `check-lockfile` still finds exactly one `effect` and one of each `@effect/*`, all 4.0.5, and `tsc`'s `duplicatePackage` stays an error. `check-vendor` now requires `foldkit` in the lockfile (`requiredInLockfile: true`), at the vendored tag.
- **One break, patched.** Effect 4.0.1 turned `Crypto.randomUUIDv4` from an Effect into a function (Effect PR #8935). `@foldkit/vite-plugin` 0.28.0 reads it as an Effect (`crypto.randomUUIDv4.pipe(...)`), so under 4.0.5 the fiber that starts the DevTools MCP relay died at start, silently: the dev server ran, DevTools showed the Model, and no MCP client could ever connect. `patches/@foldkit__vite-plugin@0.28.0.patch` (pnpm `patchedDependencies`) adds the call. The browser test "the DevTools record" fails without it.
- **Nothing else breaks.** Every API change in the Effect, platform-browser and platform-node changelogs from 4.0.1 to 4.0.5 was checked against the built code of the five Foldkit packages: the Crypto call is the only break. The rest is either unused by Foldkit or compatible (tagged-union `tag` property, safe-integer bounds in JSON Schema, `bigint` file info, `Path.resolveWithin`, `Effect.cached` and interruption, type-only `Match` changes). All 326 modules of foldkit, `@foldkit/ui`, `@foldkit/devtools` and the patched plugin load under 4.0.5.
- **One bundled copy.** `@foldkit/devtools-mcp`'s `dist/server.js` is a self-contained bundle with its own Effect 4.0.0 and platform-node 4.0.0. It is a development-only stdio process, outside the app's module graph and invisible to the lockfile check; the installed 4.0.5 never reaches it.
- **Proof.** The 51 story and scene tests drive `update` and the views on 4.0.5 (and run the Commands against a fake server through the real typed client); the browser tests run the built app (and, for DevTools, the dev server) on 4.0.5.
- **The web profile** allows `@effect/platform-browser` (reason in decision 0001).

Drop the rules, the overrides and the patch together as soon as Foldkit releases on Effect 4.0.5 or later.

## Cookie sessions

- **Sign-in.** `POST /api/v1/auth/cookie-sign-in` (`cookieSignIn` in the `signIn` group) takes the same body as `sign-in` and creates the same session: 32 random bytes, only its SHA-256 stored. The token goes into `Set-Cookie: std_session=...; Path=/api/v1; Expires=<session expiry>; HttpOnly; SameSite=Strict[; Secure]`, and the body is `{ expiresAt, userId }`, with no token, so no page script ever reads one. A separate endpoint, rather than a header that changes what `sign-in` returns, keeps the bearer contract (`SignInResponse` with `token`) unchanged.
- **Secure.** `STD_SESSION_COOKIE_SECURE`: `auto` (default) sets `Secure` unless the request's `Host` is a loopback name (`localhost`, `127.0.0.0/8`, `[::1]`), where `std serve` is reached over plain HTTP (the quickstart, the Vite proxy, the browser tests). A proxy that terminates TLS for a public name forwards that name, so the cookie is `Secure` there. `always` is for a proxy that forwards a loopback `Host`; `never` only for plain HTTP on a non-loopback address, where browsers drop `Secure` cookies. The setting is a `Context.Reference` defaulting to `auto`; `std serve` reads it from the environment.
- **Path.** `/api/v1`: the cookie never goes with a request for the app's pages or assets.
- **Authentication.** The `Authentication` middleware has two security schemes, tried in order: the bearer token, then the cookie (`HttpApiSecurity.apiKey({ in: "cookie" })`). A request with a bearer token is authenticated by it, whatever cookie it carries, so bearer clients behave exactly as before. The token from either is checked in the request transaction as before (`authenticate`).
- **Sign-out** ends the session presented. When that was the cookie, the response clears it (`Max-Age=0`, same path); a bearer sign-out sets no cookie.
- **`auth/me`** now returns the user's display name (`core.user.name`, which every active user may read under the built-in rule), for the shell's "Signed in as". Contracts 6.1 says so.

## CSRF: a required custom header

Decision: a request authenticated by the cookie whose method is not GET, HEAD or OPTIONS must carry `STD-Client: web`; without it the cookie is not a credential and the response is `401 Unauthenticated`. The cookie sign-in requires the header too (a declared header, so its absence is `400 InvalidRequest`), so a page elsewhere cannot sign the browser in to an account of the attacker's choosing. The web app's client sends the header on every request (`makeStdClient({ webClient: true })`).

Why a header and not a strict `Origin` check:

- A page on another origin cannot attach a custom header to a form post, and `fetch` with one needs a CORS preflight, which STD never approves (it sends no CORS headers). That holds whatever the deployment looks like.
- An `Origin` check needs the server to know its own public origin. Behind a TLS-terminating proxy, a path prefix or the Vite dev proxy, `Host` and scheme are rewritten, so it needs configuration (or trusting `X-Forwarded-*`) that a quickstart does not have, and a wrong value either locks users out or lets forgeries through. Some requests also arrive without `Origin`.
- The header costs the app nothing: every request goes through the typed client.

`SameSite=Strict` already keeps the cookie off cross-site requests. The header is what stops a same-site one: a page on another port of the same host, or on a sibling subdomain, is the same site, so the browser sends the cookie. The browser test proves exactly that case. Safe methods need no header: they change nothing, and the same-origin policy keeps another origin from reading the response. No new error tag: a refused cookie is an absent credential, so `Unauthenticated` (Contracts 3.8 updated).

Tests: `session-cookie.test.ts` (attributes per `Host`, no token in the body, the JSON-in-`text/plain` cross-site form post and a forged sign-out refused with nothing written, sign-out, bearer precedence); `authz-paths` runs every read, write and definition path through the cookie as well as the bearer token, with identical outcomes, and runs every write and definition path through the cookie without the header (every unsafe one `401`, nothing delivered or committed); `stale-paths` checks every path's revision handling through both, including the cookie sign-in; the browser test posts forms from a same-site page with the cookie attached and gets `401` for a create and a sign-out, the session intact.

## Serving

- `std serve` serves `STD_WEB_ROOT` (default: this checkout's `apps/web/dist`) with `HttpStaticServer` on `GET /*`: existing files as they are, any other extension-less path that accepts HTML as `index.html` (client routes survive a reload or a deep link). Paths under `/api/` never fall through to it, so an unknown API path is the same `404` as before. Without a build it logs how to build one and serves the API alone.
- Every file carries `Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`. Hashed `/assets/` are cached for a year, everything else revalidated.
- `STD-Schema-Revision` is now set on `/api/` responses only (all API responses, errors and unknown API routes included, as before); a static file needs no request transaction.
- Development: `pnpm --filter @std/web dev` runs Vite, which proxies `/api` to `STD_WEB_API_TARGET` (default `http://127.0.0.1:8080`), keeping the browser's `Host`, so the cookie works over plain HTTP.
- The quickstart image builds the app (`pnpm --filter @std/web build`), and compose's `server` serves it at <http://localhost:8080> with no extra setting. `docker compose config --hash postgres` is unchanged.

## The app

- **State.** `CheckingSession` (start-up asks `auth/me`, since a script cannot see the cookie), `SessionUnavailable` (the server did not answer; retry), `SignedOut` (sign-in or not-found; a signed-in page asked for while signed out is kept as `maybeReturnRoute`, so sign-in returns to it, and the redirect's own `ChangedUrl` does not erase it), `SignedIn` (user, page, sign-out state). The Model never holds a token.
- **Routes.** `/` (home), `/sign-in`, everything else `NotFound`. A signed-out visit to a signed-in page redirects to `/sign-in` (`replaceUrl`); a signed-in visit to `/sign-in` redirects home.
- **Sign-in page.** Foldkit UI `Input` and `Button`, `foldkit/fieldValidation` for both fields (`aria-required`), errors linked by `aria-describedby` in a live region, a `role="alert"` for refused credentials, an unreachable server or a session the browser did not keep (the cookie sign-in succeeded but `auth/me` was refused), focus moved to the first field that needs attention. The password is `Schema.Redacted(Schema.String, { disallowJsonEncode: true, label: "password" })` in the Model, its Messages and the `SignIn` Command's arguments (the JSON codec refuses it), unwrapped with `Redacted.value` only where the request is built. The input is uncontrolled, so the raw text is never rendered from the Model; leaving or entering the page forgets the password, since the remounted input is empty.
- **Focus.** When another page replaces the current one (a route change, sign-in, sign-out), focus moves to its `main`, so keyboard and screen-reader users start there; a failed retry is announced by the alert it mounts.
- **Shell.** Header with the brand link, Foldkit UI `Nav` (`aria-current="page"`), "Signed in as <name>" and a Foldkit UI sign-out `Button`; one `h1` per page; `main` landmark; STD's own CSS styling the components through `data-disabled`, `data-invalid` and `data-current`, light and dark, visible focus, input and control borders at 3:1 or more (WCAG 1.4.11), reduced motion and forced colors respected.
- **Home page: a placeholder.** It should list the tables the caller can see, which needs the metadata endpoint that workstream 2A is building. No existing endpoint can stand in: the generic routes list records of a named table, and the class definitions (`core.class`) are visible to administrators only. So the home page shows a "Tables" section with a placeholder line; `ws/2b-web-pages` fills it from the metadata endpoint.
- **Client.** The typed `HttpApiClient` from `@std/api`, built once as the runtime's `resources` (`StdApi.layer`, over Foldkit's `Http.layer`), with no base URL (the page's origin) and `STD-Client: web`.
- **DevTools** stay on in development only (`@foldkit/devtools` is a dev dependency, default `show: 'Development'`), with the app's `Message` Schema passed for agent dispatch. `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex) register `foldkit-devtools` as `pnpm --silent --dir apps/web exec foldkit-devtools-mcp`, so the pinned Node and the locked package run it, from the app's directory, on the default per-user relay registry; no fixed `devToolsMcpPort`.

## Lint: Ultracite and Foldkit's conventions

`pnpm check` runs Foldkit's preset and every Ultracite rule on `apps/web`; `oxlint.config.ts` is unchanged. Where a generic rule meets a Foldkit idiom, the code takes the form both accept, and only where the rule is wrong for the line does a single-line disable carry the reason:

- `sonarjs/function-name` reads every tag-keyed match case (`ClickedRetry: () => ...`) as a misnamed function. `Message.match` cases keep Foldkit's form with a disable each; other unions are matched with Effect `Match.tag` chains, which FOLDKIT.md allows for non-Message unions.
- `no-redeclare` reads a Schema and its type alias (`const Model` and `type Model`) as a redeclaration: a disable on each such Schema; aliases nobody needs were dropped.
- `sonarjs/no-wildcard-import`: pages are imported by name (`view as signInView`), not as namespaces. `typescript/array-type`: `readonly T[]`. `sonarjs/no-built-in-override`: `Array` and `String` are not imported from `effect`. `github/no-then`: Commands recover with `Effect.orElseSucceed`, not `Effect.catch`.
- `github/filenames-match-regex` allows one dot segment, so a page's tests sit in the page's own folder (`page/sign-in/story.test.ts`), which FOLDKIT.md also allows.
- `vitest/prefer-importing-vitest-globals` reads Foldkit's scene `expect` as Vitest's: one disable per scene file. Story and scene tests use Vitest's `it`, with an assertion in each.

If the noise grows with the pages workstream, scoping `sonarjs/function-name` and `no-redeclare` off for `apps/web/**` is a candidate for its own decision; this workstream does not weaken the config.

## Browser tests: Vitest driving Playwright's Chromium

Foldkit's own repository tests its examples with Playwright's test runner (`packages/examples-e2e`, `@playwright/test`). STD uses Playwright too, as the browser engine (`playwright`, Chromium), but driven from Vitest, with `@effect/vitest`:

- The tests need a real `std serve` on a disposable database with users, which `@std/testing` provides as Effect layers (`acmeTestLayer`: a migrated database with the acme fixture's administrator Ada and restricted Bob). In Vitest that is one `layer(...)` line, with scoped resources (the server process, the browser, the forging site, the Vite dev server, the MCP client) released in order. Playwright's runner would need its own TypeScript loader, its own fixtures around the Effect harness, and a second runner and config style in the repository.
- Vitest's browser mode was rejected: it runs the test code inside the page, where it cannot start a server or a database.
- `apps/web/vitest-browser.config.ts` (`pnpm --filter @std/web test:browser`): a global setup refuses to start without Playwright's Chromium and names the install command (`pnpm --filter @std/web exec playwright install chromium`, into the user cache), then builds the app once into a temporary directory that each test's `std serve` serves.
- The tests: Ada (`admin`) and Bob (`employee`) sign in from the home page's redirect, see the shell with their name, reload, sign out; the cookie is `HttpOnly`, `SameSite=Strict`, on `/api/v1`, not `Secure` on loopback; the token appears in neither `document.cookie`, `localStorage`, `sessionStorage` nor the HTML; a replayed token after sign-out is `401`. A same-site page posts forms with the cookie attached and gets `401`. On the Vite dev server, the DevTools record read through the MCP server (`foldkit_get_model`, `foldkit_list_messages`, as an agent would) holds the user and `<redacted:password>` but neither the token nor the password.
- CI installs Chromium with its system libraries (`playwright install --with-deps chromium`, GitHub Actions only, like the strace step) and runs the tests after `pnpm test`; `pnpm ci:local` runs the same step and fails with the install hint when the browser is missing.
- Two host quirks shaped the tests. Without system fonts, headless Chromium lays out text with no height, so text is waited for as attached, not visible. On some hosts the headless shell closes a page whose cross-origin form post carries a body, so the browser's forged posts are body-less (an accepted cookie would get `400` and `204`, not `401`) and the server test sends the JSON-in-`text/plain` payload.

## Open

- The web app does not yet send `STD-Schema-Revision` (Contracts 6.2): its only requests are the auth endpoints, which name no table or field. The pages workstream adds it with the metadata.
- After start-up, the app learns that a session ended (expiry, deactivation) only from sign-out; the pages workstream should send any `Unauthenticated` answer back to sign-in.
- The vite-plugin patch must be re-made or dropped with every `@foldkit/vite-plugin` upgrade (pnpm refuses a patch that no longer applies).
