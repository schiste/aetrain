import {
  createDiagnostics,
  ingestRelayedEvent,
  summarizeError
} from "../app-shell/diagnostics.ts";
import { createPlannerModel } from "./planner-core.ts";
import type { DiagnosticsEvent } from "../types/diagnostics.ts";
import type {
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
  RawEdgeGeometries
} from "../types/planner-dataset.ts";
import type {
  PlannerEdge,
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
const WORKER_DIAG_SCOPE_PREFIX = "worker:planner";

/**
 * Recognize the worker-diagnostics envelope and forward it into the
 * main-thread store. Returns true if the message was a diagnostics relay
 * (caller should bail before running protocol handling), false otherwise.
 *
 * Defined as a free function so it can be attached to both the prewarmed
 * worker (events flowing during INITIALIZE wait) and the post-attach
 * handler — without this, the prewarm-window wasm prewarm metric would
 * be lost.
 */
function tryIngestWorkerDiagnostic(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const envelope = message as { __aetrain_diag?: DiagnosticsEvent };
  const event = envelope.__aetrain_diag;
  if (!event) {
    return false;
  }
  ingestRelayedEvent(event, WORKER_DIAG_SCOPE_PREFIX);
  return true;
}

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
  // Capture diag envelopes that may arrive during the prewarm window
  // (wasm-prewarm metric, early init logs) before attachPlannerClient
  // installs its own listener. The listener stays installed afterwards —
  // multiple addEventListener("message", ...) handlers all fire, and our
  // protocol handler bails on `__aetrain_diag` envelopes.
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    tryIngestWorkerDiagnostic(event.data);
  });
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
    // Same diag-relay shape as the prewarm path; see comment in
    // prewarmPlannerClient.
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      tryIngestWorkerDiagnostic(event.data);
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
    // Diag relay envelopes are caught by a sibling listener installed
    // when the worker is spawned; bail here so we don't treat them as
    // protocol messages.
    if ((message as { __aetrain_diag?: unknown }).__aetrain_diag) {
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
    },
    async augmentGeometry(rawEdgeGeometries: RawEdgeGeometries): Promise<void> {
      const result = await request<{ edges?: PlannerEdge[] }>(
        PLANNER_WORKER_MESSAGE_TYPES.AUGMENT_GEOMETRY,
        { rawEdgeGeometries }
      );
      // Mutate the metadata edges array we returned from initialize so
      // map / sidebar consumers that retained the original reference see
      // the new geometry on their next render pass.
      if (result?.edges) {
        const incoming = result.edges;
        const byKey = new Map<string, PlannerEdge>(
          incoming.map((edge) => [edge.key, edge])
        );
        for (const edge of metadata.edges) {
          const fresh = byKey.get(edge.key);
          if (fresh && fresh.geometry) {
            edge.geometry = fresh.geometry;
            // The worker flipped isStubGeometry to false on its side; mirror
            // that on the main-thread edge so the map surface culls correctly.
            edge.isStubGeometry = fresh.isStubGeometry ?? false;
          }
        }
      }
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
    },
    async augmentGeometry(rawEdgeGeometries: RawEdgeGeometries): Promise<void> {
      diagnostics.info("inline planner augmenting geometry", {
        geometry_count: rawEdgeGeometries.geometries.length
      });
      model.augmentGeometry(rawEdgeGeometries);
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
