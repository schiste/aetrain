import {
  createDiagnostics,
  installRelayHook,
  summarizeError
} from "../app-shell/diagnostics.ts";
import {
  fetchEdgeGeometryArtifact,
  type EdgeGeometryChunkResult,
  type EdgeGeometryManifest
} from "../data/edge-geometry-artifacts.ts";
import {
  fetchServicePatternArtifact,
  type ServicePatternChunkResult,
  type ServicePatternManifest
} from "../data/service-pattern-artifacts.ts";
import {
  fetchRuntimePlaceArtifact,
  type RuntimePlaceChunkResult,
  type RuntimePlaceManifest
} from "../data/runtime-place-artifacts.ts";
import { buildProductionPlannerData } from "../data/production-adapter.ts";
import type {
  ProductionArtifactBundle,
  RawCity,
  RawEdge,
  RawStationArtifact,
  RuntimeArtifactMeta
} from "../types/planner-dataset.ts";

interface IncomingMessage {
  type?: string;
  basePaths?: string[];
  requestId?: string;
  /** Set when the load-edge-geometries message wants viewport-filtered
   *  fetching. The chunk-bbox manifest field gates the actual filter;
   *  see selectVisibleChunks in edge-geometry-artifacts.ts. */
  viewport?: import("../data/edge-geometry-artifacts.ts").EdgeGeometryBoundingBox;
  /** Files already fetched on previous load-edge-geometries calls;
   *  the worker treats these as cache hits and skips them. */
  seenChunkFiles?: string[];
  /** When true, the worker emits one `geometry-chunk` message per chunk
   *  as each fetch resolves (resolution order) and OMITS the combined
   *  geometries from the final `ok` message to avoid a second large
   *  structured clone. When false/absent it keeps the legacy single
   *  combined-payload contract. */
  stream?: boolean;
  /** load-runtime-places: which place-layer manifest to load
   *  (`service-places.manifest.json` or `registry-places.manifest.json`). */
  manifestFile?: string;
  /** load-runtime-places: echoed back on chunk + terminal messages so the
   *  caller can route a shared worker channel to the right layer. */
  layerId?: string;
}

interface FetchAssetError extends Error {
  artifactStatus?: number;
}

interface SerializedError {
  name: string;
  message: string;
  stack: string | null;
}

const diagnostics = createDiagnostics("web/worker/runtime-data");
// Mirror every diagnostics event to the main thread so artifact-fetch
// timings + warn/error envelopes appear in the unified HUD. See the
// equivalent hook in planner.worker.ts.
installRelayHook((event) => {
  self.postMessage({ __aetrain_diag: event });
});

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const message: IncomingMessage = event.data || {};
  if (message.type === "load-production-dataset") {
    await handleLoadDataset(message);
    return;
  }

  if (message.type === "load-edge-geometries") {
    await handleLoadGeometries(message);
    return;
  }

  if (message.type === "load-service-patterns") {
    await handleLoadServices(message);
    return;
  }

  if (message.type === "load-runtime-places") {
    await handleLoadRuntimePlaces(message);
    return;
  }
});

async function handleLoadDataset(message: IncomingMessage): Promise<void> {
  const basePaths: string[] = message.basePaths ?? [];
  const requestId = message.requestId;
  diagnostics.info("received runtime data worker dataset request", {
    request_id: requestId,
    base_path_count: basePaths.length
  });

  try {
    // Geometry is intentionally omitted on the cold path. We feed an empty
    // RawEdgeGeometries to buildProductionPlannerData and let the adapter
    // synthesise straight-line fallback geometry. The full geometry chunks
    // arrive later via the load-edge-geometries message and augment the
    // planner model in place.
    const dataset = await diagnostics.timeAsync("load-production-dataset", async () => {
      const [meta, rawCities, rawEdges, rawStationsResult] = await Promise.all([
        fetchJsonWithFallback(basePaths, "meta.json") as Promise<RuntimeArtifactMeta>,
        fetchJsonWithFallback(basePaths, "cities.json") as Promise<RawCity[]>,
        fetchJsonWithFallback(basePaths, "edges.json") as Promise<RawEdge[]>,
        fetchOptionalJsonWithFallback<RawStationArtifact>(basePaths, "stations.json")
      ]);

      const bundle: ProductionArtifactBundle = {
        meta,
        rawCities,
        rawEdges,
        rawEdgeGeometries: { geometries: [] },
        rawStations: rawStationsResult?.json ?? null
      };
      return buildProductionPlannerData(bundle);
    }, {
      request_id: requestId
    });

    diagnostics.info("runtime data worker built dataset (no geometry)", {
      request_id: requestId,
      dataset_version: dataset.meta?.dataset_version || null,
      city_count: dataset.cities.length,
      route_count: Object.keys(dataset.routeData).length
    });
    self.postMessage({ requestId, ok: true, dataset });
  } catch (error) {
    diagnostics.error("runtime data worker dataset request failed", {
      request_id: requestId,
      error: summarizeError(error)
    });
    self.postMessage({
      requestId,
      ok: false,
      error: serializeError(error)
    });
  }
}

