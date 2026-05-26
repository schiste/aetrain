import {
  createDiagnostics,
  ingestRelayedEvent,
  summarizeError
} from "../app-shell/diagnostics.ts";
import type { DiagnosticsEvent } from "../types/diagnostics.ts";
import type {
  PlannerDataset,
  ProductionArtifactBundle,
  RawEdgeGeometries,
  RawStationArtifact
} from "../types/planner-dataset.ts";
import {
  fetchEdgeGeometryArtifact,
  type EdgeGeometryBoundingBox,
  type EdgeGeometryChunkResult,
  type EdgeGeometryManifest
} from "./edge-geometry-artifacts.ts";
import { buildProductionPlannerData } from "./production-adapter.ts";
import {
  fetchServicePatternArtifact,
  type RawServicePatternArtifact,
  type ServicePatternChunkResult,
  type ServicePatternManifest
} from "./service-pattern-artifacts.ts";
import {
  fetchRuntimePlaceArtifact,
  type PlannerPlace,
  type RuntimePlaceChunkResult,
  type RuntimePlaceManifest
} from "./runtime-place-artifacts.ts";

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
const WORKER_DIAG_SCOPE_PREFIX = "worker:runtime-data";

/**
 * Intercept the worker's diagnostic relay envelopes and forward them
 * into the main-thread store. Returns true when the message was a relay
 * (caller should bail), false otherwise. Matches the pattern used in
 * planner-client.ts.
 */
function tryIngestWorkerDiagnostic(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const envelope = message as { __aetrain_diag?: DiagnosticsEvent };
  const event = envelope.__aetrain_diag;
  if (!event) {
    return false;
  }
  ingestRelayedEvent(event, WORKER_DIAG_SCOPE_PREFIX);
  return true;
}

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
  /** "geometry-chunk" for a streamed per-chunk message; absent on the
   *  terminal ok/error response. */
  type?: string;
  ok?: boolean;
  geometries?: RawEdgeGeometries;
  loadedChunkFiles?: string[];
  /** Present only on "geometry-chunk" messages. */
  chunk?: EdgeGeometryChunkResult;
  error?: SerializedWorkerError;
}

interface WorkerLoadServicesResponse {
  requestId?: string;
  type?: string;
  ok?: boolean;
  services?: RawServicePatternArtifact;
  loadedChunkFiles?: string[];
  chunk?: ServicePatternChunkResult;
  error?: SerializedWorkerError;
}

