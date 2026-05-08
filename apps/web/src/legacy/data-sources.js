import { cities as pocCities, routeData as pocRouteData } from "./data.js";

const DATA_SOURCE_STORAGE_KEY = "aetrain-data-source";
const DATA_SOURCE_QUERY_PARAM = "source";
const PRODUCTION_BASE_PATHS = ["./public/data/production", "./data/production"];

const COUNTRY_LABELS = {
  FR: "France",
  ZZ: "Imported"
};

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
  const [meta, rawCities, rawEdges] = await Promise.all([
    fetchJsonWithFallback("meta.json"),
    fetchJsonWithFallback("cities.json"),
    fetchJsonWithFallback("edges.json")
  ]);

  const neighborMap = new Map();
  for (const edge of rawEdges) {
    if (!neighborMap.has(edge.from_city_id)) {
      neighborMap.set(edge.from_city_id, new Set());
    }
    if (!neighborMap.has(edge.to_city_id)) {
      neighborMap.set(edge.to_city_id, new Set());
    }
    neighborMap.get(edge.from_city_id).add(edge.to_city_id);
    neighborMap.get(edge.to_city_id).add(edge.from_city_id);
  }

  const nameCount = new Map();
  for (const city of rawCities) {
    nameCount.set(city.display_name, (nameCount.get(city.display_name) || 0) + 1);
  }

  const usedNames = new Set();
  const nameByCityId = new Map();
  for (const city of rawCities) {
    let name = city.display_name;
    if ((nameCount.get(city.display_name) || 0) > 1) {
      name = `${city.display_name} (${countryLabel(city.country_code)})`;
    }
    if (usedNames.has(name)) {
      name = `${city.display_name} [${city.city_id}]`;
    }
    usedNames.add(name);
    nameByCityId.set(city.city_id, name);
  }

  const cities = rawCities.map((city) => {
    const degree = neighborMap.get(city.city_id)?.size || 0;
    const population = city.population ?? derivePopulation(degree, city.station_ids?.length || 1);
    const interest = city.interest_score ?? deriveInterest(degree);

    return {
      name: nameByCityId.get(city.city_id),
      lat: city.location.lat,
      lon: city.location.lon,
      country: countryLabel(city.country_code),
      pop: population,
      interest
    };
  });

  const routeData = {};
  for (const edge of rawEdges) {
    const from = nameByCityId.get(edge.from_city_id);
    const to = nameByCityId.get(edge.to_city_id);
    if (!from || !to || from === to) {
      continue;
    }

    const routeKey = from.localeCompare(to) <= 0 ? `${from}-${to}` : `${to}-${from}`;
    routeData[routeKey] = Math.min(routeData[routeKey] ?? Infinity, edge.duration_min);
  }

  return {
    id: "production",
    label: "Production",
    description: `SNCF Stage 1 debug snapshot · ${rawCities.length} cities · ${Object.keys(routeData).length} undirected routes · interest/pop derived heuristics`,
    meta,
    cities,
    routeData
  };
}

async function fetchJsonWithFallback(fileName) {
  let lastError = null;
  for (const basePath of PRODUCTION_BASE_PATHS) {
    try {
      const response = await fetch(`${basePath}/${fileName}`, { cache: "no-store" });
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

function countryLabel(countryCode) {
  return COUNTRY_LABELS[countryCode] || countryCode || "Unknown";
}

function deriveInterest(degree) {
  if (degree >= 14) return 9;
  if (degree >= 9) return 8;
  if (degree >= 6) return 7;
  if (degree >= 4) return 6;
  if (degree >= 2) return 5;
  if (degree >= 1) return 4;
  return 3;
}

function derivePopulation(degree, stationCount) {
  if (degree >= 14) return 600_000;
  if (degree >= 9) return 350_000;
  if (degree >= 6) return 220_000;
  if (degree >= 4) return 160_000;
  if (degree >= 2) return 110_000;
  return Math.max(50_000, stationCount * 25_000);
}
