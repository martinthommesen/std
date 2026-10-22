# @std/web

STD's web app: a Foldkit program with Foldkit UI, built with Vite.

Before changing anything here, read the root [`AGENTS.md`](../../AGENTS.md) (in particular "Frontend: Foldkit", which wins over Foldkit's own guide where they differ) and Foldkit's guide [`FOLDKIT.md`](../../FOLDKIT.md). The decisions behind this package are in [`docs/decisions/0018-web-foundation.md`](../../docs/decisions/0018-web-foundation.md) and the "Web app" section of [`docs/decisions/0020-web-pages.md`](../../docs/decisions/0020-web-pages.md).

- Requests that act on metadata send its revision: wrap them in `atRevision(...)` (`src/std-client.ts`) with the revision of the metadata they were built from, and read the response's with `responseMode: "decoded-and-response"` and `responseRevision` (see `src/page/table-list/command.ts`).
- Labelled Foldkit UI controls (`src/view/controls.ts`) and the Date Picker layout (`src/view/date-picker.ts`) are shared; pages use them rather than laying out controls again.
- A stored filter (condition AST, fields by ID) loads into a list page only through `applyStoredFilter` (`src/page/table-list/update.ts`).
- What becomes of a form's edits when its definitions change is decided in one place, `src/domain/stale-edits.ts` (kept, flagged, or dropped with a note); what the schema engine refuses per definition record that metadata cannot say is in `src/domain/definition-limits.ts` (decision 0020).
- Browser tests use the fixture-free steps in `test/browser/app.ts`. `launchBrowser` (`test/browser/support.ts`) gives Chromium a fontconfig file of its own, made per run: the system configuration where there is one, plus the DejaVu fonts of the pinned dev dependency `dejavu-fonts-ttf`. Without any font, the headless shell aborts as soon as a layout measures text. Nothing needs setting by hand.
- Checks that read what the browser received use `captureResponses` (`test/browser/app.ts`), started before the page loads: it holds every response's body before the page gets it (CDP `Fetch` at the response stage). Never read a body with `response.text()` after a response event; Chromium may have dropped it (decision 0020, "CI: deterministic response capture").
- `STD_BROWSER_CPU_THROTTLE=4 pnpm --filter @std/web test:browser` runs the browser tests with every page's CPU four times slower (`Emulation.setCPUThrottlingRate`), to bring out races between a test and the page that a fast machine hides.

- `pnpm --filter @std/web dev`: the Vite dev server, with DevTools; `/api` goes to a running `std serve` (`STD_WEB_API_TARGET`, default `http://127.0.0.1:8080`).
- `pnpm --filter @std/web build`: writes `dist/`, which `std serve` serves at `/`.
- `pnpm --filter @std/web test`: the story and scene tests beside the code in `src/`.
- `pnpm --filter @std/web test:browser`: the browser tests in `test/browser/` (Playwright's Chromium against a real `std serve`).
