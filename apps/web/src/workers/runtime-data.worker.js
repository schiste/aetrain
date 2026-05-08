import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.js";
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
      const [meta, rawCities, rawEdges] = await Promise.all([
        fetchJsonWithFallback(basePaths, "meta.json"),
        fetchJsonWithFallback(basePaths, "cities.json"),
        fetchJsonWithFallback(basePaths, "edges.json")
      ]);

      return buildProductionPlannerData({ meta, rawCities, rawEdges });
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
  let lastError = null;
  for (const basePath of basePaths) {
    try {
      diagnostics.debug("worker fetching artifact", {
        file_name: fileName,
        base_path: basePath
      });
      const response = await fetch(new URL(fileName, basePath), { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      diagnostics.debug("worker fetched artifact", {
        file_name: fileName,
        base_path: basePath
      });
      return json;
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

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}
