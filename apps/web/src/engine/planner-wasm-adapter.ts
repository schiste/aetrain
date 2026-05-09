// WASM-backed PlannerModel implementation. Phase 1.4 of the WASM migration:
// the adapter speaks the same PlannerModel surface that planner-core.ts
// implements, so callers (the worker, the inline fallback path, tests) can
// swap engines without code changes.
//
// The Rust side owns:
//   * city/edge ingestion + invalid-edge accounting
//   * Dijkstra (single target + all reachable) — distances are u32 minutes
//     so results are byte-equivalent to the JS implementation
//   * findInterestingStops + searchCities ordering rules
//
// The adapter owns:
//   * mapping our PlannerCity / RoutePair shapes onto PlannerNodeInput /
//     PlannerEdgeInput (plus the routeData longest-prefix parser)
//   * an edge-geometry index keyed by canonical "from to" pairs (stored in
//     both directions so a path traversal can look up the segment regardless
//     of edge orientation)
//   * stitching the pair-by-pair WASM path back into a deduplicated
//     GeoPoint[] using the same join semantics as planner-core.ts'
//     appendGeometry
//   * an adjacency[] view + searchIndex view so legacy callers that read
//     these PlannerModel fields directly keep working

import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import type {
  GeoPoint,
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
  RoutePair,
  SearchIndexEntry
} from "../types/planner-dataset.ts";
import type {
  PlannerAdjacencyEntry,
  PlannerEdge,
  PlannerModel,
  PlannerReachableDistances,
  PlannerRouteResult,
  PlannerSearchIndexEntry,
  PlannerSegment,
  PlannerSuggestion,
  PlannerTripPlan
} from "../types/planner-engine.ts";
import {
  createWasmPlannerEngine,
  type PlannerEdgeInput,
  type PlannerNodeInput,
  type WasmPlannerEngine
} from "../../../../packages/ts/web-bindings/src/index.ts";

const diagnostics = createDiagnostics("web/engine/planner-wasm-adapter");

interface DerivedEdge {
  from: string;
  to: string;
  minutes: number;
  key: string;
  geometry?: GeoPoint[];
}

