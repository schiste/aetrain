// Service worker registration + dataset-version ping. Phase 3 deliverable.
//
// Registration is gated on `isProductionBuild()`: in dev (vite serve) we
// actively unregister any leftover SW so HMR keeps working. In prod (vite
// preview / shipped builds) we register `/aetrain-sw.js` once on first
// page load, then forward the dataset_version to the SW so it can prune
// stale `/data/<version>/...` caches.

import { createDiagnostics, summarizeError } from "./diagnostics.ts";

const diagnostics = createDiagnostics("web/service-worker");

const SERVICE_WORKER_URL = "/aetrain-sw.js";

interface DatasetVersionMessage {
  type: "DATASET_VERSION";
  version: string;
}

/**
 * Register the service worker if and only if we're running in a production
 * build. In dev we tear down any registration left over from a previous
 * preview to avoid breaking HMR. Safe to call multiple times.
 */
export async function ensureServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    diagnostics.debug("service worker api unavailable");
    return;
  }

  if (!isProductionBuild()) {
    // Critical: a SW that controls the current page KEEPS controlling
    // until the page reloads, even after registration.unregister(). If
    // the user previously visited the prod build on this origin, that
    // SW is now intercepting dev-mode fetches and can serve stale
    // assets with wrong MIME types (e.g. cached .ts responses).
    // Force a one-time reload after unregistration so the next document
    // load is clean.
    const wasControlled = Boolean(navigator.serviceWorker.controller);
    await unregisterAllServiceWorkers("dev-mode-cleanup");
    if (wasControlled && typeof window !== "undefined") {
      diagnostics.warn(
        "stale service worker detected in dev mode; reloading once to clear it",
        { controller_script_url: navigator.serviceWorker.controller?.scriptURL || null }
      );
      // Defer the reload to the next tick so the warn event lands in
      // the diagnostics buffer before navigation. The dev-mode-cleanup
      // unregister + this reload together guarantee that dev sessions
      // never inherit a prod SW.
      window.setTimeout(() => window.location.reload(), 0);
    }
    return;
  }

  try {
    const existing = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    if (existing) {
      diagnostics.debug("service worker already registered", {
        scope: existing.scope
      });
      return;
    }
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: "/"
    });
    diagnostics.info("service worker registered", {
      scope: registration.scope
    });
  } catch (error) {
    diagnostics.warn("service worker registration failed", {
      error: summarizeError(error)
    });
  }
}

/**
 * Tell the active service worker which dataset version we're using so it
 * can prune older `/data/...` caches. Called once after the dataset has
 * loaded; repeats are cheap and idempotent on the SW side.
 */
export async function notifyServiceWorkerDatasetVersion(
  version: string | null | undefined
): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  if (!version) {
    return;
  }
  if (!isProductionBuild()) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const target = registration.active ?? navigator.serviceWorker.controller;
    if (!target) {
      diagnostics.debug("service worker not yet active, skipping dataset_version ping", {
        version
      });
      return;
    }
    const message: DatasetVersionMessage = {
      type: "DATASET_VERSION",
      version
    };
    target.postMessage(message);
    diagnostics.debug("posted dataset_version to service worker", { version });
  } catch (error) {
    diagnostics.warn("failed to post dataset_version to service worker", {
      version,
      error: summarizeError(error)
    });
  }
}

/**
 * Defensively read `import.meta.env.PROD` (Vite-defined). In Node test
 * environments `import.meta.env` is undefined; treating that as non-prod
 * keeps the dev/test path the default-safe behaviour.
 */
function isProductionBuild(): boolean {
  try {
    const env = (import.meta as { env?: { PROD?: boolean } }).env;
    return Boolean(env?.PROD);
  } catch {
    return false;
  }
}

async function unregisterAllServiceWorkers(reason: string): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length === 0) {
      return;
    }
    diagnostics.info("unregistering existing service workers", {
      reason,
      count: registrations.length
    });
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch (error) {
    diagnostics.warn("failed to unregister service workers", {
      reason,
      error: summarizeError(error)
    });
  }
}
