import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import { createPlannerModel } from "../legacy/core.ts";
import {
  PLANNER_WORKER_MESSAGE_TYPES,
  serializePlannerError,
  type PlannerWorkerMessageType
} from "../engine/planner-protocol.ts";
import type {
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData
} from "../types/planner-dataset.ts";
import type { PlannerModel } from "../types/planner-engine.ts";

interface InitializePayload {
  cities?: PlannerCity[];
  routeData?: PlannerRouteData;
  plannerArtifacts?: PlannerArtifacts;
}

interface DeriveTripPayload {
  trip?: string[];
}

interface SearchCitiesPayload {
  query?: string;
  limit?: number;
}

interface IncomingMessage {
  type?: PlannerWorkerMessageType;
  requestId?: string;
  payload?: InitializePayload | DeriveTripPayload | SearchCitiesPayload;
}

const diagnostics = createDiagnostics("web/worker/planner");
let model: PlannerModel | null = null;

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const message: IncomingMessage = event.data || {};
  const startedAt = now();
  diagnostics.debug("planner worker received message", {
    request_id: message.requestId || null,
    type: message.type || null
  });

  try {
    if (message.type === PLANNER_WORKER_MESSAGE_TYPES.INITIALIZE) {
      const payload = (message.payload as InitializePayload | undefined) || {};
      const { cities, plannerArtifacts, routeData } = payload;
      model = createPlannerModel(cities || [], routeData || {}, plannerArtifacts || {});
      diagnostics.info("planner worker initialized model", {
        city_count: model.cities.length,
        edge_count: model.edges.length,
        invalid_route_count: model.invalidRouteKeys.length,
        duration_ms: elapsedSince(startedAt)
      });
      postSuccess(message.requestId, {
        cities: model.cities,
        cityMap: model.cityMap,
        edges: model.edges,
        invalidRouteKeys: model.invalidRouteKeys
      });
      return;
    }

    if (message.type === PLANNER_WORKER_MESSAGE_TYPES.DERIVE_TRIP) {
      if (!model) {
        throw new Error("Planner worker is not initialized");
      }

      const payload = (message.payload as DeriveTripPayload | undefined) || {};
      const trip = payload.trip || [];
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

      const payload = (message.payload as SearchCitiesPayload | undefined) || {};
      const query = payload.query || "";
      const limit = payload.limit || 14;
      const results = model.searchCities(query, limit);
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

function postSuccess(requestId: string | undefined, payload: unknown): void {
  self.postMessage({
    ok: true,
    requestId,
    payload
  });
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
