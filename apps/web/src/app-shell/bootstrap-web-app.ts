import { createDiagnostics, summarizeError } from "./diagnostics.ts";
import { mountAetrainShell } from "../ui/shell/ae-app.ts";

const diagnostics = createDiagnostics("web/bootstrap");

const PERF_HUD_QUERY_PARAM = "perf";
const PERF_HUD_STORAGE_KEY = "aetrain-perf-hud";

export async function bootstrapWebApp(): Promise<void> {
  return diagnostics.timeAsync("bootstrap-web-app", async () => {
    const root = document.querySelector("#app");
    diagnostics.debug("resolved application root", {
      has_root: Boolean(root)
    });

    if (!(root instanceof HTMLDivElement)) {
      throw new Error("Expected #app root element");
    }

    if (shouldLoadPerfHud()) {
      // Lazy-loaded so the HUD module is not included in the production
      // bundle for users who never enable ?perf=1.
      void import("./perf-hud.ts").then((mod) => {
        mod.mountPerfHud(document.body);
      });
    }

    await mountAetrainShell(root);
    diagnostics.info("web app mounted");
  }).catch((error: unknown) => {
    diagnostics.error("bootstrap failed", {
      error: summarizeError(error)
    });
    throw error;
  });
}

function shouldLoadPerfHud(): boolean {
  try {
    const url = new URL(globalThis.location?.href ?? "http://localhost/");
    const queryValue = url.searchParams.get(PERF_HUD_QUERY_PARAM);
    if (queryValue === "1") {
      return true;
    }
    if (queryValue === "0") {
      return false;
    }
  } catch {
    // ignore — non-browser
  }
  try {
    return globalThis.localStorage?.getItem(PERF_HUD_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
