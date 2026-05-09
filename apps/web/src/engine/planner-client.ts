import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import { createPlannerModel } from "./planner-core.ts";
import type {
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData
} from "../types/planner-dataset.ts";
import type {
  PlannerEngine,
  PlannerModelMetadata,
  PlannerTripPlan
} from "../types/planner-engine.ts";
import {
  deserializePlannerError,
  PLANNER_WORKER_MESSAGE_TYPES,
  type PlannerWorkerMessageType,
  type PlannerWorkerResponse
} from "./planner-protocol.ts";

const diagnostics = createDiagnostics("web/engine/planner-client");

interface PendingRequest {
  type: PlannerWorkerMessageType;
  startedAt: number;
  requestId: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/**
 * A planner worker that has been spawned but not yet initialized with data.
 * Used by the boot sequence to pre-warm the worker process while the dataset
 * is still loading — saving ~100-300ms on a cold start by overlapping module
 * resolution + WASM compilation with the dataset fetch.
 */
export interface PrewarmedPlannerClient {
  initialize(
    cities: PlannerCity[],
    routeData: PlannerRouteData,
    plannerArtifacts?: PlannerArtifacts
  ): Promise<PlannerEngine>;
  /** Tear down a pre-warmed worker that will not receive an INITIALIZE. */
  abort(): void;
}

/**
 * Spawn a planner worker without sending the INITIALIZE message yet. The
 * caller is responsible for either calling `.initialize(...)` to consume it
 * or `.abort()` to release the worker process.
 *
 * Falls through to a non-pre-warmable shim when the Worker API is missing so
 * callers can use the same shape in tests / SSR.
 */
export function prewarmPlannerClient(): PrewarmedPlannerClient {
  if (typeof Worker === "undefined") {
    diagnostics.warn("worker api unavailable, prewarm returning inline shim");
    let shimConsumed = false;
    return {
      initialize(cities, routeData, plannerArtifacts = {}) {
        if (shimConsumed) {
          return Promise.reject(
            new Error("Pre-warmed planner worker already consumed")
          );
        }
        shimConsumed = true;
        return Promise.resolve(
          createInlinePlannerClient(cities, routeData, plannerArtifacts)
        );
      },
      abort(): void {
        shimConsumed = true;
      }
    };
  }

  const startedAt = now();
  const worker = new Worker(
    new URL("../workers/planner.worker.ts", import.meta.url),
    { type: "module" }
  );
  diagnostics.info("pre-warmed planner worker spawned", {
    started_at: startedAt
  });

  let consumed = false;
  return {
    async initialize(
      cities: PlannerCity[],
      routeData: PlannerRouteData,
      plannerArtifacts: PlannerArtifacts = {}
    ): Promise<PlannerEngine> {
      if (consumed) {
        throw new Error("Pre-warmed planner worker already consumed");
      }
      consumed = true;
      diagnostics.info("attaching planner client to pre-warmed worker", {
        prewarm_age_ms: elapsedSince(startedAt),
        city_count: cities.length
      });
      return attachPlannerClient(worker, cities, routeData, plannerArtifacts);
    },
    abort(): void {
      if (consumed) {
        return;
      }
      consumed = true;
      diagnostics.info("aborting unused pre-warmed planner worker");
      worker.terminate();
    }
  };
}

export async function createPlannerClient(
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  plannerArtifacts: PlannerArtifacts = {}
): Promise<PlannerEngine> {
  return diagnostics.timeAsync("create-planner-client", async () => {
    if (typeof Worker === "undefined") {
      diagnostics.warn("worker api unavailable, using inline planner client");
      return createInlinePlannerClient(cities, routeData, plannerArtifacts);
    }

    const worker = new Worker(new URL("../workers/planner.worker.ts", import.meta.url), {
      type: "module"
    });
    diagnostics.debug("spawned planner worker");
    return attachPlannerClient(worker, cities, routeData, plannerArtifacts);
  }, {
    city_count: cities.length,
    prepared_route_count: plannerArtifacts.routePairs?.length || 0
  });
}

async function attachPlannerClient(
  worker: Worker,
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  plannerArtifacts: PlannerArtifacts
): Promise<PlannerEngine> {
  const pending = new Map<string, PendingRequest>();
  let nextRequestId = 0;

  worker.addEventListener("message", (event: MessageEvent<PlannerWorkerResponse>) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
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

  worker.addEventListener("error", (event: ErrorEvent) => {
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

  function request<T>(type: PlannerWorkerMessageType, payload: unknown): Promise<T> {
    const requestId = `planner-${nextRequestId}`;
    nextRequestId += 1;
    const startedAt = now();
    diagnostics.debug("posting planner worker request", {
      request_id: requestId,
      request_type: type,
      pending_count: pending.size
    });

    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, {
        reject,
        requestId,
        resolve: resolve as (value: unknown) => void,
        startedAt,
        type
      });
      worker.postMessage({ type, payload, requestId });
    });
  }

  const metadata = await request<PlannerModelMetadata>(
    PLANNER_WORKER_MESSAGE_TYPES.INITIALIZE,
    {
      cities,
      plannerArtifacts,
      routeData
    }
  );
  diagnostics.info("planner worker initialized", {
    city_count: metadata?.cities?.length || cities.length,
    edge_count: metadata?.edges?.length || 0,
    invalid_route_count: metadata?.invalidRouteKeys?.length || 0,
    engine_kind: metadata?.engineKind || "unknown"
  });

  return {
    metadata,
    close(): void {
      diagnostics.info("terminating planner worker");
      worker.terminate();
    },
    deriveTripPlan({ trip }: { trip: string[] }): Promise<PlannerTripPlan> {
      return request<PlannerTripPlan>(PLANNER_WORKER_MESSAGE_TYPES.DERIVE_TRIP, { trip });
    },
    searchCities({ query, limit }: { query: string; limit: number }): Promise<PlannerCity[]> {
      return request<PlannerCity[]>(PLANNER_WORKER_MESSAGE_TYPES.SEARCH_CITIES, { query, limit });
    }
  };
}

function createInlinePlannerClient(
  cities: PlannerCity[],
  routeData: PlannerRouteData,
  plannerArtifacts: PlannerArtifacts
): PlannerEngine {
  const model = createPlannerModel(cities, routeData, plannerArtifacts);
  const metadata: PlannerModelMetadata = {
    cities: model.cities,
    cityMap: model.cityMap,
    edges: model.edges,
    invalidRouteKeys: model.invalidRouteKeys,
    engineKind: "js-fallback"
  };
  diagnostics.info("created inline planner client", {
    city_count: cities.length,
    edge_count: metadata.edges.length
  });

  return {
    metadata,
    close(): void {
      diagnostics.debug("closed inline planner client");
    },
    async deriveTripPlan({ trip }: { trip: string[] }): Promise<PlannerTripPlan> {
      return diagnostics.timeAsync("inline-derive-trip-plan", async () => {
        return model.deriveTripPlan(trip);
      }, {
        trip_length: trip.length
      });
    },
    async searchCities({ query, limit }: { query: string; limit: number }): Promise<PlannerCity[]> {
      return diagnostics.timeAsync("inline-search-cities", async () => {
        return model.searchCities(query, limit);
      }, {
        query_length: String(query || "").length,
        limit
      });
    }
  };
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
