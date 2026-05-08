import { createDiagnostics, summarizeError } from "./diagnostics.js";
import { mountLegacyApp } from "../legacy/app.js";

const diagnostics = createDiagnostics("web/bootstrap");

export async function bootstrapWebApp() {
  return diagnostics.timeAsync("bootstrap-web-app", async () => {
    const root = document.querySelector("#app");
    diagnostics.debug("resolved application root", {
      has_root: Boolean(root)
    });

    if (!(root instanceof HTMLDivElement)) {
      throw new Error("Expected #app root element");
    }

    await mountLegacyApp(root);
    diagnostics.info("web app mounted");
  }).catch((error) => {
    diagnostics.error("bootstrap failed", {
      error: summarizeError(error)
    });
    throw error;
  });
}
