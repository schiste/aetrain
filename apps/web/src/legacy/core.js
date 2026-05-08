export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMinutes(minutes) {
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

export function formatPopulation(population) {
  if (population >= 1_000_000) {
    return `${(population / 1_000_000).toFixed(1)}M`;
  }

  return `${Math.round(population / 1_000)}k`;
}

export function haversine(a, b) {
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

export function buildPlannerGraph(cities, routeData, options = {}) {
  const cityMap = Object.fromEntries(cities.map((city) => [city.name, city]));
  const cityIndexByName = new Map(cities.map((city, index) => [city.name, index]));
  const adjacency = Array.from({ length: cities.length }, () => []);
  const edges = [];
  const invalidRouteKeys = [];
  const parseRouteKey = parseRouteKeyFactory(cityMap);

  if (Array.isArray(options.routePairs) && options.routePairs.length > 0) {
    for (const routePair of options.routePairs) {
      addRoute(routePair.from, routePair.to, routePair.minutes, `${routePair.from}-${routePair.to}`);
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

  function addRoute(fromName, toName, travelMinutes, routeKey) {
    const fromIndex = cityIndexByName.get(fromName);
    const toIndex = cityIndexByName.get(toName);
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) {
      invalidRouteKeys.push(routeKey);
      return;
    }

    adjacency[fromIndex].push({ toIndex, t: travelMinutes });
    adjacency[toIndex].push({ toIndex: fromIndex, t: travelMinutes });
    edges.push({
      from: fromName,
      fromIndex,
      key: routeKey,
      minutes: travelMinutes,
      to: toName,
      toIndex
    });
  }
}

export function deriveTripPlan(model, trip) {
  const segments = [];
  for (let index = 0; index < trip.length - 1; index += 1) {
    segments.push(model.dijkstra(trip[index], trip[index + 1]));
  }

  const distFromLast =
    trip.length >= 1 ? model.dijkstraAll(trip[trip.length - 1]) : {};

  return {
    distFromLast,
    segments,
    suggestions: model.findInterestingStops(segments, trip)
  };
}

export function searchCities(citiesOrModel, { query, limit = 14 }) {
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

export function createPlannerModel(cities, routeData, options = {}) {
  const {
    adjacency,
    cityIndexByName,
    cityMap,
    edges,
    invalidRouteKeys,
    searchIndex
  } = buildPlannerGraph(cities, routeData, options);

  function dijkstra(startName, endName) {
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
      path: result.pathIndexes.map((index) => cities[index].name),
      time: result.distance
    };
  }

  function dijkstraAll(startName) {
    const startIndex = cityIndexByName.get(startName);
    if (startIndex === undefined) {
      return {};
    }

    const distances = dijkstraAllIndexed(adjacency, startIndex);
    const result = {};
    for (let index = 0; index < distances.length; index += 1) {
      const distance = distances[index];
      if (!Number.isFinite(distance)) {
        continue;
      }
      result[cities[index].name] = distance;
    }

    return result;
  }

  function findInterestingStops(segments, tripNames) {
    const suggestions = [];
    const tripSet = new Set(tripNames);

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      if (!segment?.path || segment.path.length <= 2) {
        continue;
      }

      for (let pathIndex = 1; pathIndex < segment.path.length - 1; pathIndex += 1) {
        const name = segment.path[pathIndex];
        if (tripSet.has(name)) {
          continue;
        }

        const city = cityMap[name];
        if (!city || city.interest < 7) {
          continue;
        }

        suggestions.push({ name, city, afterStop: segmentIndex, detourMin: 0 });
      }

      const from = cityMap[segment.path[0]];
      const to = cityMap[segment.path[segment.path.length - 1]];
      if (!from || !to) {
        continue;
      }

      const routeSet = Object.fromEntries(segment.path.map((name) => [name, true]));
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

        const toCandidate = dijkstra(segment.path[0], city.name);
        const fromCandidate = dijkstra(city.name, segment.path[segment.path.length - 1]);
        if (!toCandidate || !fromCandidate) {
          continue;
        }

        const detour = toCandidate.time + fromCandidate.time - segment.time;
        if (detour > 0 && detour < 180) {
          suggestions.push({ name: city.name, city, afterStop: segmentIndex, detourMin: detour });
        }
      }
    }

    const seen = new Set();
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
    deriveTripPlan(trip) {
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
    searchCities(query, limit) {
      return searchCities({ cities, searchIndex }, { query, limit });
    },
    searchIndex
  };
}

function parseRouteKeyFactory(cityMap) {
  const cityNames = Object.keys(cityMap).sort((left, right) => right.length - left.length);

  return function parseRouteKey(routeKey) {
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

function normalizeSearchQuery(query) {
  return String(query || "")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function createSearchIndex(cities, searchEntries) {
  if (Array.isArray(searchEntries) && searchEntries.length > 0) {
    return searchEntries
      .map((entry) => ({
        city: cities[entry.cityIndex],
        cityNameNormalized: entry.cityNameNormalized,
        countryNormalized: entry.countryNormalized,
        searchText: entry.searchText
      }))
      .filter((entry) => entry.city);
  }

  return [...cities]
    .sort((left, right) => {
      return right.interest - left.interest || right.pop - left.pop || left.name.localeCompare(right.name);
    })
    .map((city) => {
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

function dijkstraIndexed(adjacency, startIndex, endIndex) {
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

    for (const edge of adjacency[current.node]) {
      const alt = distance[current.node] + edge.t;
      if (alt >= distance[edge.toIndex]) {
        continue;
      }

      distance[edge.toIndex] = alt;
      previous[edge.toIndex] = current.node;
      queue.push(edge.toIndex, alt);
    }
  }

  if (!Number.isFinite(distance[endIndex])) {
    return null;
  }

  const pathIndexes = [];
  for (let cursor = endIndex; cursor >= 0; cursor = previous[cursor]) {
    pathIndexes.unshift(cursor);
    if (cursor === startIndex) {
      break;
    }
  }

  return {
    distance: distance[endIndex],
    pathIndexes
  };
}

function dijkstraAllIndexed(adjacency, startIndex) {
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
    for (const edge of adjacency[current.node]) {
      const alt = distance[current.node] + edge.t;
      if (alt >= distance[edge.toIndex]) {
        continue;
      }

      distance[edge.toIndex] = alt;
      queue.push(edge.toIndex, alt);
    }
  }

  return distance;
}

function createMinHeap() {
  const items = [];

  return {
    isEmpty() {
      return items.length === 0;
    },
    pop() {
      if (items.length === 0) {
        return null;
      }

      const top = items[0];
      const last = items.pop();
      if (items.length > 0 && last) {
        items[0] = last;
        siftDown(items, 0);
      }
      return top;
    },
    push(node, distance) {
      items.push({ distance, node });
      siftUp(items, items.length - 1);
    }
  };
}

function siftUp(items, index) {
  let cursor = index;
  while (cursor > 0) {
    const parentIndex = Math.floor((cursor - 1) / 2);
    if (items[parentIndex].distance <= items[cursor].distance) {
      break;
    }

    [items[parentIndex], items[cursor]] = [items[cursor], items[parentIndex]];
    cursor = parentIndex;
  }
}

function siftDown(items, index) {
  let cursor = index;
  while (cursor < items.length) {
    const leftIndex = cursor * 2 + 1;
    const rightIndex = cursor * 2 + 2;
    let smallestIndex = cursor;

    if (
      leftIndex < items.length &&
      items[leftIndex].distance < items[smallestIndex].distance
    ) {
      smallestIndex = leftIndex;
    }

    if (
      rightIndex < items.length &&
      items[rightIndex].distance < items[smallestIndex].distance
    ) {
      smallestIndex = rightIndex;
    }

    if (smallestIndex === cursor) {
      break;
    }

    [items[cursor], items[smallestIndex]] = [items[smallestIndex], items[cursor]];
    cursor = smallestIndex;
  }
}
