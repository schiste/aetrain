import { createDiagnostics, summarizeError } from "./diagnostics.ts";
import { ensureServiceWorker } from "./service-worker.ts";
import { mountAetrainShell } from "../ui/shell/ae-app.ts";

const diagnostics = createDiagnostics("web/bootstrap");

export async function bootstrapWebApp(): Promise<void> {
  return diagnostics.timeAsync("bootstrap-web-app", async () => {
    const root = document.querySelector("#app");
    diagnostics.debug("resolved application root", {
      has_root: Boolean(root)
    });

    if (!(root instanceof HTMLDivElement)) {
      throw new Error("Expected #app root element");
    }

    // Await SW cleanup BEFORE mounting the shell. In dev mode, a stale
    // prod-mode SW that controls this page would intercept the worker's
    // dataset fetches and serve cached responses with wrong MIME types
    // (e.g. a cached .ts response from a previous prod build), breaking
    // boot before any error UI can render. ensureServiceWorker triggers
    // a one-shot reload in that case, so awaiting it here either yields
    // quickly (no SW interference) or never returns (we're reloading).
    // In prod mode the registration is fast (~5ms) and harmless to await.
    await ensureServiceWorker();

    // The perf HUD overlay is owned by ae-debug-toggles inside the shell —
    // it reads the same ?perf=1 / localStorage flag and lazy-loads the HUD
    // module on demand. Bootstrap only has to mount the shell.
    await mountAetrainShell(root);
    diagnostics.info("web app mounted");
  }).catch((error: unknown) => {
    diagnostics.error("bootstrap failed", {
      error: summarizeError(error)
    });
    throw error;
  });
}