async function handleLoadGeometries(message: IncomingMessage): Promise<void> {
  const basePaths: string[] = message.basePaths ?? [];
  const requestId = message.requestId;
  const viewport = message.viewport;
  const seenChunkFiles = message.seenChunkFiles
    ? new Set<string>(message.seenChunkFiles)
    : undefined;
  const stream = Boolean(message.stream);
  diagnostics.info("received runtime data worker geometry request", {
    request_id: requestId,
    base_path_count: basePaths.length,
    viewport_filtered: Boolean(viewport),
    already_loaded_count: seenChunkFiles?.size ?? 0,
    streaming: stream
  });

  try {
    const result = await diagnostics.timeAsync(
      "load-edge-geometries",
      async () => {
        return fetchEdgeGeometryArtifact(
          {
            basePaths,
            fetchJsonWithFallback: (fileName: string) =>
              fetchJsonWithFallback(basePaths, fileName),
            fetchOptionalJsonWithFallback: (fileName: string) =>
              fetchOptionalJsonWithFallback<ServicePatternManifest>(basePaths, fileName),
            fetchJsonFromBasePath,
            diagnostics
          },
          {
            viewport,
            seenChunkFiles,
            // fetchEdgeGeometryArtifact serializes these emits in resolution
            // order, so the geometry-chunk messages leave the worker in the
            // same order chunks land. postMessage preserves that order on the
            // wire, so the main thread receives them already sequenced.
            onChunk: stream
              ? (chunk: EdgeGeometryChunkResult) => {
                  self.postMessage({ requestId, type: "geometry-chunk", chunk });
                }
              : undefined
          }
        );
      },
      { request_id: requestId }
    );

    diagnostics.info("runtime data worker loaded edge geometries", {
      request_id: requestId,
      geometry_count: result.geometries.geometries.length,
      loaded_chunk_count: result.loadedChunkFiles.length,
      streaming: stream
    });
    // Streamed loads already shipped every geometry via geometry-chunk
    // messages, so the combined array is omitted here — re-sending it would
    // duplicate a ~100MB structured clone. loadedChunkFiles is always sent so
    // the caller can update its seen-set and detect the no-op (empty) case.
    self.postMessage({
      requestId,
      ok: true,
      loadedChunkFiles: result.loadedChunkFiles,
      ...(stream ? {} : { geometries: result.geometries })
    });
  } catch (error) {
    diagnostics.error("runtime data worker geometry request failed", {
      request_id: requestId,
      error: summarizeError(error)
    });
    self.postMessage({
      requestId,
      ok: false,
      error: serializeError(error)
    });
  }
}

async function handleLoadServices(message: IncomingMessage): Promise<void> {
  const basePaths: string[] = message.basePaths ?? [];
  const requestId = message.requestId;
  const seenChunkFiles = message.seenChunkFiles
    ? new Set<string>(message.seenChunkFiles)
    : undefined;
  const stream = Boolean(message.stream);
  diagnostics.info("received runtime data worker service request", {
    request_id: requestId,
    base_path_count: basePaths.length,
    already_loaded_count: seenChunkFiles?.size ?? 0,
    streaming: stream
  });

  try {
    const result = await diagnostics.timeAsync(
      "load-service-patterns",
      async () => {
        return fetchServicePatternArtifact(
          {
            basePaths,
            fetchJsonWithFallback: (fileName: string) =>
              fetchJsonWithFallback(basePaths, fileName),
            fetchOptionalJsonWithFallback: (fileName: string) =>
              fetchOptionalJsonWithFallback(basePaths, fileName),
            fetchJsonFromBasePath,
            diagnostics
          },
          {
            seenChunkFiles,
            onChunk: stream
              ? (chunk: ServicePatternChunkResult) => {
                  self.postMessage({ requestId, type: "service-pattern-chunk", chunk });
                }
              : undefined
          }
        );
      },
      { request_id: requestId }
    );

    diagnostics.info("runtime data worker loaded service patterns", {
      request_id: requestId,
      pattern_count: result.services.patterns.length,
      loaded_chunk_count: result.loadedChunkFiles.length,
      streaming: stream
    });
    self.postMessage({
      requestId,
      ok: true,
      loadedChunkFiles: result.loadedChunkFiles,
      ...(stream ? {} : { services: result.services })
    });
  } catch (error) {
    diagnostics.error("runtime data worker service request failed", {
      request_id: requestId,
      error: summarizeError(error)
    });
    self.postMessage({
      requestId,
      ok: false,
      error: serializeError(error)
    });
  }
}

