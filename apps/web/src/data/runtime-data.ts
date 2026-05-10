import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import type {
  PlannerDataset,
  ProductionArtifactBundle,
  RawEdgeGeometries
} from "../types/planner-dataset.ts";
import {
  fetchEdgeGeometryArtifact,
  type EdgeGeometryBoundingBox,
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

interface WorkerLoadDatasetResponse {
  requestId?: string;
  ok?: boolean;
  dataset?: PlannerDataset;
  error?: SerializedWorkerError;
}

interface WorkerLoadGeometriesResponse {
  requestId?: string;
  ok?: boolean;
  geometries?: RawEdgeGeometries;
  loadedChunkFiles?: string[];
  error?: SerializedWorkerError;
}

export async function loadPlannerDataset(): Promise<PlannerDataset> {
  return diagnostics.timeAsync("load-planner-dataset", async () => {
    diagnostics.info("loading planner dataset (no geometry)");
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

/**
 * Deferred edge-geometry load. Fired off after the shell has mounted so the
 * cold path can become interactive without waiting on the ~10MB-gzipped
 * geometry chunks. The result is fed to PlannerEngine.augmentGeometry to
 * upgrade the in-memory routing graph in place.
 */
export interface LoadEdgeGeometriesResult {
  geometries: RawEdgeGeometries;
  /** The chunk `file` strings the loader actually fetched. Empty when
   *  every visible chunk was already in `seenChunkFiles`. Callers merge
   *  this into their tracking set so subsequent view-change re-fetches
   *  skip the same chunks. */
  loadedChunkFiles: string[];
}

export async function loadEdgeGeometries(
  options: LoadEdgeGeometriesOptions = {}
): Promise<LoadEdgeGeometriesResult> {
  return diagnostics.timeAsync("load-edge-geometries", async () => {
    diagnostics.info("loading edge geometries", {
      viewport_filtered: Boolean(options.viewport),
      already_loaded_count: options.seenChunkFiles?.size ?? 0
    });
    try {
      return await loadEdgeGeometriesFromWorker(options);
    } catch (error) {
      diagnostics.warn("falling back to inline edge geometry loader", {
        error: summarizeError(error)
      });
      return loadEdgeGeometriesInline(options);
    }
  });
}

export interface LoadEdgeGeometriesOptions {
  /** Visible map bounding box. When set together with the new bbox-aware
   *  manifest, only chunks whose bbox intersects the viewport are
   *  fetched. Without bboxes (today's backend) the option is silently
   *  ignored — see docs/bugs/2026-05-edge-geometry-chunk-bboxes.md. */
  viewport?: EdgeGeometryBoundingBox;
  /** Files already fetched on previous calls. Lets the view-change
   *  re-fetcher avoid re-loading the same chunk on every pan. */
  seenChunkFiles?: ReadonlySet<string>;
}

async function loadProductionDataSourceInline(): Promise<PlannerDataset> {
  return diagnostics.timeAsync("load-production-inline", async () => {
    // Treat raw fetch results as `unknown` and let
    // assertProductionArtifactBundle (called inside buildProductionPlannerData)
    // do the type narrowing. Casting at the fetch site looks safe but hides
    // the fact that the bytes have not yet been validated.
    //
    // Geometry is intentionally omitted here: the cold path emits an empty
    // geometry artifact and lets buildProductionPlannerData synthesise
    // straight-line fallback geometry per edge. The real curves arrive via
    // loadEdgeGeometries() once the shell is interactive.
    const [meta, rawCities, rawEdges] = await Promise.all([
      fetchJsonWithFallback("meta.json"),
      fetchJsonWithFallback("cities.json"),
      fetchJsonWithFallback("edges.json")
    ]);

    const emptyGeometries: RawEdgeGeometries = { geometries: [] };
    const dataset = buildProductionPlannerData({
      meta,
      rawCities,
      rawEdges,
      rawEdgeGeometries: emptyGeometries
    } as unknown as ProductionArtifactBundle);
    diagnostics.info("built production dataset inline (no geometry)", {
      dataset_version: dataset.meta?.dataset_version || null,
      city_count: dataset.cities.length,
      route_count: Object.keys(dataset.routeData).length
    });
    return dataset;
  });
}

async function loadEdgeGeometriesInline(
  options: LoadEdgeGeometriesOptions
): Promise<LoadEdgeGeometriesResult> {
  return diagnostics.timeAsync("load-edge-geometries-inline", async () => {
    const result = await fetchEdgeGeometryArtifact(
      {
        basePaths: PRODUCTION_BASE_PATHS,
        fetchJsonWithFallback,
        fetchOptionalJsonWithFallback,
        fetchJsonFromBasePath,
        diagnostics
      },
      {
        viewport: options.viewport,
        seenChunkFiles: options.seenChunkFiles
      }
    );
    diagnostics.info("loaded edge geometries inline", {
      geometry_count: result.geometries.geometries.length,
      loaded_chunk_count: result.loadedChunkFiles.length
    });
    return result;
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

      worker.addEventListener("message", (event: MessageEvent<WorkerLoadDatasetResponse>) => {
        const message: WorkerLoadDatasetResponse = event.data || {};
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

async function loadEdgeGeometriesFromWorker(
  options: LoadEdgeGeometriesOptions
): Promise<LoadEdgeGeometriesResult> {
  if (typeof Worker === "undefined") {
    throw new Error("Worker API unavailable");
  }

  return diagnostics.timeAsync("load-edge-geometries-from-worker", async () => {
    const worker = new Worker(new URL("../workers/runtime-data.worker.ts", import.meta.url), {
      type: "module"
    });
    diagnostics.debug("spawned runtime data worker for geometry");

    return new Promise<LoadEdgeGeometriesResult>((resolve, reject) => {
      const requestId = `geometries-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      function cleanup(): void {
        diagnostics.debug("terminating runtime data worker for geometry", {
          request_id: requestId
        });
        worker.terminate();
      }

      worker.addEventListener("message", (event: MessageEvent<WorkerLoadGeometriesResponse>) => {
        const message: WorkerLoadGeometriesResponse = event.data || {};
        if (message.requestId !== requestId) {
          return;
        }

        cleanup();
        if (message.ok && message.geometries) {
          diagnostics.info("runtime data worker loaded edge geometries", {
            request_id: requestId,
            geometry_count: message.geometries.geometries.length,
            loaded_chunk_count: message.loadedChunkFiles?.length ?? 0
          });
          resolve({
            geometries: message.geometries,
            loadedChunkFiles: message.loadedChunkFiles ?? []
          });
          return;
        }

        reject(deserializeWorkerError(message.error));
      });

      worker.addEventListener("error", (event: ErrorEvent) => {
        cleanup();
        reject(event.error || new Error(event.message || "Worker error"));
      });

      diagnostics.debug("posting runtime data worker geometry request", {
        request_id: requestId,
        base_paths: PRODUCTION_BASE_PATHS
      });
      worker.postMessage({
        type: "load-edge-geometries",
        requestId,
        basePaths: PRODUCTION_BASE_PATHS,
        viewport: options.viewport,
        seenChunkFiles: options.seenChunkFiles
          ? Array.from(options.seenChunkFiles)
          : undefined
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
