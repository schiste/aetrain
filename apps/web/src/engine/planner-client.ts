import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import {
  createPlannerModel
} from "../legacy/core.ts";
import {
  deserializePlannerError,
  PLANNER_WORKER_MESSAGE_TYPES
} from "./planner-protocol.ts";

const diagnostics = createDiagnostics("web/engine/planner-client");

export async function createPlannerClient(cities, routeData, plannerArtifacts = {}) {
  return diagnostics.timeAsync("create-planner-client", async () => {
    if (typeof Worker === "undefined") {
      diagnostics.warn("worker api unavailable, using inline planner client");
      return createInlinePlannerClient(cities, routeData, plannerArtifacts);
    }

    const worker = new Worker(new URL("../workers/planner.worker.ts", import.meta.url), {
      type: "module"
    });
    diagnostics.debug("spawned planner worker");

    const pending = new Map();
    let nextRequestId = 0;

    worker.addEventListener("message", (event) => {
      const message = event.data || {};
      const resolver = pending.get(message.requestId);
      if (!resolver) {
        return;
      }

      pending.delete(message.requestId);
      if (message.ok) {
        diagnostics.metric("planner-worker-request:success", pending.size, {
          request_id: message.requestId,
          request_type: resolver.type,
          duration_ms: resolver.startedAt ? elapsedSince(resolver.startedAt) : null,
          pending_count: pending.size
        });
        resolver.resolve(message.payload);
        return;
      }

      const error = deserializePlannerError(message.error);
      diagnostics.error("planner worker request failed", {
        request_id: message.requestId,
        request_type: resolver.type,
        duration_ms: resolver.startedAt ? elapsedSince(resolver.startedAt) : null,
        error: summarizeError(error)
      });
      resolver.reject(error);
    });

    worker.addEventListener("error", (event) => {
      diagnostics.error("planner worker raised error event", {
        error: summarizeError(event.error || new Error(event.message || "Planner worker error"))
      });
      for (const { reject, type, startedAt, requestId } of pending.values()) {
        diagnostics.error("rejecting pending planner worker request", {
          request_id: requestId,
          request_type: type,
          duration_ms: startedAt ? elapsedSince(startedAt) : null
        });
        reject(event.error || new Error(event.message || "Planner worker error"));
      }
      pending.clear();
    });

    function request(type, payload) {
      const requestId = `planner-${nextRequestId}`;
      nextRequestId += 1;
      const startedAt = now();
      diagnostics.debug("posting planner worker request", {
        request_id: requestId,
        request_type: type,
        pending_count: pending.size
      });

      return new Promise((resolve, reject) => {
        pending.set(requestId, { reject, requestId, resolve, startedAt, type });
        worker.postMessage({ type, payload, requestId });
      });
    }

    const metadata = await request(PLANNER_WORKER_MESSAGE_TYPES.INITIALIZE, {
      cities,
      plannerArtifacts,
      routeData
    });
    diagnostics.info("planner worker initialized", {
      city_count: metadata?.cities?.length || cities.length,
      edge_count: metadata?.edges?.length || 0,
      invalid_route_count: metadata?.invalidRouteKeys?.length || 0
    });

    return {
      metadata,
      close() {
        diagnostics.info("terminating planner worker");
        worker.terminate();
      },
      deriveTripPlan({ trip }) {
        return request(PLANNER_WORKER_MESSAGE_TYPES.DERIVE_TRIP, { trip });
      },
      searchCities({ query, limit }) {
        return request(PLANNER_WORKER_MESSAGE_TYPES.SEARCH_CITIES, { query, limit });
      }
    };
  }, {
    city_count: cities.length,
    prepared_route_count: plannerArtifacts.routePairs?.length || 0
  });
}

function createInlinePlannerClient(cities, routeData, plannerArtifacts) {
  const model = createPlannerModel(cities, routeData, plannerArtifacts);
  const metadata = {
    cities: model.cities,
    cityMap: model.cityMap,
    edges: model.edges,
    invalidRouteKeys: model.invalidRouteKeys
  };
  diagnostics.info("created inline planner client", {
    city_count: cities.length,
    edge_count: metadata.edges.length
  });

  return {
    metadata,
    close() {
      diagnostics.debug("closed inline planner client");
    },
    async deriveTripPlan({ trip }) {
      return diagnostics.timeAsync("inline-derive-trip-plan", async () => {
        return model.deriveTripPlan(trip);
      }, {
        trip_length: trip.length
      });
    },
    async searchCities({ query, limit }) {
      return diagnostics.timeAsync("inline-search-cities", async () => {
        return model.searchCities(query, limit);
      }, {
        query_length: String(query || "").length,
        limit
      });
    }
  };
}

function now() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function elapsedSince(startedAt) {
  return Math.round((now() - startedAt) * 1000) / 1000;
}
