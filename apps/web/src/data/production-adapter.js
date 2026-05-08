import { createDiagnostics } from "../app-shell/diagnostics.js";
import {
  assertPlannerDataset,
  assertProductionArtifactBundle
} from "./planner-dataset-contracts.js";

const COUNTRY_LABELS = {
  FR: "France",
  ZZ: "Imported"
};
const diagnostics = createDiagnostics("web/data/production-adapter");

export function buildProductionPlannerData({ meta, rawCities, rawEdges, rawEdgeGeometries }) {
  assertProductionArtifactBundle(
    { meta, rawCities, rawEdges, rawEdgeGeometries },
    "Production runtime artifact bundle"
  );
  diagnostics.debug("adapting production runtime bundle", {
    dataset_version: meta.dataset_version,
    raw_city_count: rawCities.length,
    raw_edge_count: rawEdges.length,
    raw_geometry_count: rawEdgeGeometries.geometries.length
  });

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

  const fallbackLocationByCityId = new Map(
    rawCities.map((city) => [city.city_id, city.location])
  );
  const geometryByDirectedKey = new Map();
  for (const geometry of rawEdgeGeometries.geometries) {
    geometryByDirectedKey.set(
      `${geometry.from_city_id}->${geometry.to_city_id}`,
      decodeGeometryPoints(geometry.points)
    );
  }

  const routeData = {};
  const routePairs = [];
  for (const edge of rawEdges) {
    const from = nameByCityId.get(edge.from_city_id);
    const to = nameByCityId.get(edge.to_city_id);
    if (!from || !to || from === to) {
      continue;
    }

    routePairs.push({
      from,
      minutes: edge.duration_min,
      to,
      geometry:
        geometryByDirectedKey.get(`${edge.from_city_id}->${edge.to_city_id}`) ||
        [
          fallbackLocationByCityId.get(edge.from_city_id),
          fallbackLocationByCityId.get(edge.to_city_id)
        ].filter(Boolean)
    });
    const routeKey = from.localeCompare(to) <= 0 ? `${from}-${to}` : `${to}-${from}`;
    routeData[routeKey] = Math.min(routeData[routeKey] ?? Infinity, edge.duration_min);
  }

  const searchIndex = cities.map((city, cityIndex) => {
    const cityNameNormalized = normalizeSearchValue(city.name);
    const countryNormalized = normalizeSearchValue(city.country);
    return {
      cityIndex,
      cityNameNormalized,
      countryNormalized,
      searchText: `${cityNameNormalized} ${countryNormalized}`
    };
  });

  const dataset = assertPlannerDataset({
    id: "production",
    label: "Production",
    description: `SNCF Stage 1 debug snapshot · ${rawCities.length} cities · ${Object.keys(routeData).length} undirected routes · interest/pop derived heuristics`,
    meta,
    cities,
    plannerArtifacts: {
      routePairs,
      searchIndex
    },
    routeData
  }, "Production planner dataset");
  diagnostics.info("adapted production planner dataset", {
    dataset_version: dataset.meta?.dataset_version || null,
    city_count: dataset.cities.length,
    route_count: Object.keys(dataset.routeData).length
  });
  return dataset;
}

function decodeGeometryPoints(points) {
  return points.map((point) => ({
    lat: point.lat_e5 / 100_000,
    lon: point.lon_e5 / 100_000
  }));
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

function normalizeSearchValue(value) {
  return String(value || "")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}
