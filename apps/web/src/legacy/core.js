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

function parseRouteKeyFactory(cityMap) {
  const cityNames = Object.keys(cityMap).sort((a, b) => b.length - a.length);

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

export function buildPlannerGraph(cities, routeData) {
  const cityMap = Object.fromEntries(cities.map((city) => [city.name, city]));
  const adj = {};
  const edges = [];
  const invalidRouteKeys = [];
  const parseRouteKey = parseRouteKeyFactory(cityMap);

  function addEdge(a, b, travelMinutes) {
    adj[a] ||= [];
    adj[b] ||= [];
    adj[a].push({ to: b, t: travelMinutes });
    adj[b].push({ to: a, t: travelMinutes });
  }

  for (const [routeKey, travelMinutes] of Object.entries(routeData)) {
    const endpoints = parseRouteKey(routeKey);
    if (!endpoints) {
      invalidRouteKeys.push(routeKey);
      continue;
    }

    addEdge(endpoints[0], endpoints[1], travelMinutes);
    edges.push({ from: endpoints[0], to: endpoints[1], minutes: travelMinutes, key: routeKey });
  }

  return {
    adj,
    cities,
    cityMap,
    edges,
    invalidRouteKeys
  };
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

export function searchCities(cities, { query, limit = 14 }) {
  const normalizedQuery = String(query || "")
    .toLowerCase()
    .trim();

  if (normalizedQuery.length < 1) {
    return [];
  }

  return cities
    .filter((city) => {
      return (
        city.name.toLowerCase().includes(normalizedQuery) ||
        city.country.toLowerCase().includes(normalizedQuery)
      );
    })
    .sort((left, right) => right.interest - left.interest || right.pop - left.pop)
    .slice(0, limit);
}

export function createPlannerModel(cities, routeData) {
  const { adj, cityMap, edges, invalidRouteKeys } = buildPlannerGraph(cities, routeData);

  function dijkstra(start, end) {
    if (start === end) {
      return { time: 0, path: [start] };
    }

    if (!adj[start] || !adj[end]) {
      return null;
    }

    const distance = {};
    const previous = {};
    const visited = {};
    const queue = [start];

    for (const node of Object.keys(adj)) {
      distance[node] = Infinity;
    }
    distance[start] = 0;

    while (queue.length > 0) {
      queue.sort((a, b) => distance[a] - distance[b]);
      const current = queue.shift();
      if (!current || visited[current]) {
        continue;
      }

      visited[current] = true;
      if (current === end) {
        break;
      }

      for (const edge of adj[current] || []) {
        const alt = distance[current] + edge.t;
        if (alt < distance[edge.to]) {
          distance[edge.to] = alt;
          previous[edge.to] = current;
          queue.push(edge.to);
        }
      }
    }

    if (distance[end] === Infinity) {
      return null;
    }

    const path = [];
    let cursor = end;
    while (cursor) {
      path.unshift(cursor);
      cursor = previous[cursor];
    }

    return { time: distance[end], path };
  }

  function dijkstraAll(start) {
    const distance = {};
    const visited = {};
    const queue = [start];

    for (const node of Object.keys(adj)) {
      distance[node] = Infinity;
    }

    if (!adj[start]) {
      return distance;
    }

    distance[start] = 0;

    while (queue.length > 0) {
      queue.sort((a, b) => distance[a] - distance[b]);
      const current = queue.shift();
      if (!current || visited[current]) {
        continue;
      }

      visited[current] = true;
      for (const edge of adj[current] || []) {
        const alt = distance[current] + edge.t;
        if (alt < distance[edge.to]) {
          distance[edge.to] = alt;
          queue.push(edge.to);
        }
      }
    }

    return distance;
  }

  function findInterestingStops(segments, tripNames) {
    const suggestions = [];

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      if (!segment?.path || segment.path.length <= 2) {
        continue;
      }

      for (let pathIndex = 1; pathIndex < segment.path.length - 1; pathIndex += 1) {
        const name = segment.path[pathIndex];
        if (tripNames.includes(name)) {
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
        if (city.interest < 7 || routeSet[city.name] || tripNames.includes(city.name)) {
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
      .sort((a, b) => b.city.interest - a.city.interest || a.detourMin - b.detourMin);
  }

  return {
    adj,
    cities,
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
    invalidRouteKeys
  };
}
