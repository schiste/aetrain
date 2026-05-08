import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.js";
import { createPlannerModel, searchCities } from "../legacy/core.js";
import {
  PLANNER_WORKER_MESSAGE_TYPES,
  serializePlannerError
} from "../engine/planner-protocol.js";

const diagnostics = createDiagnostics("web/worker/planner");
let model = null;

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  const startedAt = now();
  diagnostics.debug("planner worker received message", {
    request_id: message.requestId || null,
    type: message.type || null
  });

  try {
    if (message.type === PLANNER_WORKER_MESSAGE_TYPES.INITIALIZE) {
      const { cities, routeData } = message.payload || {};
      model = createPlannerModel(cities || [], routeData || {});
      diagnostics.info("planner worker initialized model", {
        city_count: model.cities.length,
        edge_count: model.edges.length,
        invalid_route_count: model.invalidRouteKeys.length,
        duration_ms: elapsedSince(startedAt)
      });
      postSuccess(message.requestId, { ok: true });
      return;
    }

    if (message.type === PLANNER_WORKER_MESSAGE_TYPES.DERIVE_TRIP) {
      if (!model) {
        throw new Error("Planner worker is not initialized");
      }

      const trip = message.payload?.trip || [];
      const derived = model.deriveTripPlan(trip);
      diagnostics.info("planner worker derived trip plan", {
        request_id: message.requestId,
        trip_length: trip.length,
        segment_count: derived.segments.length,
        suggestion_count: derived.suggestions.length,
        duration_ms: elapsedSince(startedAt)
      });
      postSuccess(message.requestId, derived);
      return;
    }

    if (message.type === PLANNER_WORKER_MESSAGE_TYPES.SEARCH_CITIES) {
      if (!model) {
        throw new Error("Planner worker is not initialized");
      }

      const query = message.payload?.query || "";
      const limit = message.payload?.limit || 14;
      const results = searchCities(model.cities, { query, limit });
      diagnostics.info("planner worker searched cities", {
        request_id: message.requestId,
        query,
        result_count: results.length,
        limit,
        duration_ms: elapsedSince(startedAt)
      });
      postSuccess(message.requestId, results);
    }
  } catch (error) {
    diagnostics.error("planner worker failed", {
      request_id: message.requestId || null,
      type: message.type || null,
      duration_ms: elapsedSince(startedAt),
      error: summarizeError(error)
    });
    self.postMessage({
      ok: false,
      requestId: message.requestId,
      error: serializePlannerError(error)
    });
  }
});

function postSuccess(requestId, payload) {
  self.postMessage({
    ok: true,
    requestId,
    payload
  });
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
