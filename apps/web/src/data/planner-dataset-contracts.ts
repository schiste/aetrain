import type {
  GeoPoint,
  PlannerArtifacts,
  PlannerDataset,
  ProductionArtifactBundle,
  RawCity,
  RawCityLocation,
  RawEdge,
  RawEdgeGeometries,
  RawEdgeGeometryPoint,
  RoutePair,
  RuntimeArtifactMeta,
  SearchIndexEntry
} from "../types/planner-dataset.ts";

export function assertPlannerDataset(
  dataset: unknown,
  context = "planner dataset"
): PlannerDataset {
  assertRecord(dataset, context);

  if (dataset.id !== "production") {
    throw new Error(
      `${context} must have id "production", received ${JSON.stringify(dataset.id)}`
    );
  }

  assertString(dataset.label, `${context}.label`);
  assertString(dataset.description, `${context}.description`);
  assertCities(dataset.cities, `${context}.cities`);
  assertRouteData(dataset.routeData, `${context}.routeData`);
  if (dataset.plannerArtifacts !== undefined) {
    assertPlannerArtifacts(
      dataset.plannerArtifacts,
      `${context}.plannerArtifacts`
    );
  }

  if (dataset.meta !== undefined) {
    assertRuntimeArtifactMeta(dataset.meta, `${context}.meta`);
  }

  return dataset as unknown as PlannerDataset;
}

export function assertProductionArtifactBundle(
  bundle: unknown,
  context = "production artifact bundle"
): ProductionArtifactBundle {
  assertRecord(bundle, context);
  assertRuntimeArtifactMeta(bundle.meta, `${context}.meta`);
  assertRuntimeCities(bundle.rawCities, `${context}.rawCities`);
  assertRuntimeEdges(bundle.rawEdges, `${context}.rawEdges`);
  assertRuntimeEdgeGeometries(
    bundle.rawEdgeGeometries,
    `${context}.rawEdgeGeometries`
  );
  return bundle as unknown as ProductionArtifactBundle;
}

function assertRuntimeArtifactMeta(
  meta: unknown,
  context: string
): asserts meta is RuntimeArtifactMeta {
  assertRecord(meta, context);
  assertString(meta.dataset_version, `${context}.dataset_version`);

  if (
    typeof meta.schema_version !== "number"
    || !Number.isFinite(meta.schema_version)
  ) {
    throw new Error(`${context}.schema_version must be a finite number`);
  }

  if (meta.generated_at !== undefined) {
    assertString(meta.generated_at, `${context}.generated_at`);
  }
}

function assertCities(cities: unknown, context: string): void {
  if (!Array.isArray(cities)) {
    throw new Error(`${context} must be an array`);
  }

  for (let index = 0; index < cities.length; index += 1) {
    const cityContext = `${context}[${index}]`;
    const city = cities[index];
    assertRecord(city, cityContext);
    assertString(city.name, `${cityContext}.name`);
    assertString(city.country, `${cityContext}.country`);
    assertFiniteNumber(city.lat, `${cityContext}.lat`);
    assertFiniteNumber(city.lon, `${cityContext}.lon`);
    assertFiniteNumber(city.pop, `${cityContext}.pop`);
    assertFiniteNumber(city.interest, `${cityContext}.interest`);
  }
}

function assertRouteData(routeData: unknown, context: string): void {
  assertRecord(routeData, context);

  for (const [routeKey, durationMinutes] of Object.entries(routeData)) {
    if (!routeKey || !routeKey.includes("-")) {
      throw new Error(
        `${context} contains an invalid route key: ${JSON.stringify(routeKey)}`
      );
    }

    if (typeof durationMinutes !== "number" || !Number.isFinite(durationMinutes)) {
      throw new Error(`${context}.${routeKey} must be a finite number`);
    }

    if (durationMinutes < 0) {
      throw new Error(`${context}.${routeKey} must be non-negative`);
    }
  }
}