export async function createWasmPlannerModel(
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  options: PlannerArtifacts = {}
): Promise<PlannerModel> {
  const startedAt = now();

  // Derive the canonical edge list once: prefer routePairs (geometry-bearing)
  // and fall back to routeData (string-keyed, no geometry). Mirrors
  // planner-core.ts' buildPlannerGraph branch logic.
  const cityMap: Record<string, PlannerCity> = Object.fromEntries(
    cities.map((city) => [city.name, city])
  );
  const cityIndexByName = new Map<string, number>(
    cities.map((city, index) => [city.name, index])
  );
  const { derivedEdges, invalidFromInput } = deriveEdges(
    cities,
    routeData,
    options.routePairs,
    cityMap
  );

  const wasmNodes: PlannerNodeInput[] = cities.map((city) => ({
    name: city.name,
    lat: city.lat,
    lon: city.lon,
    country: city.country,
    population: city.pop,
    interest: city.interest
  }));
  const wasmEdges: PlannerEdgeInput[] = derivedEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    minutes: edge.minutes
  }));

  let wasmEngine: WasmPlannerEngine;
  try {
    wasmEngine = await createWasmPlannerEngine(wasmNodes, wasmEdges);
  } catch (error) {
    diagnostics.error("wasm planner engine construction failed", {
      city_count: cities.length,
      edge_count: wasmEdges.length,
      duration_ms: elapsedSince(startedAt),
      error: summarizeError(error)
    });
    throw error;
  }

  // Build the full PlannerEdge / PlannerAdjacencyEntry views the legacy
  // PlannerModel surface promises. Edges that point at unknown city names
  // were already siphoned into invalidFromInput; we still cross-check against
  // the WASM view to surface any extra invalid keys (self-loops the JS path
  // would silently drop, for example).
  const edges: PlannerEdge[] = [];
  const adjacency: PlannerAdjacencyEntry[][] = Array.from(
    { length: cities.length },
    () => []
  );
  const edgeGeometryIndex = new Map<string, GeoPoint[]>();

  for (const derived of derivedEdges) {
    const fromIndex = cityIndexByName.get(derived.from);
    const toIndex = cityIndexByName.get(derived.to);
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) {
      // The WASM engine will have already pushed this into invalidEdgeKeys —
      // we just skip locally so adjacency stays consistent.
      continue;
    }

    const fromAdj = adjacency[fromIndex];
    const toAdj = adjacency[toIndex];
    if (!fromAdj || !toAdj) {
      continue;
    }

    const reversed = reverseGeometry(derived.geometry);
    fromAdj.push({
      toIndex,
      t: derived.minutes,
      geometry: derived.geometry
    });
    toAdj.push({
      toIndex: fromIndex,
      t: derived.minutes,
      geometry: reversed
    });
    edges.push({
      from: derived.from,
      fromIndex,
      to: derived.to,
      toIndex,
      minutes: derived.minutes,
      key: derived.key,
      geometry: derived.geometry
    });

    if (derived.geometry && derived.geometry.length > 0) {
      // Index the geometry both ways so path stitching does not care which
      // direction the path traversal walked the edge in.
      edgeGeometryIndex.set(geometryKey(derived.from, derived.to), derived.geometry);
      if (reversed) {
        edgeGeometryIndex.set(geometryKey(derived.to, derived.from), reversed);
      }
    }
  }

  // Merge invalid-key sources. Use a Set to dedupe — WASM and the input
  // derivation can both flag the same key and we only want to surface it
  // once.
  const wasmInvalidKeys = wasmEngine.invalidEdgeKeys();
  const invalidRouteKeys = Array.from(
    new Set([...invalidFromInput, ...wasmInvalidKeys])
  );

  const searchIndex = createSearchIndex(cities, options.searchIndex);

  const model: PlannerModel = {
    cities,
    cityMap,
    edges,
    invalidRouteKeys,
    adjacency,
    cityIndexByName,
    searchIndex,
    dijkstra,
    dijkstraAll,
    findInterestingStops,
    deriveTripPlan,
    searchCities
  };

  diagnostics.info("wasm planner model constructed", {
    city_count: cities.length,
    edge_count: wasmEngine.edgeCount(),
    invalid_route_count: invalidRouteKeys.length,
    duration_ms: elapsedSince(startedAt)
  });

  return model;

  function dijkstra(startName: string, endName: string): PlannerRouteResult | null {
    const callStartedAt = now();
    if (startName === endName) {
      // Mirror planner-core.ts: a zero-length trip returns time=0 and a single
      // entry path. We still emit a (trivial) geometry so downstream code can
      // treat the field uniformly.
      return {
        time: 0,
        path: [startName],
        geometry: singletonGeometry(startName)
      };
    }

    const result = wasmEngine.shortestPath(startName, endName);
    if (!result) {
      diagnostics.debug("wasm dijkstra: no path", {
        from: startName,
        to: endName,
        duration_ms: elapsedSince(callStartedAt)
      });
      return null;
    }

    const stitched: PlannerRouteResult = {
      time: result.time,
      path: result.path,
      geometry: stitchPathGeometry(result.path)
    };
    diagnostics.debug("wasm dijkstra: ok", {
      from: startName,
      to: endName,
      time: stitched.time,
      hops: stitched.path.length,
      duration_ms: elapsedSince(callStartedAt)
    });
    return stitched;
  }

  function dijkstraAll(startName: string): PlannerReachableDistances {
    const callStartedAt = now();
    if (!cityIndexByName.has(startName)) {
      return {};
    }
    const distances = wasmEngine.shortestPathAll(startName);
    diagnostics.debug("wasm dijkstraAll", {
      from: startName,
      reachable_count: Object.keys(distances).length,
      duration_ms: elapsedSince(callStartedAt)
    });
    return distances;
  }

  function findInterestingStops(
    segments: (PlannerSegment | null)[],
    tripNames: string[]
  ): PlannerSuggestion[] {
    const callStartedAt = now();
    const validSegments = segments.filter(
      (segment): segment is PlannerSegment => segment !== null
    );
    const wasmInputSegments = validSegments.map((segment) => ({
      time: segment.time,
      path: segment.path
    }));

    const wasmResults = wasmEngine.findInterestingStops(tripNames, wasmInputSegments);
    const suggestions: PlannerSuggestion[] = [];
    for (const raw of wasmResults) {
      const city = cityMap[raw.name];
      if (!city) {
        // The WASM engine only emits names of cities it knows about, so this
        // is essentially impossible — guard for safety.
        continue;
      }
      suggestions.push({
        name: raw.name,
        city,
        afterStop: raw.afterStop,
        detourMin: raw.detourMin
      });
    }
    diagnostics.debug("wasm findInterestingStops", {
      trip_length: tripNames.length,
      segment_count: validSegments.length,
      suggestion_count: suggestions.length,
      duration_ms: elapsedSince(callStartedAt)
    });
    return suggestions;
  }

  function deriveTripPlan(trip: string[]): PlannerTripPlan {
    const callStartedAt = now();
    const segments: (PlannerSegment | null)[] = [];
    for (let index = 0; index < trip.length - 1; index += 1) {
      const from = trip[index];
      const to = trip[index + 1];
      if (from === undefined || to === undefined) {
        segments.push(null);
        continue;
      }
      segments.push(dijkstra(from, to));
    }

    const lastStop = trip.length >= 1 ? trip[trip.length - 1] : undefined;
    const distFromLast: PlannerReachableDistances =
      lastStop !== undefined ? dijkstraAll(lastStop) : {};

    const plan: PlannerTripPlan = {
      distFromLast,
      segments,
      suggestions: findInterestingStops(segments, trip)
    };
    diagnostics.info("wasm deriveTripPlan", {
      trip_length: trip.length,
      segment_count: segments.length,
      suggestion_count: plan.suggestions.length,
      duration_ms: elapsedSince(callStartedAt)
    });
    return plan;
  }

  function searchCities(query: string, limit?: number): PlannerCity[] {
    const callStartedAt = now();
    const effectiveLimit = typeof limit === "number" && limit > 0 ? limit : 14;
    if (typeof query !== "string" || query.trim().length === 0) {
      return [];
    }
    const wasmResults = wasmEngine.searchCities(query, effectiveLimit);
    const out: PlannerCity[] = [];
    for (const node of wasmResults) {
      const city = cityMap[node.name];
      if (city) {
        out.push(city);
      }
    }
    diagnostics.debug("wasm searchCities", {
      query_length: query.length,
      result_count: out.length,
      limit: effectiveLimit,
      duration_ms: elapsedSince(callStartedAt)
    });
    return out;
  }

  function stitchPathGeometry(path: string[]): GeoPoint[] {
    const merged: GeoPoint[] = [];
    for (let index = 1; index < path.length; index += 1) {
      const fromName = path[index - 1];
      const toName = path[index];
      if (fromName === undefined || toName === undefined) continue;
      const fromCity = cityMap[fromName];
      const toCity = cityMap[toName];
      if (!fromCity || !toCity) continue;

      const segmentGeometry =
        edgeGeometryIndex.get(geometryKey(fromName, toName)) ??
        defaultEdgeGeometry(fromCity, toCity);
      appendGeometry(merged, segmentGeometry);
    }
    return merged;
  }

  function singletonGeometry(name: string): GeoPoint[] | undefined {
    const city = cityMap[name];
    if (!city) return undefined;
    return [{ lat: city.lat, lon: city.lon }];
  }
}

