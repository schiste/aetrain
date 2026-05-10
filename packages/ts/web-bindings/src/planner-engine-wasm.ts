// Thin TypeScript wrapper around the wasm-pack output of
// packages/rust/aetrain-routing-wasm. All interesting logic lives in Rust;
// this module owns: WASM instance lifecycle (initialised once per module),
// JSON-shape narrowing on the JS side, and a typed surface that conforms to
// the planner-protocol the worker programs against.

import initWasm, {
  PlannerGraph as WasmPlannerGraph
} from "../../../rust/aetrain-routing-wasm/pkg/aetrain_routing_wasm.js";
import wasmUrl from "../../../rust/aetrain-routing-wasm/pkg/aetrain_routing_wasm_bg.wasm?url";

export interface PlannerNodeInput {
  name: string;
  lat: number;
  lon: number;
  country: string;
  population: number;
  interest: number;
}

export interface PlannerEdgeInput {
  from: string;
  to: string;
  minutes: number;
}

export interface PlannerRouteResult {
  time: number;
  path: string[];
}

export interface PlannerSuggestion {
  name: string;
  afterStop: number;
  detourMin: number;
}

export interface WasmPlannerEngine {
  cityCount(): number;
  edgeCount(): number;
  invalidEdgeKeys(): string[];
  shortestPath(from: string, to: string): PlannerRouteResult | null;
  shortestPathAll(from: string): Record<string, number>;
  findInterestingStops(
    trip: readonly string[],
    segments: readonly PlannerRouteResult[]
  ): PlannerSuggestion[];
  searchCities(query: string, limit: number): PlannerNodeInput[];
  /** Releases the underlying WASM instance handle. Idempotent. */
  free(): void;
}

let wasmReady: Promise<void> | null = null;

async function ensureWasmInitialised(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm({ module_or_path: wasmUrl }).then(() => undefined);
  }
  return wasmReady;
}

/**
 * Kick off the WASM module compile without waiting on it. Safe to call
 * many times — the underlying promise is cached. The planner worker
 * calls this at module-load time so the ~300ms wasm-bindgen init runs
 * in parallel with the dataset fetch + parse, instead of blocking the
 * INITIALIZE message that arrives after both finish.
 *
 * The returned promise can be awaited if a caller needs to gate on
 * readiness; createWasmPlannerEngine already awaits it internally.
 */
export function prewarmWasm(): Promise<void> {
  return ensureWasmInitialised();
}

export async function createWasmPlannerEngine(
  nodes: readonly PlannerNodeInput[],
  edges: readonly PlannerEdgeInput[]
): Promise<WasmPlannerEngine> {
  await ensureWasmInitialised();
  const graph = new WasmPlannerGraph(nodes, edges);
  let disposed = false;

  return {
    cityCount: () => graph.cityCount(),
    edgeCount: () => graph.edgeCount(),
    invalidEdgeKeys: () => graph.invalidEdgeKeys() as string[],
    shortestPath: (from: string, to: string) =>
      graph.shortestPath(from, to) as PlannerRouteResult | null,
    shortestPathAll: (from: string) =>
      graph.shortestPathAll(from) as Record<string, number>,
    findInterestingStops: (trip, segments) =>
      graph.findInterestingStops(
        trip as string[],
        segments as PlannerRouteResult[]
      ) as PlannerSuggestion[],
    searchCities: (query: string, limit: number) =>
      graph.searchCities(query, limit) as PlannerNodeInput[],
    free: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      graph.free();
    }
  };
}