function assertRuntimeCities(
  rawCities: unknown,
  context: string
): asserts rawCities is RawCity[] {
  if (!Array.isArray(rawCities)) {
    throw new Error(`${context} must be an array`);
  }

  for (let index = 0; index < rawCities.length; index += 1) {
    const cityContext = `${context}[${index}]`;
    const city = rawCities[index];
    assertRecord(city, cityContext);
    assertString(city.city_id, `${cityContext}.city_id`);
    assertString(city.display_name, `${cityContext}.display_name`);
    assertString(city.country_code, `${cityContext}.country_code`);
    assertLocation(city.location, `${cityContext}.location`);
    if (city.map_location !== undefined && city.map_location !== null) {
      assertLocation(city.map_location, `${cityContext}.map_location`);
    }
    if (city.rail_profile !== undefined && city.rail_profile !== null) {
      assertCityRailProfile(city.rail_profile, `${cityContext}.rail_profile`);
    }

    if (city.population !== undefined && city.population !== null) {
      assertFiniteNumber(city.population, `${cityContext}.population`);
    }

    if (city.interest_score !== undefined && city.interest_score !== null) {
      assertFiniteNumber(city.interest_score, `${cityContext}.interest_score`);
    }
  }
}

function assertCityRailProfile(profile: unknown, context: string): void {
  assertRecord(profile, context);
  assertString(profile.city_id, `${context}.city_id`);
  assertLocation(profile.map_location, `${context}.map_location`);
  assertString(profile.anchor_strategy, `${context}.anchor_strategy`);
  assertString(profile.confidence, `${context}.confidence`);
  assertFiniteNumber(profile.terminal_count, `${context}.terminal_count`);
  assertFiniteNumber(profile.terminal_spread_m, `${context}.terminal_spread_m`);
  assertFiniteNumber(
    profile.civic_to_map_distance_m,
    `${context}.civic_to_map_distance_m`
  );

  if (!Array.isArray(profile.terminal_station_ids)) {
    throw new Error(`${context}.terminal_station_ids must be an array`);
  }
  for (let index = 0; index < profile.terminal_station_ids.length; index += 1) {
    assertString(
      profile.terminal_station_ids[index],
      `${context}.terminal_station_ids[${index}]`
    );
  }

  if (!Array.isArray(profile.terminals)) {
    throw new Error(`${context}.terminals must be an array`);
  }
  for (let index = 0; index < profile.terminals.length; index += 1) {
    const terminalContext = `${context}.terminals[${index}]`;
    const terminal = profile.terminals[index];
    assertRecord(terminal, terminalContext);
    if (terminal.station_id !== undefined && terminal.station_id !== null) {
      assertString(terminal.station_id, `${terminalContext}.station_id`);
    }
    if (terminal.display_name !== undefined && terminal.display_name !== null) {
      assertString(terminal.display_name, `${terminalContext}.display_name`);
    }
    if (terminal.station_location !== undefined && terminal.station_location !== null) {
      assertLocation(terminal.station_location, `${terminalContext}.station_location`);
    }
    assertLocation(terminal.rail_location, `${terminalContext}.rail_location`);
    if (
      terminal.station_to_rail_distance_m !== undefined &&
      terminal.station_to_rail_distance_m !== null
    ) {
      assertFiniteNumber(
        terminal.station_to_rail_distance_m,
        `${terminalContext}.station_to_rail_distance_m`
      );
    }
    assertFiniteNumber(
      terminal.edge_endpoint_use_count,
      `${terminalContext}.edge_endpoint_use_count`
    );
  }
}

function assertRuntimeEdges(
  rawEdges: unknown,
  context: string
): asserts rawEdges is RawEdge[] {
  if (!Array.isArray(rawEdges)) {
    throw new Error(`${context} must be an array`);
  }

  for (let index = 0; index < rawEdges.length; index += 1) {
    const edgeContext = `${context}[${index}]`;
    const edge = rawEdges[index];
    assertRecord(edge, edgeContext);
    assertString(edge.from_city_id, `${edgeContext}.from_city_id`);
    assertString(edge.to_city_id, `${edgeContext}.to_city_id`);
    assertFiniteNumber(edge.duration_min, `${edgeContext}.duration_min`);
  }
}