async function handleLoadRuntimePlaces(message: IncomingMessage): Promise<void> {
  const basePaths: string[] = message.basePaths ?? [];
  const requestId = message.requestId;
  const manifestFile = message.manifestFile;
  // layerId is opaque to the worker — it just echoes it back so the caller can
  // route a single worker channel to the right place layer (service vs registry).
  const layerId = message.layerId;
  const seenChunkFiles = message.seenChunkFiles
    ? new Set<string>(message.seenChunkFiles)
    : undefined;
  const stream = Boolean(message.stream);
  diagnostics.info("received runtime data worker place request", {
    request_id: requestId,
    layer_id: layerId ?? null,
    manifest_file: manifestFile ?? null,
    base_path_count: basePaths.length,
    already_loaded_count: seenChunkFiles?.size ?? 0,
    streaming: stream
  });

  if (!manifestFile) {
    // The place layers are addressed by manifest file; without one there is
    // nothing to load. Treat as a hard error so the caller surfaces the bug
    // rather than silently rendering an empty layer.
    const error = new Error("load-runtime-places requires a manifestFile");
    diagnostics.error("runtime data worker place request missing manifestFile", {
      request_id: requestId,
      layer_id: layerId ?? null
    });
    self.postMessage({ requestId, ok: false, layerId, error: serializeError(error) });
    return;
  }

  try {
    const result = await diagnostics.timeAsync(
      "load-runtime-places",
      async () => {
        return fetchRuntimePlaceArtifact(
          {
            basePaths,
            fetchOptionalJsonWithFallback: (fileName: string) =>
              fetchOptionalJsonWithFallback<RuntimePlaceManifest>(basePaths, fileName),
            fetchJsonFromBasePath,
            diagnostics
          },
          {
            manifestFile,
            seenChunkFiles,
            onChunk: stream
              ? (chunk: RuntimePlaceChunkResult) => {
                  self.postMessage({ requestId, type: "runtime-place-chunk", layerId, chunk });
                }
              : undefined
          }
        );
      },
      { request_id: requestId, layer_id: layerId ?? null }
    );

    diagnostics.info("runtime data worker loaded runtime places", {
      request_id: requestId,
      layer_id: layerId ?? null,
      place_count: result.places.length,
      loaded_chunk_count: result.loadedChunkFiles.length,
      streaming: stream
    });
    // Streamed loads already shipped every place via runtime-place-chunk
    // messages; omit the combined array to avoid a duplicate structured clone.
    self.postMessage({
      requestId,
      ok: true,
      layerId,
      loadedChunkFiles: result.loadedChunkFiles,
      ...(stream ? {} : { places: result.places })
    });
  } catch (error) {
    diagnostics.error("runtime data worker place request failed", {
      request_id: requestId,
      layer_id: layerId ?? null,
      error: summarizeError(error)
    });
    self.postMessage({
      requestId,
      ok: false,
      layerId,
      error: serializeError(error)
    });
  }
}

async function fetchJsonWithFallback(
  basePaths: string[],
  fileName: string
): Promise<unknown> {
  const result = await fetchJsonAssetWithFallback(basePaths, fileName);
  return result.json;
}

async function fetchOptionalJsonWithFallback(
  basePaths: string[],
  fileName: string
): Promise<{ basePath: string; json: EdgeGeometryManifest } | null>;
async function fetchOptionalJsonWithFallback<T>(
  basePaths: string[],
  fileName: string
): Promise<{ basePath: string; json: T } | null>;
async function fetchOptionalJsonWithFallback<T = unknown>(
  basePaths: string[],
  fileName: string
): Promise<{ basePath: string; json: T } | null> {
  let lastError: unknown = null;
  let sawNonNotFoundError = false;
  for (const basePath of basePaths) {
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
  basePaths: string[],
  fileName: string
): Promise<{ basePath: string; json: unknown }> {
  let lastError: unknown = null;
  for (const basePath of basePaths) {
    try {
      const json = await fetchJsonFromBasePath(basePath, fileName);
      return { basePath, json };
    } catch (error) {
      diagnostics.warn("worker artifact fetch failed", {
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
  diagnostics.debug("worker fetching artifact", {
    file_name: fileName,
    base_path: basePath
  });
  // No cache: "no-store" — that would bypass the document-level
  // preload hints in index.html, defeating the cold-load overlap.
  // Dataset URLs are stable; meta.json carries the version; the
  // service worker invalidates the data cache by dataset_version.
  // credentials: "omit" matches the `crossorigin="anonymous"` on the
  // preload links in index.html. Mismatched credentials make the browser
  // treat the preload as unused and trigger a console warning even
  // though both requests target the same same-origin URL.
  const response = await fetch(new URL(fileName, basePath), { credentials: "omit" });
  if (!response.ok) {
    const error: FetchAssetError = new Error(`HTTP ${response.status}`);
    error.artifactStatus = response.status;
    throw error;
  }
  const json = await response.json();
  diagnostics.debug("worker fetched artifact", {
    file_name: fileName,
    base_path: basePath
  });
  return json;
}

function serializeError(error: unknown): SerializedError {
  const candidate = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
    stack: typeof candidate?.stack === "string" ? candidate.stack : null
  };
}
