import type {
  GeoPoint,
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
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

interface PlannerGraph {
  adjacency: PlannerAdjacencyEntry[][];
  cities: PlannerCity[];
  cityIndexByName: Map<string, number>;
  cityMap: Record<string, PlannerCity>;
  edges: PlannerEdge[];
  invalidRouteKeys: string[];
  searchIndex: PlannerSearchIndexEntry[];
}

interface DijkstraIndexedResult {
  distance: number;
  pathIndexes: number[];
}

interface MinHeapItem {
  distance: number;
  node: number;
}

interface MinHeap {
  isEmpty(): boolean;
  pop(): MinHeapItem | null;
  push(node: number, distance: number): void;
}

interface DeriveTripContext {
  dijkstra(startName: string, endName: string): PlannerRouteResult | null;
  dijkstraAll(startName: string): PlannerReachableDistances;
  findInterestingStops(
    segments: (PlannerSegment | null)[],
    tripNames: string[]
  ): PlannerSuggestion[];
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes !== 0 && !minutes) {
    return "—";
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  if (hours > 0) {
    return remainder > 0 ? `${hours}h${String(remainder).padStart(2, "0")}` : `${hours}h`;
  }

  return `${remainder}min`;
}

export function formatPopulation(population: number): string {
  if (population >= 1_000_000) {
    return `${(population / 1_000_000).toFixed(1)}M`;
  }

  return `${Math.round(population / 1_000)}k`;
}

export function haversine(a: GeoPoint, b: GeoPoint): number {
  const radiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return radiusKm * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function buildPlannerGraph(
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  options: PlannerArtifacts = {}
): PlannerGraph {
  const cityMap: Record<string, PlannerCity> = Object.fromEntries(
    cities.map((city) => [city.name, city])
  );
  const cityIndexByName = new Map<string, number>(
    cities.map((city, index) => [city.name, index])
  );
  const adjacency: PlannerAdjacencyEntry[][] = Array.from(
    { length: cities.length },
    () => []
  );
  const edges: PlannerEdge[] = [];
  const invalidRouteKeys: string[] = [];
  const parseRouteKey = parseRouteKeyFactory(cityMap);

  if (Array.isArray(options.routePairs) && options.routePairs.length > 0) {
    for (const routePair of options.routePairs) {
      addRoute(
        routePair.from,
        routePair.to,
        routePair.minutes,
        `${routePair.from}-${routePair.to}`,
        routePair.geometry
      );
    }
  } else {
    for (const [routeKey, travelMinutes] of Object.entries(routeData || {})) {
      const endpoints = parseRouteKey(routeKey);
      if (!endpoints) {
        invalidRouteKeys.push(routeKey);
        continue;
      }

      addRoute(endpoints[0], endpoints[1], travelMinutes, routeKey);
    }
  }

  const searchIndex = createSearchIndex(cities, options.searchIndex);

  return {
    adjacency,
    cities,
    cityIndexByName,
    cityMap,
    edges,
    invalidRouteKeys,
    searchIndex
  };

  function addRoute(
    fromName: string,
    toName: string,
    travelMinutes: number,
    routeKey: string,
    geometry?: GeoPoint[]
  ): void {
    const fromIndex = cityIndexByName.get(fromName);
    const toIndex = cityIndexByName.get(toName);
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) {
      invalidRouteKeys.push(routeKey);
      return;
    }

    const fromAdj = adjacency[fromIndex];
    const toAdj = adjacency[toIndex];
    if (!fromAdj || !toAdj) {
      return;
    }

    fromAdj.push({ geometry, t: travelMinutes, toIndex });
    toAdj.push({
      geometry: reverseGeometry(geometry),
      t: travelMinutes,
      toIndex: fromIndex
    });
    edges.push({
      from: fromName,
      fromIndex,
      geometry,
      key: routeKey,
      minutes: travelMinutes,
      to: toName,
      toIndex
    });
  }
}

export function deriveTripPlan(
  model: DeriveTripContext,
  trip: string[]
): PlannerTripPlan {
  const segments: (PlannerSegment | null)[] = [];
  for (let index = 0; index < trip.length - 1; index += 1) {
    const from = trip[index];
    const to = trip[index + 1];
    if (from === undefined || to === undefined) {
      segments.push(null);
      continue;
    }
    segments.push(model.dijkstra(from, to));
  }

  const distFromLast: PlannerReachableDistances =
    trip.length >= 1 ? model.dijkstraAll(trip[trip.length - 1] as string) : {};

  return {
    distFromLast,
    segments,
    suggestions: model.findInterestingStops(segments, trip)
  };
}

interface SearchCitiesArgs {
  query: string;
  limit?: number;
}

export function searchCities(
  citiesOrModel: PlannerCity[] | { searchIndex?: PlannerSearchIndexEntry[]; cities?: PlannerCity[] },
  { query, limit = 14 }: SearchCitiesArgs
): PlannerCity[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const searchIndex = Array.isArray(citiesOrModel)
    ? createSearchIndex(citiesOrModel)
    : citiesOrModel.searchIndex || createSearchIndex(citiesOrModel.cities || []);

  return searchIndex
    .filter((entry) => {
      return (
        entry.cityNameNormalized.includes(normalizedQuery) ||
        entry.countryNormalized.includes(normalizedQuery) ||
        entry.searchText.includes(normalizedQuery)
      );
    })
    .slice(0, limit)
    .map((entry) => entry.city);
}

export function createPlannerModel(
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  options: PlannerArtifacts = {}
): PlannerModel {
  const {
    adjacency,
    cityIndexByName,
    cityMap,
    edges,
    invalidRouteKeys,
    searchIndex
  } = buildPlannerGraph(cities, routeData, options);

  function dijkstra(startName: string, endName: string): PlannerRouteResult | null {
    if (startName === endName) {
      return { time: 0, path: [startName] };
    }

    const startIndex = cityIndexByName.get(startName);
    const endIndex = cityIndexByName.get(endName);
    if (startIndex === undefined || endIndex === undefined) {
      return null;
    }

    const result = dijkstraIndexed(adjacency, startIndex, endIndex);
    if (!result) {
      return null;
    }

    return {
      geometry: buildPathGeometry(result.pathIndexes),
      path: result.pathIndexes.map((index) => {
        const city = cities[index];
        if (!city) throw new Error(`Missing city at index ${index}`);
        return city.name;
      }),
      time: result.distance
    };
  }

  function dijkstraAll(startName: string): PlannerReachableDistances {
    const startIndex = cityIndexByName.get(startName);
    if (startIndex === undefined) {
      return {};
    }

    const distances = dijkstraAllIndexed(adjacency, startIndex);
    const result: PlannerReachableDistances = {};
    for (let index = 0; index < distances.length; index += 1) {
      const distance = distances[index];
      if (distance === undefined || !Number.isFinite(distance)) {
        continue;
      }
      const city = cities[index];
      if (!city) continue;
      result[city.name] = distance;
    }

    return result;
  }

  function findInterestingStops(
    segments: (PlannerSegment | null)[],
    tripNames: string[]
  ): PlannerSuggestion[] {
    const suggestions: PlannerSuggestion[] = [];
    const tripSet = new Set(tripNames);

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      if (!segment?.path || segment.path.length <= 2) {
        continue;
      }

      for (let pathIndex = 1; pathIndex < segment.path.length - 1; pathIndex += 1) {
        const name = segment.path[pathIndex];
        if (name === undefined || tripSet.has(name)) {
          continue;
        }

        const city = cityMap[name];
        if (!city || city.interest < 7) {
          continue;
        }

        suggestions.push({ name, city, afterStop: segmentIndex, detourMin: 0 });
      }

      const fromName = segment.path[0];
      const toName = segment.path[segment.path.length - 1];
      if (fromName === undefined || toName === undefined) {
        continue;
      }
      const from = cityMap[fromName];
      const to = cityMap[toName];
      if (!from || !to) {
        continue;
      }

      const routeSet: Record<string, true> = Object.fromEntries(
        segment.path.map((name) => [name, true])
      );
      for (const city of cities) {
        if (city.interest < 7 || routeSet[city.name] || tripSet.has(city.name)) {
          continue;
        }

        if (suggestions.some((suggestion) => suggestion.name === city.name)) {
          continue;
        }

        const midPoint = { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 };
        const distToMid = haversine(city, midPoint);
        const routeLen = haversine(from, to);
        if (distToMid >= routeLen * 0.4 || distToMid >= 120) {
          continue;
        }

        const toCandidate = dijkstra(fromName, city.name);
        const fromCandidate = dijkstra(city.name, toName);
        if (!toCandidate || !fromCandidate) {
          continue;
        }

        const detour = toCandidate.time + fromCandidate.time - segment.time;
        if (detour > 0 && detour < 180) {
          suggestions.push({ name: city.name, city, afterStop: segmentIndex, detourMin: detour });
        }
      }
    }

    const seen = new Set<string>();
    return suggestions
      .filter((suggestion) => {
        if (seen.has(suggestion.name)) {
          return false;
        }

        seen.add(suggestion.name);
        return true;
      })
      .sort((left, right) => {
        return right.city.interest - left.city.interest || left.detourMin - right.detourMin;
      });
  }

  return {
    adjacency,
    cities,
    cityIndexByName,
    cityMap,
    deriveTripPlan(trip: string[]): PlannerTripPlan {
      return deriveTripPlan(
        {
          dijkstra,
          dijkstraAll,
          findInterestingStops
        },
        trip
      );
    },
    dijkstra,
    dijkstraAll,
    edges,
    findInterestingStops,
    invalidRouteKeys,
    searchCities(query: string, limit?: number): PlannerCity[] {
      return searchCities({ cities, searchIndex }, { query, limit });
    },
    searchIndex
  };

  function buildPathGeometry(pathIndexes: number[]): GeoPoint[] {
    const merged: GeoPoint[] = [];
    for (let index = 1; index < pathIndexes.length; index += 1) {
      const fromIndex = pathIndexes[index - 1];
      const toIndex = pathIndexes[index];
      if (fromIndex === undefined || toIndex === undefined) continue;
      const fromAdj = adjacency[fromIndex];
      const fromCity = cities[fromIndex];
      const toCity = cities[toIndex];
      if (!fromAdj || !fromCity || !toCity) continue;
      const edge = fromAdj.find((candidate) => candidate.toIndex === toIndex);
      const segmentGeometry: GeoPoint[] =
        edge?.geometry ||
        [
          { lat: fromCity.lat, lon: fromCity.lon },
          { lat: toCity.lat, lon: toCity.lon }
        ];
      appendGeometry(merged, segmentGeometry);
    }
    return merged;
  }
}

