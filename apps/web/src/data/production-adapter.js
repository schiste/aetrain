const COUNTRY_LABELS = {
  FR: "France",
  ZZ: "Imported"
};

export function buildProductionPlannerData({ meta, rawCities, rawEdges }) {
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
