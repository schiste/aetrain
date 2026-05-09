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

    // Fire-and-forget: registration runs in parallel with the rest of the
    // boot. ensureServiceWorker self-gates on import.meta.env.PROD and
    // unregisters leftover registrations in dev so HMR isn't poisoned.
    void ensureServiceWorker();

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
