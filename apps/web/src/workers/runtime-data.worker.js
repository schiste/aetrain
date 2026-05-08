import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.js";
import { fetchEdgeGeometryArtifact } from "../data/edge-geometry-artifacts.js";
import { buildProductionPlannerData } from "../data/production-adapter.js";

const diagnostics = createDiagnostics("web/worker/runtime-data");

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type !== "load-production-dataset") {
    return;
  }

  const { basePaths = [], requestId } = message;
  diagnostics.info("received runtime data worker request", {
    request_id: requestId,
    base_path_count: basePaths.length
  });

  try {
    const dataset = await diagnostics.timeAsync("load-production-dataset", async () => {
      const [meta, rawCities, rawEdges, rawEdgeGeometries] = await Promise.all([
        fetchJsonWithFallback(basePaths, "meta.json"),
        fetchJsonWithFallback(basePaths, "cities.json"),
        fetchJsonWithFallback(basePaths, "edges.json"),
        fetchEdgeGeometryArtifact({
          basePaths,
          fetchJsonWithFallback: (fileName) => fetchJsonWithFallback(basePaths, fileName),
          fetchOptionalJsonWithFallback: (fileName) =>
            fetchOptionalJsonWithFallback(basePaths, fileName),
          fetchJsonFromBasePath,
          diagnostics
        })
      ]);

      return buildProductionPlannerData({ meta, rawCities, rawEdges, rawEdgeGeometries });
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

async function fetchJsonWithFallback(basePaths, fileName) {
  const result = await fetchJsonAssetWithFallback(basePaths, fileName);
  return result.json;
}

async function fetchOptionalJsonWithFallback(basePaths, fileName) {
  let lastError = null;
  let sawNonNotFoundError = false;
  for (const basePath of basePaths) {
    try {
      const json = await fetchJsonFromBasePath(basePath, fileName);
      return { basePath, json };
    } catch (error) {
      if (error?.artifactStatus !== 404) {
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

async function fetchJsonAssetWithFallback(basePaths, fileName) {
  let lastError = null;
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

async function fetchJsonFromBasePath(basePath, fileName) {
  diagnostics.debug("worker fetching artifact", {
    file_name: fileName,
    base_path: basePath
  });
  const response = await fetch(new URL(fileName, basePath), { cache: "no-store" });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
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

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}
