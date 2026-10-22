/**
 * Vite for STD's web app (decision 0018).
 *
 * `@foldkit/vite-plugin` stamps view identities, preserves the Model across
 * hot reloads, and in development mounts Foldkit DevTools (default
 * `show: 'Development'`, so production builds carry no overlay and no MCP
 * relay) with its MCP relay on the default per-user registry.
 *
 * In development `/api` goes to a running `std serve`
 * (`STD_WEB_API_TARGET`, default `http://127.0.0.1:8080`). The proxy keeps
 * the browser's `Host` (`localhost:5173`), so the server sets the session
 * cookie without `Secure` over plain HTTP, as it does for any loopback
 * host. `pnpm build` writes `dist/`, which `std serve` serves at `/`.
 */
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

const apiTarget = process.env.STD_WEB_API_TARGET ?? "http://127.0.0.1:8080";

const proxy = { "/api": { target: apiTarget } };

export default defineConfig({
  optimizeDeps: { entries: ["src/entry.ts"] },
  plugins: [foldkit()],
  preview: { proxy },
  server: { proxy },
});
