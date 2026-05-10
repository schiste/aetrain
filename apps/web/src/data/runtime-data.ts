import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import type {
  PlannerDataset,
  ProductionArtifactBundle
} from "../types/planner-dataset.ts";
import {
  fetchEdgeGeometryArtifact,
  type EdgeGeometryManifest
} from "./edge-geometry-artifacts.ts";
import { buildProductionPlannerData } from "./production-adapter.ts";

// Vite serves `apps/web/public/` contents at the site root in both dev
// (vite serve) and prod (vite build copies them to dist/). Anchoring the
// path to the page origin gives a stable absolute URL in both modes.
//
// We previously used `new URL("../../public/data/production/", import.meta.url)`
// here, but in dev Vite rewrites that to `/@fs/...` and drops the
// `production/` segment, so the JSON fetch returns the SPA-fallback HTML.
const PRODUCTION_BASE_PATHS: readonly string[] = [
  new URL("/data/production/", window.location.origin).href
];
const diagnostics = createDiagnostics("web/data/runtime");

interface FetchAssetError extends Error {
  artifactStatus?: number;
}

interface SerializedWorkerError {
  name?: string;
  message?: string;
  stack?: string;
}

interface WorkerLoadResponse {
  requestId?: string;
  ok?: boolean;
  dataset?: PlannerDataset;
  error?: SerializedWorkerError;
}

export async function loadPlannerDataset(): Promise<PlannerDataset> {
  return diagnostics.timeAsync("load-planner-dataset", async () => {
    diagnostics.info("loading planner dataset");
    try {
      return await loadProductionDataSourceFromWorker();
    } catch (error) {
      diagnostics.warn("falling back to inline production dataset loader", {
        error: summarizeError(error)
      });
      return loadProductionDataSourceInline();
    }
  });
}

async function loadProductionDataSourceInline(): Promise<PlannerDataset> {
  return diagnostics.timeAsync("load-production-inline", async () => {
    // Treat raw fetch results as `unknown` and let
    // assertProductionArtifactBundle (called inside buildProductionPlannerData)
    // do the type narrowing. Casting at the fetch site looks safe but hides
    // the fact that the bytes have not yet been validated.
    const [meta, rawCities, rawEdges, rawEdgeGeometries] = await Promise.all([
      fetchJsonWithFallback("meta.json"),
      fetchJsonWithFallback("cities.json"),
      fetchJsonWithFallback("edges.json"),
      fetchEdgeGeometryArtifact({
        basePaths: PRODUCTION_BASE_PATHS,
        fetchJsonWithFallback,
        fetchOptionalJsonWithFallback,
        fetchJsonFromBasePath,
        diagnostics
      })
    ]);

    const dataset = buildProductionPlannerData({
      meta,
      rawCities,
      rawEdges,
      rawEdgeGeometries
    } as unknown as ProductionArtifactBundle);
    diagnostics.info("built production dataset inline", {
      dataset_version: dataset.meta?.dataset_version || null,
      city_count: dataset.cities.length,
      route_count: Object.keys(dataset.routeData).length
    });
    return dataset;
  });
}

async function loadProductionDataSourceFromWorker(): Promise<PlannerDataset> {
  if (typeof Worker === "undefined") {
    throw new Error("Worker API unavailable");
  }

  return diagnostics.timeAsync("load-production-from-worker", async () => {
    const worker = new Worker(new URL("../workers/runtime-data.worker.ts", import.meta.url), {
      type: "module"
    });
    diagnostics.debug("spawned runtime data worker");

    return new Promise<PlannerDataset>((resolve, reject) => {
      const requestId = `production-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      function cleanup(): void {
        diagnostics.debug("terminating runtime data worker", {
          request_id: requestId
        });
        worker.terminate();
      }

      worker.addEventListener("message", (event: MessageEvent<WorkerLoadResponse>) => {
        const message: WorkerLoadResponse = event.data || {};
        if (message.requestId !== requestId) {
          return;
        }

        cleanup();
        if (message.ok && message.dataset) {
          diagnostics.info("runtime data worker loaded production dataset", {
            request_id: requestId,
            dataset_version: message.dataset.meta?.dataset_version || null,
            city_count: message.dataset.cities?.length || null,
            route_count: Object.keys(message.dataset.routeData || {}).length
          });
          resolve(message.dataset);
          return;
        }

        reject(deserializeWorkerError(message.error));
      });

      worker.addEventListener("error", (event: ErrorEvent) => {
        cleanup();
        reject(event.error || new Error(event.message || "Worker error"));
      });

      diagnostics.debug("posting runtime data worker request", {
        request_id: requestId,
        base_paths: PRODUCTION_BASE_PATHS
      });
      worker.postMessage({
        type: "load-production-dataset",
        requestId,
        basePaths: PRODUCTION_BASE_PATHS
      });
    });
  });
}

async function fetchJsonWithFallback(fileName: string): Promise<unknown> {
  const result = await fetchJsonAssetWithFallback(fileName);
  return result.json;
}

async function fetchOptionalJsonWithFallback(
  fileName: string
): Promise<{ basePath: string; json: EdgeGeometryManifest } | null> {
  let lastError: unknown = null;
  let sawNonNotFoundError = false;
  for (const basePath of PRODUCTION_BASE_PATHS) {
    try {
      const json = (await fetchJsonFromBasePath(basePath, fileName)) as EdgeGeometryManifest;
      return { basePath, json };
    } catch (error) {
      const status = (error as FetchAssetError | null)?.artifactStatus;
      if (status !== 404) {
        sawNonNotFoundError = true;
        lastError = error;
      }
    }
  }

  if (sawNonNotFoundError) {
    throw lastError;
  }
  return null;
}

async function fetchJsonAssetWithFallback(
  fileName: string
): Promise<{ basePath: string; json: unknown }> {
  let lastError: unknown = null;
  for (const basePath of PRODUCTION_BASE_PATHS) {
    try {
      const json = await fetchJsonFromBasePath(basePath, fileName);
      return { basePath, json };
    } catch (error) {
      diagnostics.warn("runtime artifact fetch failed", {
        file_name: fileName,
        base_path: basePath,
        error: summarizeError(error)
      });
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to load ${fileName}`);
}

async function fetchJsonFromBasePath(
  basePath: string,
  fileName: string
): Promise<unknown> {
  diagnostics.debug("fetching runtime artifact", {
    file_name: fileName,
    base_path: basePath
  });
  const response = await fetch(new URL(fileName, basePath), { cache: "no-store" });
  if (!response.ok) {
    const error: FetchAssetError = new Error(`HTTP ${response.status}`);
    error.artifactStatus = response.status;
    throw error;
  }
  const json = await response.json();
  diagnostics.debug("fetched runtime artifact", {
    file_name: fileName,
    base_path: basePath
  });
  return json;
}

function deserializeWorkerError(
  error: SerializedWorkerError | undefined
): Error {
  if (!error) {
    return new Error("Unknown worker error");
  }

  const restored = new Error(error.message || "Unknown worker error");
  restored.name = error.name || "Error";
  if (error.stack) {
    restored.stack = error.stack;
  }
  return restored;
}
