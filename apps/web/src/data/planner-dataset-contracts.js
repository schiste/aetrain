const KNOWN_DATA_SOURCE_IDS = new Set(["poc", "production"]);

export function isKnownPlannerDataSourceId(value) {
  return KNOWN_DATA_SOURCE_IDS.has(value);
}

export function assertPlannerDataset(dataset, context = "planner dataset") {
  assertRecord(dataset, context);

  if (!isKnownPlannerDataSourceId(dataset.id)) {
    throw new Error(
      `${context} must use a known source id, received ${JSON.stringify(dataset.id)}`
    );
  }

  assertString(dataset.label, `${context}.label`);
  assertString(dataset.description, `${context}.description`);
  assertCities(dataset.cities, `${context}.cities`);
  assertRouteData(dataset.routeData, `${context}.routeData`);
  if (dataset.plannerArtifacts !== undefined) {
    assertPlannerArtifacts(dataset.plannerArtifacts, `${context}.plannerArtifacts`);
  }

  if (dataset.meta !== undefined) {
    assertRuntimeArtifactMeta(dataset.meta, `${context}.meta`);
  }

  return dataset;
}

export function assertProductionArtifactBundle(bundle, context = "production artifact bundle") {
  assertRecord(bundle, context);
  assertRuntimeArtifactMeta(bundle.meta, `${context}.meta`);
  assertRuntimeCities(bundle.rawCities, `${context}.rawCities`);
  assertRuntimeEdges(bundle.rawEdges, `${context}.rawEdges`);
  return bundle;
}

function assertRuntimeArtifactMeta(meta, context) {
  assertRecord(meta, context);
  assertString(meta.dataset_version, `${context}.dataset_version`);

  if (typeof meta.schema_version !== "number" || !Number.isFinite(meta.schema_version)) {
    throw new Error(`${context}.schema_version must be a finite number`);
  }

  if (meta.generated_at !== undefined) {
    assertString(meta.generated_at, `${context}.generated_at`);
  }
}

function assertCities(cities, context) {
  if (!Array.isArray(cities)) {
    throw new Error(`${context} must be an array`);
  }

  for (let index = 0; index < cities.length; index += 1) {
    const city = cities[index];
    const cityContext = `${context}[${index}]`;
    assertRecord(city, cityContext);
    assertString(city.name, `${cityContext}.name`);
    assertString(city.country, `${cityContext}.country`);
    assertFiniteNumber(city.lat, `${cityContext}.lat`);
    assertFiniteNumber(city.lon, `${cityContext}.lon`);
    assertFiniteNumber(city.pop, `${cityContext}.pop`);
    assertFiniteNumber(city.interest, `${cityContext}.interest`);
  }
}

function assertRouteData(routeData, context) {
  assertRecord(routeData, context);

  for (const [routeKey, durationMinutes] of Object.entries(routeData)) {
    if (!routeKey || !routeKey.includes("-")) {
      throw new Error(`${context} contains an invalid route key: ${JSON.stringify(routeKey)}`);
    }

    if (typeof durationMinutes !== "number" || !Number.isFinite(durationMinutes)) {
      throw new Error(`${context}.${routeKey} must be a finite number`);
    }

    if (durationMinutes < 0) {
      throw new Error(`${context}.${routeKey} must be non-negative`);
    }
  }
}

function assertRuntimeCities(rawCities, context) {
  if (!Array.isArray(rawCities)) {
    throw new Error(`${context} must be an array`);
  }

  for (let index = 0; index < rawCities.length; index += 1) {
    const city = rawCities[index];
    const cityContext = `${context}[${index}]`;
    assertRecord(city, cityContext);
    assertString(city.city_id, `${cityContext}.city_id`);
    assertString(city.display_name, `${cityContext}.display_name`);
    assertString(city.country_code, `${cityContext}.country_code`);
    assertLocation(city.location, `${cityContext}.location`);

    if (city.population !== undefined && city.population !== null) {
      assertFiniteNumber(city.population, `${cityContext}.population`);
    }

    if (city.interest_score !== undefined && city.interest_score !== null) {
      assertFiniteNumber(city.interest_score, `${cityContext}.interest_score`);
    }
  }
}

function assertRuntimeEdges(rawEdges, context) {
  if (!Array.isArray(rawEdges)) {
    throw new Error(`${context} must be an array`);
  }

  for (let index = 0; index < rawEdges.length; index += 1) {
    const edge = rawEdges[index];
    const edgeContext = `${context}[${index}]`;
    assertRecord(edge, edgeContext);
    assertString(edge.from_city_id, `${edgeContext}.from_city_id`);
    assertString(edge.to_city_id, `${edgeContext}.to_city_id`);
    assertFiniteNumber(edge.duration_min, `${edgeContext}.duration_min`);
  }
}

function assertPlannerArtifacts(artifacts, context) {
  assertRecord(artifacts, context);

  if (artifacts.routePairs !== undefined) {
    if (!Array.isArray(artifacts.routePairs)) {
      throw new Error(`${context}.routePairs must be an array`);
    }

    for (let index = 0; index < artifacts.routePairs.length; index += 1) {
      const route = artifacts.routePairs[index];
      const routeContext = `${context}.routePairs[${index}]`;
      assertRecord(route, routeContext);
      assertString(route.from, `${routeContext}.from`);
      assertString(route.to, `${routeContext}.to`);
      assertFiniteNumber(route.minutes, `${routeContext}.minutes`);
    }
  }

  if (artifacts.searchIndex !== undefined) {
    if (!Array.isArray(artifacts.searchIndex)) {
      throw new Error(`${context}.searchIndex must be an array`);
    }

    for (let index = 0; index < artifacts.searchIndex.length; index += 1) {
      const entry = artifacts.searchIndex[index];
      const entryContext = `${context}.searchIndex[${index}]`;
      assertRecord(entry, entryContext);
      assertFiniteNumber(entry.cityIndex, `${entryContext}.cityIndex`);
      assertString(entry.cityNameNormalized, `${entryContext}.cityNameNormalized`);
      assertString(entry.countryNormalized, `${entryContext}.countryNormalized`);
      assertString(entry.searchText, `${entryContext}.searchText`);
    }
  }
}

function assertLocation(location, context) {
  assertRecord(location, context);
  assertFiniteNumber(location.lat, `${context}.lat`);
  assertFiniteNumber(location.lon, `${context}.lon`);
}

function assertRecord(value, context) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${context} must be an object`);
  }
}

function assertString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertFiniteNumber(value, context) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
}