function assertRuntimeEdgeGeometries(
  rawEdgeGeometries: unknown,
  context: string
): asserts rawEdgeGeometries is RawEdgeGeometries {
  assertRecord(rawEdgeGeometries, context);
  if (!Array.isArray(rawEdgeGeometries.geometries)) {
    throw new Error(`${context}.geometries must be an array`);
  }

  for (let index = 0; index < rawEdgeGeometries.geometries.length; index += 1) {
    const geometryContext = `${context}.geometries[${index}]`;
    const geometry = rawEdgeGeometries.geometries[index];
    assertRecord(geometry, geometryContext);
    assertString(geometry.from_city_id, `${geometryContext}.from_city_id`);
    assertString(geometry.to_city_id, `${geometryContext}.to_city_id`);
    assertString(geometry.source, `${geometryContext}.source`);
    assertPolylinePoints(geometry.points, `${geometryContext}.points`);
  }
}

function assertPlannerArtifacts(
  artifacts: unknown,
  context: string
): asserts artifacts is PlannerArtifacts {
  assertRecord(artifacts, context);

  if (artifacts.routePairs !== undefined) {
    if (!Array.isArray(artifacts.routePairs)) {
      throw new Error(`${context}.routePairs must be an array`);
    }

    for (let index = 0; index < artifacts.routePairs.length; index += 1) {
      const routeContext = `${context}.routePairs[${index}]`;
      const route = artifacts.routePairs[index];
      assertRecord(route, routeContext);
      assertString(route.from, `${routeContext}.from`);
      assertString(route.to, `${routeContext}.to`);
      assertFiniteNumber(route.minutes, `${routeContext}.minutes`);
      const routeRecord = route as Record<string, unknown>;
      if (routeRecord.geometry !== undefined) {
        assertLatLonPolyline(
          routeRecord.geometry,
          `${routeContext}.geometry`
        );
      }
    }
  }

  if (artifacts.searchIndex !== undefined) {
    if (!Array.isArray(artifacts.searchIndex)) {
      throw new Error(`${context}.searchIndex must be an array`);
    }

    for (let index = 0; index < artifacts.searchIndex.length; index += 1) {
      const entryContext = `${context}.searchIndex[${index}]`;
      const entry = artifacts.searchIndex[index];
      assertRecord(entry, entryContext);
      const entryRecord = entry as Record<string, unknown>;
      assertFiniteNumber(entryRecord.cityIndex, `${entryContext}.cityIndex`);
      assertString(entryRecord.cityNameNormalized, `${entryContext}.cityNameNormalized`);
      assertString(entryRecord.countryNormalized, `${entryContext}.countryNormalized`);
      assertString(entryRecord.searchText, `${entryContext}.searchText`);
    }
  }

  if (artifacts.nameByCityId !== undefined) {
    assertRecord(artifacts.nameByCityId, `${context}.nameByCityId`);
    for (const [cityId, displayName] of Object.entries(artifacts.nameByCityId)) {
      assertString(cityId, `${context}.nameByCityId key`);
      assertString(displayName, `${context}.nameByCityId[${cityId}]`);
    }
  }
}

function assertLocation(
  location: unknown,
  context: string
): asserts location is RawCityLocation {
  assertRecord(location, context);
  assertFiniteNumber(location.lat, `${context}.lat`);
  assertFiniteNumber(location.lon, `${context}.lon`);
}

function assertPolylinePoints(
  points: unknown,
  context: string
): asserts points is RawEdgeGeometryPoint[] {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error(`${context} must be an array with at least 2 points`);
  }

  for (let index = 0; index < points.length; index += 1) {
    const pointContext = `${context}[${index}]`;
    const point = points[index];
    assertRecord(point, pointContext);
    assertFiniteNumber(point.lat_e5, `${pointContext}.lat_e5`);
    assertFiniteNumber(point.lon_e5, `${pointContext}.lon_e5`);
  }
}

function assertLatLonPolyline(
  points: unknown,
  context: string
): asserts points is GeoPoint[] {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error(`${context} must be an array with at least 2 points`);
  }

  for (let index = 0; index < points.length; index += 1) {
    assertLocation(points[index], `${context}[${index}]`);
  }
}

function assertRecord(
  value: unknown,
  context: string
): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${context} must be an object`);
  }
}

function assertString(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertFiniteNumber(
  value: unknown,
  context: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
}