interface WorkerLoadPlacesResponse {
  requestId?: string;
  /** "runtime-place-chunk" for a streamed per-chunk message; absent on the
   *  terminal ok/error response. */
  type?: string;
  ok?: boolean;
  /** Echoed back from the request so a shared worker channel can be routed
   *  to the right layer. Not consumed today (one worker per request) but kept
   *  for parity with the worker contract. */
  layerId?: string;
  /** Present only on a non-streaming terminal response. */
  places?: PlannerPlace[];
  loadedChunkFiles?: string[];
  /** Present only on "runtime-place-chunk" messages. */
  chunk?: RuntimePlaceChunkResult;
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

export interface LoadServicePatternsResult {
  services: RawServicePatternArtifact;
  loadedChunkFiles: string[];
}

export interface LoadServicePatternsOptions {
  seenChunkFiles?: ReadonlySet<string>;
  onChunk?(chunk: ServicePatternChunkResult): void | Promise<void>;
}

export async function loadServicePatterns(
  options: LoadServicePatternsOptions = {}
): Promise<LoadServicePatternsResult> {
  return diagnostics.timeAsync("load-service-patterns", async () => {
    diagnostics.info("loading service patterns", {
      already_loaded_count: options.seenChunkFiles?.size ?? 0,
      streaming: Boolean(options.onChunk)
    });
    try {
      return await loadServicePatternsFromWorker(options);
    } catch (error) {
      diagnostics.warn("falling back to inline service pattern loader", {
        error: summarizeError(error)
      });
      return loadServicePatternsInline(options);
    }
  });
}

export interface LoadRuntimePlacesResult {
  /** The accumulated, browser-projected places. Empty in streaming mode (every
   *  place was already delivered through `onChunk`); use `loadedChunkFiles` to
   *  detect the no-op (manifest-absent or all-seen) case. */
  places: PlannerPlace[];
  loadedChunkFiles: string[];
}

export interface LoadRuntimePlacesOptions {
  /** Which place layer to load. One loader serves both layers; the manifest
   *  file selects between `service-places.manifest.json` and
   *  `registry-places.manifest.json`. */
  manifestFile: string;
  /** Opaque tag echoed through the worker round-trip; useful for diagnostics. */
  layerId?: string;
  seenChunkFiles?: ReadonlySet<string>;
  onChunk?(chunk: RuntimePlaceChunkResult): void | Promise<void>;
}

export async function loadRuntimePlaces(
  options: LoadRuntimePlacesOptions
): Promise<LoadRuntimePlacesResult> {
  return diagnostics.timeAsync("load-runtime-places", async () => {
    diagnostics.info("loading runtime places", {
      manifest_file: options.manifestFile,
      layer_id: options.layerId ?? null,
      already_loaded_count: options.seenChunkFiles?.size ?? 0,
      streaming: Boolean(options.onChunk)
    });
    try {
      return await loadRuntimePlacesFromWorker(options);
    } catch (error) {
      diagnostics.warn("falling back to inline runtime place loader", {
        manifest_file: options.manifestFile,
        error: summarizeError(error)
      });
      return loadRuntimePlacesInline(options);
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
  /** The combined geometry artifact. NOTE: when an `onChunk` callback was
   *  supplied and the worker path served the request, this is empty — every
   *  geometry was already delivered through `onChunk` and the worker omits
   *  the combined array to avoid a second large structured clone. Streaming
   *  callers should apply per chunk and rely on `loadedChunkFiles` (not this
   *  array) to detect the no-op case. */
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
  /** When set, invoked once per chunk as it resolves so callers can apply
   *  geometry progressively (the rail network fills in chunk-by-chunk). The
   *  loader serializes these in resolution order and awaits each before the
   *  next. Passing this also switches the worker into streaming mode, where
   *  the combined `geometries` is omitted from the result (already delivered
   *  per chunk) — so callers MUST apply via this callback, not the result. */
  onChunk?(chunk: EdgeGeometryChunkResult): void | Promise<void>;
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
    const [meta, rawCities, rawEdges, rawStationsResult] = await Promise.all([
      fetchJsonWithFallback("meta.json"),
      fetchJsonWithFallback("cities.json"),
      fetchJsonWithFallback("edges.json"),
      fetchOptionalJsonWithFallback<RawStationArtifact>("stations.json")
    ]);

    const emptyGeometries: RawEdgeGeometries = { geometries: [] };
    const dataset = buildProductionPlannerData({
      meta,
      rawCities,
      rawEdges,
      rawEdgeGeometries: emptyGeometries,
      rawStations: rawStationsResult?.json ?? null
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
        fetchOptionalJsonWithFallback: (fileName: string) =>
          fetchOptionalJsonWithFallback<ServicePatternManifest>(fileName),
        fetchJsonFromBasePath,
        diagnostics
      },
      {
        viewport: options.viewport,
        seenChunkFiles: options.seenChunkFiles,
        onChunk: options.onChunk
      }
    );
    diagnostics.info("loaded edge geometries inline", {
      geometry_count: result.geometries.geometries.length,
      loaded_chunk_count: result.loadedChunkFiles.length
    });
    return result;
  });
}

async function loadServicePatternsInline(
  options: LoadServicePatternsOptions
): Promise<LoadServicePatternsResult> {
  return diagnostics.timeAsync("load-service-patterns-inline", async () => {
    const result = await fetchServicePatternArtifact(
      {
        basePaths: PRODUCTION_BASE_PATHS,
        fetchJsonWithFallback,
        fetchOptionalJsonWithFallback,
        fetchJsonFromBasePath,
        diagnostics
      },
      {
        seenChunkFiles: options.seenChunkFiles,
        onChunk: options.onChunk
      }
    );
    diagnostics.info("loaded service patterns inline", {
      pattern_count: result.services.patterns.length,
      loaded_chunk_count: result.loadedChunkFiles.length
    });
    return result;
  });
}

async function loadRuntimePlacesInline(
  options: LoadRuntimePlacesOptions
): Promise<LoadRuntimePlacesResult> {
  return diagnostics.timeAsync("load-runtime-places-inline", async () => {
    const result = await fetchRuntimePlaceArtifact(
      {
        basePaths: PRODUCTION_BASE_PATHS,
        fetchOptionalJsonWithFallback: (fileName: string) =>
          fetchOptionalJsonWithFallback<RuntimePlaceManifest>(fileName),
        fetchJsonFromBasePath,
        diagnostics
      },
      {
        manifestFile: options.manifestFile,
        seenChunkFiles: options.seenChunkFiles,
        onChunk: options.onChunk
      }
    );
    diagnostics.info("loaded runtime places inline", {
      manifest_file: options.manifestFile,
      place_count: result.places.length,
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
    // Forward worker-side diagnostics into the main store. Installed
    // before the protocol listener so events emitted before INITIALIZE
    // (none today, but cheap insurance) are still captured.
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      tryIngestWorkerDiagnostic(event.data);
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
        // Diagnostics envelopes share the message channel; the sibling
        // relay listener handles them. Bail before treating one as a
        // protocol response.
        if ((message as unknown as { __aetrain_diag?: unknown }).__aetrain_diag) {
          return;
        }
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
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      tryIngestWorkerDiagnostic(event.data);
    });
    diagnostics.debug("spawned runtime data worker for geometry");

    return new Promise<LoadEdgeGeometriesResult>((resolve, reject) => {
      const requestId = `geometries-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const streaming = Boolean(options.onChunk);
      // Serial chain so per-chunk applies run one at a time in arrival order.
      // Reassigned as each geometry-chunk message lands; drained on the
      // terminal ok message before the loader resolves.
      let applyChain: Promise<void> = Promise.resolve();

      function cleanup(): void {
        diagnostics.debug("terminating runtime data worker for geometry", {
          request_id: requestId
        });
        worker.terminate();
      }

      worker.addEventListener("message", async (event: MessageEvent<WorkerLoadGeometriesResponse>) => {
        const message: WorkerLoadGeometriesResponse = event.data || {};
        if ((message as unknown as { __aetrain_diag?: unknown }).__aetrain_diag) {
          return;
        }
        if (message.requestId !== requestId) {
          return;
        }

        // Streamed per-chunk message: enqueue the apply onto the serial chain
        // and keep the worker alive — more chunks and the terminal ok are
        // still inbound. Don't cleanup() here.
        if (message.type === "geometry-chunk" && message.chunk) {
          const chunk = message.chunk;
          applyChain = applyChain.then(() => options.onChunk?.(chunk));
          return;
        }

        if (message.ok) {
          // postMessage preserves order, so once ok lands every geometry-chunk
          // has already been enqueued. Drain the chain before resolving so all
          // chunks are applied before the caller proceeds. A throwing apply
          // surfaces here and rejects the load.
          try {
            await applyChain;
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          cleanup();
          diagnostics.info("runtime data worker loaded edge geometries", {
            request_id: requestId,
            geometry_count: message.geometries?.geometries.length ?? 0,
            loaded_chunk_count: message.loadedChunkFiles?.length ?? 0,
            streaming
          });
          // geometries is omitted by the worker in streaming mode (delivered
          // per chunk above); fall back to an empty artifact so the shape holds.
          resolve({
            geometries: message.geometries ?? { geometries: [] },
            loadedChunkFiles: message.loadedChunkFiles ?? []
          });
          return;
        }

        cleanup();
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
          : undefined,
        stream: streaming
      });
    });
  });
}

async function loadServicePatternsFromWorker(
  options: LoadServicePatternsOptions
): Promise<LoadServicePatternsResult> {
  if (typeof Worker === "undefined") {
    throw new Error("Worker API unavailable");
  }

  return diagnostics.timeAsync("load-service-patterns-from-worker", async () => {
    const worker = new Worker(new URL("../workers/runtime-data.worker.ts", import.meta.url), {
      type: "module"
    });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      tryIngestWorkerDiagnostic(event.data);
    });
    diagnostics.debug("spawned runtime data worker for services");

    return new Promise<LoadServicePatternsResult>((resolve, reject) => {
      const requestId = `services-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const streaming = Boolean(options.onChunk);
      let applyChain: Promise<void> = Promise.resolve();

      function cleanup(): void {
        diagnostics.debug("terminating runtime data worker for services", {
          request_id: requestId
        });
        worker.terminate();
      }

      worker.addEventListener("message", async (event: MessageEvent<WorkerLoadServicesResponse>) => {
        const message: WorkerLoadServicesResponse = event.data || {};
        if ((message as unknown as { __aetrain_diag?: unknown }).__aetrain_diag) {
          return;
        }
        if (message.requestId !== requestId) {
          return;
        }

        if (message.type === "service-pattern-chunk" && message.chunk) {
          const chunk = message.chunk;
          applyChain = applyChain.then(() => options.onChunk?.(chunk));
          return;
        }

        if (message.ok) {
          try {
            await applyChain;
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          cleanup();
          diagnostics.info("runtime data worker loaded service patterns", {
            request_id: requestId,
            pattern_count: message.services?.patterns.length ?? 0,
            loaded_chunk_count: message.loadedChunkFiles?.length ?? 0,
            streaming
          });
          resolve({
            services: message.services ?? { schema_version: 0, patterns: [] },
            loadedChunkFiles: message.loadedChunkFiles ?? []
          });
          return;
        }

        cleanup();
        reject(deserializeWorkerError(message.error));
      });

      worker.addEventListener("error", (event: ErrorEvent) => {
        cleanup();
        reject(event.error || new Error(event.message || "Worker error"));
      });

      diagnostics.debug("posting runtime data worker service request", {
        request_id: requestId,
        base_paths: PRODUCTION_BASE_PATHS
      });
      worker.postMessage({
        type: "load-service-patterns",
        requestId,
        basePaths: PRODUCTION_BASE_PATHS,
        seenChunkFiles: options.seenChunkFiles
          ? Array.from(options.seenChunkFiles)
          : undefined,
        stream: streaming
      });
    });
  });
}

async function loadRuntimePlacesFromWorker(
  options: LoadRuntimePlacesOptions
): Promise<LoadRuntimePlacesResult> {
  if (typeof Worker === "undefined") {
    throw new Error("Worker API unavailable");
  }

  return diagnostics.timeAsync("load-runtime-places-from-worker", async () => {
    const worker = new Worker(new URL("../workers/runtime-data.worker.ts", import.meta.url), {
      type: "module"
    });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      tryIngestWorkerDiagnostic(event.data);
    });
    diagnostics.debug("spawned runtime data worker for places", {
      manifest_file: options.manifestFile
    });

    return new Promise<LoadRuntimePlacesResult>((resolve, reject) => {
      const requestId = `places-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const streaming = Boolean(options.onChunk);
      let applyChain: Promise<void> = Promise.resolve();

      function cleanup(): void {
        diagnostics.debug("terminating runtime data worker for places", {
          request_id: requestId
        });
        worker.terminate();
      }

      worker.addEventListener("message", async (event: MessageEvent<WorkerLoadPlacesResponse>) => {
        const message: WorkerLoadPlacesResponse = event.data || {};
        if ((message as unknown as { __aetrain_diag?: unknown }).__aetrain_diag) {
          return;
        }
        if (message.requestId !== requestId) {
          return;
        }

        if (message.type === "runtime-place-chunk" && message.chunk) {
          const chunk = message.chunk;
          applyChain = applyChain.then(() => options.onChunk?.(chunk));
          return;
        }

        if (message.ok) {
          try {
            await applyChain;
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          cleanup();
          diagnostics.info("runtime data worker loaded runtime places", {
            request_id: requestId,
            manifest_file: options.manifestFile,
            place_count: message.places?.length ?? 0,
            loaded_chunk_count: message.loadedChunkFiles?.length ?? 0,
            streaming
          });
          resolve({
            places: message.places ?? [],
            loadedChunkFiles: message.loadedChunkFiles ?? []
          });
          return;
        }

        cleanup();
        reject(deserializeWorkerError(message.error));
      });

      worker.addEventListener("error", (event: ErrorEvent) => {
        cleanup();
        reject(event.error || new Error(event.message || "Worker error"));
      });

      diagnostics.debug("posting runtime data worker place request", {
        request_id: requestId,
        manifest_file: options.manifestFile,
        base_paths: PRODUCTION_BASE_PATHS
      });
      worker.postMessage({
        type: "load-runtime-places",
        requestId,
        basePaths: PRODUCTION_BASE_PATHS,
        manifestFile: options.manifestFile,
        layerId: options.layerId,
        seenChunkFiles: options.seenChunkFiles
          ? Array.from(options.seenChunkFiles)
          : undefined,
        stream: streaming
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
): Promise<{ basePath: string; json: EdgeGeometryManifest } | null>;
async function fetchOptionalJsonWithFallback<T>(
  fileName: string
): Promise<{ basePath: string; json: T } | null>;
async function fetchOptionalJsonWithFallback<T = unknown>(
  fileName: string
): Promise<{ basePath: string; json: T } | null> {
  let lastError: unknown = null;
  let sawNonNotFoundError = false;
  for (const basePath of PRODUCTION_BASE_PATHS) {
    try {
      const json = (await fetchJsonFromBasePath(basePath, fileName)) as T;
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
  // See worker counterpart: no cache: "no-store" so the document-level
  // preload hints can satisfy these requests without a second round-trip.
  // credentials: "omit" matches the preload link's `crossorigin="anonymous"`
  // so the browser can serve this fetch from the preload cache instead of
  // refusing to dedupe (and emitting a console warning).
  const response = await fetch(new URL(fileName, basePath), { credentials: "omit" });
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
