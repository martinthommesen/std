# @std/web

STD's web app: a Foldkit program with Foldkit UI, built with Vite.

Before changing anything here, read the root [`AGENTS.md`](../../AGENTS.md) (in particular "Frontend: Foldkit", which wins over Foldkit's own guide where they differ) and Foldkit's guide [`FOLDKIT.md`](../../FOLDKIT.md). The decisions behind this package are in [`docs/decisions/0018-web-foundation.md`](../../docs/decisions/0018-web-foundation.md) and the "Web app" section of [`docs/decisions/0020-web-pages.md`](../../docs/decisions/0020-web-pages.md).

- Requests that act on metadata send its revision: wrap them in `atRevision(...)` (`src/std-client.ts`) with the revision of the metadata they were built from, and read the response's with `responseMode: "decoded-and-response"` and `responseRevision` (see `src/page/table-list/command.ts`).
- Labelled Foldkit UI controls (`src/view/controls.ts`) and the Date Picker layout (`src/view/date-picker.ts`) are shared; pages use them rather than laying out controls again.
- A stored filter (condition AST, fields by ID) loads into a list page only through `applyStoredFilter` (`src/page/table-list/update.ts`).
- Browser tests use the fixture-free steps in `test/browser/app.ts`. On a host without fontconfig (no `/etc/fonts`), headless Chromium aborts at start; set `FONTCONFIG_FILE` to a configuration with any font directory.

- `pnpm --filter @std/web dev`: the Vite dev server, with DevTools; `/api` goes to a running `std serve` (`STD_WEB_API_TARGET`, default `http://127.0.0.1:8080`).
- `pnpm --filter @std/web build`: writes `dist/`, which `std serve` serves at `/`.
- `pnpm --filter @std/web test`: the story and scene tests beside the code in `src/`.
- `pnpm --filter @std/web test:browser`: the browser tests in `test/browser/` (Playwright's Chromium against a real `std serve`).
