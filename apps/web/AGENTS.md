# @std/web

STD's web app: a Foldkit program with Foldkit UI, built with Vite.

Before changing anything here, read the root [`AGENTS.md`](../../AGENTS.md) (in particular "Frontend: Foldkit", which wins over Foldkit's own guide where they differ) and Foldkit's guide [`FOLDKIT.md`](../../FOLDKIT.md). The decisions behind this package are in [`docs/decisions/0018-web-foundation.md`](../../docs/decisions/0018-web-foundation.md).

- `pnpm --filter @std/web dev`: the Vite dev server, with DevTools; `/api` goes to a running `std serve` (`STD_WEB_API_TARGET`, default `http://127.0.0.1:8080`).
- `pnpm --filter @std/web build`: writes `dist/`, which `std serve` serves at `/`.
- `pnpm --filter @std/web test`: the story and scene tests beside the code in `src/`.
- `pnpm --filter @std/web test:browser`: the browser tests in `test/browser/` (Playwright's Chromium against a real `std serve`).
