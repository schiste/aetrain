import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import {
  fetchEdgeGeometryArtifact,
  type EdgeGeometryManifest
} from "../data/edge-geometry-artifacts.ts";
import { buildProductionPlannerData } from "../data/production-adapter.ts";
import type {
  ProductionArtifactBundle,
  RawCity,
  RawEdge,
  RawEdgeGeometries,
  RuntimeArtifactMeta
} from "../types/planner-dataset.ts";

interface IncomingMessage {
  type?: string;
  basePaths?: string[];
  requestId?: string;
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

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const message: IncomingMessage = event.data || {};
  if (message.type !== "load-production-dataset") {
    return;
  }

  const basePaths: string[] = message.basePaths ?? [];
  const requestId = message.requestId;
  diagnostics.info("received runtime data worker request", {
    request_id: requestId,
    base_path_count: basePaths.length
  });

  try {
    const dataset = await diagnostics.timeAsync("load-production-dataset", async () => {
      const [meta, rawCities, rawEdges, rawEdgeGeometries] = await Promise.all([
        fetchJsonWithFallback(basePaths, "meta.json") as Promise<RuntimeArtifactMeta>,
        fetchJsonWithFallback(basePaths, "cities.json") as Promise<RawCity[]>,
        fetchJsonWithFallback(basePaths, "edges.json") as Promise<RawEdge[]>,
        fetchEdgeGeometryArtifact({
          basePaths,
          fetchJsonWithFallback: (fileName: string) =>
            fetchJsonWithFallback(basePaths, fileName),
          fetchOptionalJsonWithFallback: (fileName: string) =>
            fetchOptionalJsonWithFallback(basePaths, fileName),
          fetchJsonFromBasePath,
          diagnostics
        })
      ]);

      const bundle: ProductionArtifactBundle = {
        meta,
        rawCities,
        rawEdges,
        rawEdgeGeometries
      };
      return buildProductionPlannerData(bundle);
    }, {
      request_id: requestId
    });

    diagnostics.info("runtime data worker built dataset", {
      request_id: requestId,
      dataset_version: dataset.meta?.dataset_version || null,
      city_count: dataset.cities.length,
      route_count: Object.keys(dataset.routeData).length
    });
    self.postMessage({ requestId, ok: true, dataset });
  } catch (error) {
    diagnostics.error("runtime data worker failed", {
      request_id: requestId,
      error: summarizeError(error)
    });
    self.postMessage({
      requestId,
      ok: false,
      error: serializeError(error)
    });
  }
});

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
): Promise<{ basePath: string; json: EdgeGeometryManifest } | null> {
  let lastError: unknown = null;
  let sawNonNotFoundError = false;
  for (const basePath of basePaths) {
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
  const response = await fetch(new URL(fileName, basePath), { cache: "no-store" });
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
