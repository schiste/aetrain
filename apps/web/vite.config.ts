import { defineConfig } from "vite";

// Local servers bind to uncommon fixed ports so they never collide with other
// apps running on vite's usual 5173/4173 defaults. dev and preview get
// distinct ports so both can run at once without fighting over a socket. The
// e2e preview server is configured separately in playwright.config.ts
// (port 4317) and is intentionally left untouched.
const DEV_PORT = 2403;
const PREVIEW_PORT = 2413;

export default defineConfig({
  server: {
    port: DEV_PORT
  },
  preview: {
    port: PREVIEW_PORT
  }
});