function deriveEdges(
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  routePairs: readonly RoutePair[] | undefined,
  cityMap: Record<string, PlannerCity>
): { derivedEdges: DerivedEdge[]; invalidFromInput: string[] } {
  const derivedEdges: DerivedEdge[] = [];
  const invalidFromInput: string[] = [];

  if (Array.isArray(routePairs) && routePairs.length > 0) {
    for (const pair of routePairs) {
      derivedEdges.push({
        from: pair.from,
        to: pair.to,
        minutes: pair.minutes,
        key: `${pair.from}-${pair.to}`,
        geometry: pair.geometry
      });
    }
  } else {
    const parseRouteKey = parseRouteKeyFactory(cityMap);
    for (const [routeKey, travelMinutes] of Object.entries(routeData || {})) {
      const endpoints = parseRouteKey(routeKey);
      if (!endpoints) {
        invalidFromInput.push(routeKey);
        continue;
      }
      derivedEdges.push({
        from: endpoints[0],
        to: endpoints[1],
        minutes: travelMinutes,
        key: routeKey
      });
    }
  }

  // Avoid `cities` lint hint while keeping the parameter for symmetry with
  // planner-core.ts' signature.
  void cities;

  return { derivedEdges, invalidFromInput };
}

function parseRouteKeyFactory(
  cityMap: Record<string, PlannerCity>
): (routeKey: string) => [string, string] | null {
  // Longest-name-first lets us disambiguate "Aix-en-Provence-Marseille" from
  // "Aix-Marseille" without explicit separators (city names contain
  // hyphens). Same algorithm as planner-core.ts.
  const cityNames = Object.keys(cityMap).sort(
    (left, right) => right.length - left.length
  );

  return function parseRouteKey(routeKey: string): [string, string] | null {
    for (const cityName of cityNames) {
      const prefix = `${cityName}-`;
      if (!routeKey.startsWith(prefix)) {
        continue;
      }
      const destination = routeKey.slice(prefix.length);
      if (cityMap[destination]) {
        return [cityName, destination];
      }
    }
    return null;
  };
}

