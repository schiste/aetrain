import { buildProductionPlannerData } from "../data/production-adapter.js";

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type !== "load-production-dataset") {
    return;
  }

  const { basePaths = [], requestId } = message;

  try {
    const [meta, rawCities, rawEdges] = await Promise.all([
      fetchJsonWithFallback(basePaths, "meta.json"),
      fetchJsonWithFallback(basePaths, "cities.json"),
      fetchJsonWithFallback(basePaths, "edges.json")
    ]);

    const dataset = buildProductionPlannerData({ meta, rawCities, rawEdges });
    self.postMessage({ requestId, ok: true, dataset });
  } catch (error) {
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
      const response = await fetch(new URL(fileName, basePath), { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
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