function parseRouteKeyFactory(
  cityMap: Record<string, PlannerCity>
): (routeKey: string) => [string, string] | null {
  const cityNames = Object.keys(cityMap).sort((left, right) => right.length - left.length);

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

function normalizeSearchQuery(query: unknown): string {
  return String(query || "")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function createSearchIndex(
  cities: PlannerCity[],
  searchEntries?: SearchIndexEntry[]
): PlannerSearchIndexEntry[] {
  if (Array.isArray(searchEntries) && searchEntries.length > 0) {
    return searchEntries
      .map((entry): PlannerSearchIndexEntry | null => {
        const city = cities[entry.cityIndex];
        if (!city) return null;
        return {
          city,
          cityNameNormalized: entry.cityNameNormalized,
          countryNormalized: entry.countryNormalized,
          searchText: entry.searchText
        };
      })
      .filter((entry): entry is PlannerSearchIndexEntry => entry !== null);
  }

  return [...cities]
    .sort((left, right) => {
      return right.interest - left.interest || right.pop - left.pop || left.name.localeCompare(right.name);
    })
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

function reverseGeometry(geometry: GeoPoint[] | undefined): GeoPoint[] | undefined {
  if (!Array.isArray(geometry)) {
    return geometry;
  }
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

function dijkstraIndexed(
  adjacency: PlannerAdjacencyEntry[][],
  startIndex: number,
  endIndex: number
): DijkstraIndexedResult | null {
  const distance = new Float64Array(adjacency.length);
  distance.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(adjacency.length);
  previous.fill(-1);
  const visited = new Uint8Array(adjacency.length);
  const queue = createMinHeap();

  distance[startIndex] = 0;
  queue.push(startIndex, 0);

  while (!queue.isEmpty()) {
    const current = queue.pop();
    if (!current || visited[current.node]) {
      continue;
    }

    visited[current.node] = 1;
    if (current.node === endIndex) {
      break;
    }

    const neighbors = adjacency[current.node];
    if (!neighbors) continue;
    for (const edge of neighbors) {
      const currentDistance = distance[current.node];
      if (currentDistance === undefined) continue;
      const alt = currentDistance + edge.t;
      const neighborDistance = distance[edge.toIndex];
      if (neighborDistance === undefined || alt >= neighborDistance) {
        continue;
      }

      distance[edge.toIndex] = alt;
      previous[edge.toIndex] = current.node;
      queue.push(edge.toIndex, alt);
    }
  }

  const endDistance = distance[endIndex];
  if (endDistance === undefined || !Number.isFinite(endDistance)) {
    return null;
  }

  const pathIndexes: number[] = [];
  for (let cursor = endIndex; cursor >= 0; cursor = previous[cursor] ?? -1) {
    pathIndexes.unshift(cursor);
    if (cursor === startIndex) {
      break;
    }
  }

  return {
    distance: endDistance,
    pathIndexes
  };
}

function dijkstraAllIndexed(
  adjacency: PlannerAdjacencyEntry[][],
  startIndex: number
): Float64Array {
  const distance = new Float64Array(adjacency.length);
  distance.fill(Number.POSITIVE_INFINITY);
  const visited = new Uint8Array(adjacency.length);
  const queue = createMinHeap();

  distance[startIndex] = 0;
  queue.push(startIndex, 0);

  while (!queue.isEmpty()) {
    const current = queue.pop();
    if (!current || visited[current.node]) {
      continue;
    }

    visited[current.node] = 1;
    const neighbors = adjacency[current.node];
    if (!neighbors) continue;
    for (const edge of neighbors) {
      const currentDistance = distance[current.node];
      if (currentDistance === undefined) continue;
      const alt = currentDistance + edge.t;
      const neighborDistance = distance[edge.toIndex];
      if (neighborDistance === undefined || alt >= neighborDistance) {
        continue;
      }

      distance[edge.toIndex] = alt;
      queue.push(edge.toIndex, alt);
    }
  }

  return distance;
}

function createMinHeap(): MinHeap {
  const items: MinHeapItem[] = [];

  return {
    isEmpty(): boolean {
      return items.length === 0;
    },
    pop(): MinHeapItem | null {
      if (items.length === 0) {
        return null;
      }

      const top = items[0];
      const last = items.pop();
      if (items.length > 0 && last) {
        items[0] = last;
        siftDown(items, 0);
      }
      return top ?? null;
    },
    push(node: number, distance: number): void {
      items.push({ distance, node });
      siftUp(items, items.length - 1);
    }
  };
}

function siftUp(items: MinHeapItem[], index: number): void {
  let cursor = index;
  while (cursor > 0) {
    const parentIndex = Math.floor((cursor - 1) / 2);
    const parent = items[parentIndex];
    const current = items[cursor];
    if (!parent || !current || parent.distance <= current.distance) {
      break;
    }

    items[parentIndex] = current;
    items[cursor] = parent;
    cursor = parentIndex;
  }
}

function siftDown(items: MinHeapItem[], index: number): void {
  let cursor = index;
  while (cursor < items.length) {
    const leftIndex = cursor * 2 + 1;
    const rightIndex = cursor * 2 + 2;
    let smallestIndex = cursor;

    const smallest = items[smallestIndex];
    const left = items[leftIndex];
    const right = items[rightIndex];

    if (left && smallest && left.distance < smallest.distance) {
      smallestIndex = leftIndex;
    }

    const newSmallest = items[smallestIndex];
    if (right && newSmallest && right.distance < newSmallest.distance) {
      smallestIndex = rightIndex;
    }

    if (smallestIndex === cursor) {
      break;
    }

    const swapItem = items[smallestIndex];
    const cursorItem = items[cursor];
    if (!swapItem || !cursorItem) break;
    items[cursor] = swapItem;
    items[smallestIndex] = cursorItem;
    cursor = smallestIndex;
  }
}