function createSearchIndex(
  cities: PlannerCity[],
  searchEntries?: SearchIndexEntry[]
): PlannerSearchIndexEntry[] {
  if (Array.isArray(searchEntries) && searchEntries.length > 0) {
    const entries: PlannerSearchIndexEntry[] = [];
    for (const entry of searchEntries) {
      const city = cities[entry.cityIndex];
      if (!city) continue;
      entries.push({
        city,
        cityNameNormalized: entry.cityNameNormalized,
        countryNormalized: entry.countryNormalized,
        searchText: entry.searchText
      });
    }
    return entries;
  }

  return [...cities]
    .sort(
      (left, right) =>
        right.interest - left.interest ||
        right.pop - left.pop ||
        left.name.localeCompare(right.name)
    )
    .map((city): PlannerSearchIndexEntry => {
      const cityNameNormalized = normalizeSearchQuery(city.name);
      const countryNormalized = normalizeSearchQuery(city.country);
      return {
        city,
        cityNameNormalized,
        countryNormalized,
        searchText: `${cityNameNormalized} ${countryNormalized}`
      };
    });
}

function normalizeSearchQuery(query: unknown): string {
  return String(query ?? "")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function reverseGeometry(geometry: GeoPoint[] | undefined): GeoPoint[] | undefined {
  if (!Array.isArray(geometry)) return undefined;
  return [...geometry].reverse();
}

function appendGeometry(target: GeoPoint[], segment: GeoPoint[]): GeoPoint[] {
  if (!Array.isArray(segment) || segment.length === 0) {
    return target;
  }
  for (const point of segment) {
    const last = target[target.length - 1];
    if (last && last.lat === point.lat && last.lon === point.lon) {
      continue;
    }
    target.push(point);
  }
  return target;
}

function defaultEdgeGeometry(from: PlannerCity, to: PlannerCity): GeoPoint[] {
  return [
    { lat: from.lat, lon: from.lon },
    { lat: to.lat, lon: to.lon }
  ];
}

function geometryKey(from: string, to: string): string {
  // Space separator is unambiguous: city names contain hyphens but never
  // spaces with leading/trailing whitespace in our datasets, and a single
  // ASCII space is distinct from any character used in route keys.
  return `${from} ${to}`;
}

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function elapsedSince(startedAt: number): number {
  return Math.round((now() - startedAt) * 1000) / 1000;
}
