import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import { createPlannerModel } from "../engine/planner-core.ts";
import { createWasmPlannerModel } from "../engine/planner-wasm-adapter.ts";
import { prewarmWasm } from "../../../../packages/ts/web-bindings/src/index.ts";
import {
  PLANNER_WORKER_MESSAGE_TYPES,
  serializePlannerError,
  type PlannerWorkerMessageType
} from "../engine/planner-protocol.ts";
import type {
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
  RawEdgeGeometries
} from "../types/planner-dataset.ts";
import type {
  PlannerEngineKind,
  PlannerModel
} from "../types/planner-engine.ts";

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

interface AugmentGeometryPayload {
  rawEdgeGeometries?: RawEdgeGeometries;
}

interface IncomingMessage {
  type?: PlannerWorkerMessageType;
  requestId?: string;
  payload?:
    | InitializePayload
    | DeriveTripPayload
    | SearchCitiesPayload
    | AugmentGeometryPayload;
}

const diagnostics = createDiagnostics("web/worker/planner");
let model: PlannerModel | null = null;
let activeEngineKind: PlannerEngineKind = "js-fallback";

// Eagerly fetch + compile the WASM module the moment this worker
// spawns, in parallel with the dataset fetch happening on the main
// thread. By the time INITIALIZE arrives the wasm-bindgen init has
// usually already resolved, removing ~300ms from the cold-start path.
// The promise is cached inside web-bindings; createWasmPlannerEngine
// awaits the same promise internally so there's no double-compile risk.
const wasmPrewarmStartedAt = now();
void prewarmWasm()
  .then(() => {
    diagnostics.info("planner worker prewarmed wasm", {
      duration_ms: elapsedSince(wasmPrewarmStartedAt)
    });
  })
  .catch((error: unknown) => {
    // Don't reject — the JS-fallback path remains usable. Just record.
    diagnostics.warn("planner worker wasm prewarm failed", {
      error: summarizeError(error)
    });
  });

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
      const built = await buildModel(
        cities || [],
        routeData || {},
        plannerArtifacts || {}
      );
      model = built.model;
      activeEngineKind = built.engineKind;
      diagnostics.info("planner worker initialized model", {
        engine_kind: activeEngineKind,
        city_count: model.cities.length,
        edge_count: model.edges.length,
        invalid_route_count: model.invalidRouteKeys.length,
        duration_ms: elapsedSince(startedAt)
      });
      postSuccess(message.requestId, {
        cities: model.cities,
        cityMap: model.cityMap,
        edges: model.edges,
        invalidRouteKeys: model.invalidRouteKeys,
        engineKind: activeEngineKind
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
        engine_kind: activeEngineKind,
        trip_length: trip.length,
        segment_count: derived.segments.length,
        suggestion_count: derived.suggestions.length,
        duration_ms: elapsedSince(startedAt)
      });
      postSuccess(message.requestId, derived);
      return;
    }

    if (message.type === PLANNER_WORKER_MESSAGE_TYPES.AUGMENT_GEOMETRY) {
      if (!model) {
        throw new Error("Planner worker is not initialized");
      }

      const payload = (message.payload as AugmentGeometryPayload | undefined) || {};
      const rawEdgeGeometries = payload.rawEdgeGeometries;
      if (!rawEdgeGeometries) {
        throw new Error("augment-geometry payload missing rawEdgeGeometries");
      }
      model.augmentGeometry(rawEdgeGeometries);
      diagnostics.info("planner worker augmented geometry", {
        request_id: message.requestId,
        engine_kind: activeEngineKind,
        geometry_count: rawEdgeGeometries.geometries.length,
        duration_ms: elapsedSince(startedAt)
      });
      // Echo the updated edges back so the shell-side metadata stays in
      // sync (the map surface re-projects geometry from this list).
      postSuccess(message.requestId, {
        edges: model.edges
      });
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
        engine_kind: activeEngineKind,
        query,
        result_count: results.length,
        limit,
        duration_ms: elapsedSince(startedAt)
      });
      postSuccess(message.requestId, results);
      return;
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

async function buildModel(
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  plannerArtifacts: PlannerArtifacts
): Promise<{ model: PlannerModel; engineKind: PlannerEngineKind }> {
  // Try the WASM-backed adapter first; on any failure (module import error,
  // wasm init failure, graph construction failure) fall back to the inline
  // JS implementation. The fallback path keeps the worker viable in environs
  // that cannot load the wasm asset (older browsers, sandbox restrictions,
  // misconfigured CSP).
  try {
    const wasmModel = await createWasmPlannerModel(
      cities,
      routeData,
      plannerArtifacts
    );
    return { model: wasmModel, engineKind: "wasm" };
  } catch (error) {
    diagnostics.warn("wasm planner unavailable, falling back to inline JS engine", {
      city_count: cities.length,
      route_count: Object.keys(routeData || {}).length,
      error: summarizeError(error)
    });
    const fallback = createPlannerModel(cities, routeData, plannerArtifacts);
    return { model: fallback, engineKind: "js-fallback" };
  }
}

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
