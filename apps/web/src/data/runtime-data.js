import { cities as pocCities, routeData as pocRouteData } from "../legacy/data.js";
import { buildProductionPlannerData } from "./production-adapter.js";

const DATA_SOURCE_STORAGE_KEY = "aetrain-data-source";
const DATA_SOURCE_QUERY_PARAM = "source";
const PRODUCTION_BASE_PATHS = [
  new URL("../../public/data/production/", import.meta.url).href,
  new URL("../../data/production/", import.meta.url).href
];

function isKnownDataSourceId(value) {
  return value === "poc" || value === "production";
}

export function getRequestedDataSourceId() {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get(DATA_SOURCE_QUERY_PARAM);
  if (isKnownDataSourceId(fromQuery)) {
    return fromQuery;
  }

  try {
    const stored = window.localStorage.getItem(DATA_SOURCE_STORAGE_KEY);
    if (isKnownDataSourceId(stored)) {
      return stored;
    }
  } catch {}

  return "poc";
}

export function navigateToDataSource(sourceId) {
  if (!isKnownDataSourceId(sourceId)) {
    return;
  }

  try {
    window.localStorage.setItem(DATA_SOURCE_STORAGE_KEY, sourceId);
  } catch {}

  const url = new URL(window.location.href);
  if (sourceId === "poc") {
    url.searchParams.delete(DATA_SOURCE_QUERY_PARAM);
  } else {
    url.searchParams.set(DATA_SOURCE_QUERY_PARAM, sourceId);
  }

  window.location.assign(url.toString());
}

export async function loadPlannerDataSource(sourceId) {
  if (sourceId === "production") {
    return loadProductionDataSource();
  }

  return {
    id: "poc",
    label: "POC",
    description: "Embedded proof-of-concept dataset.",
    cities: pocCities,
    routeData: pocRouteData
  };
}

async function loadProductionDataSource() {
  try {
    return await loadProductionDataSourceFromWorker();
  } catch (error) {
    console.warn("Falling back to inline production dataset loader", error);
    return loadProductionDataSourceInline();
  }
}

async function loadProductionDataSourceInline() {
  const [meta, rawCities, rawEdges] = await Promise.all([
    fetchJsonWithFallback("meta.json"),
    fetchJsonWithFallback("cities.json"),
    fetchJsonWithFallback("edges.json")
  ]);

  return buildProductionPlannerData({ meta, rawCities, rawEdges });
}

async function loadProductionDataSourceFromWorker() {
  if (typeof Worker === "undefined") {
    throw new Error("Worker API unavailable");
  }

  const worker = new Worker(new URL("../workers/runtime-data.worker.js", import.meta.url), {
    type: "module"
  });

  return new Promise((resolve, reject) => {
    const requestId = `production-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    function cleanup() {
      worker.terminate();
    }

    worker.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.requestId !== requestId) {
        return;
      }

      cleanup();
      if (message.ok) {
        resolve(message.dataset);
        return;
      }

      reject(deserializeWorkerError(message.error));
    });

    worker.addEventListener("error", (event) => {
      cleanup();
      reject(event.error || new Error(event.message || "Worker error"));
    });

    worker.postMessage({
      type: "load-production-dataset",
      requestId,
      basePaths: PRODUCTION_BASE_PATHS
    });
  });
}

async function fetchJsonWithFallback(fileName) {
  let lastError = null;
  for (const basePath of PRODUCTION_BASE_PATHS) {
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

function deserializeWorkerError(error) {
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
