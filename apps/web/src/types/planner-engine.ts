// Public planner engine interface used by the store, UI, workers, and clients.
// The engine/planner-core.ts module provides an inline implementation; the worker/client
// pair (engine/planner-client.ts + workers/planner.worker.ts) provides a
// concurrent implementation that conforms to the same shape.

import type {
  GeoPoint,
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
  RawEdgeGeometries,
  SearchIndexEntry
} from "./planner-dataset.ts";

export interface PlannerEdge {
  from: string;
  to: string;
  fromIndex: number;
  toIndex: number;
  minutes: number;
  key: string;
  geometry?: GeoPoint[];
  // True when geometry is a 2-point endpoint stub synthesized by the data
  // adapter (no real polyline available for this corridor yet). Flipped to
  // false in augmentGeometry once a chunk-backed polyline is merged.
  isStubGeometry?: boolean;
}

export interface PlannerAdjacencyEntry {
  toIndex: number;
  t: number;
  geometry?: GeoPoint[];
  isStubGeometry?: boolean;
}

export interface PlannerSearchIndexEntry {
  city: PlannerCity;
  cityNameNormalized: string;
  countryNormalized: string;
  searchText: string;
}

export interface PlannerRouteResult {
  time: number;
  path: string[];
  geometry?: GeoPoint[];
}

export type PlannerReachableDistances = Record<string, number>;

export interface PlannerSegment extends PlannerRouteResult {}

export interface PlannerSuggestion {
  name: string;
  city: PlannerCity;
  afterStop: number;
  detourMin: number;
}

export interface PlannerTripPlan {
  distFromLast: PlannerReachableDistances;
  segments: (PlannerSegment | null)[];
  suggestions: PlannerSuggestion[];
}

export type PlannerEngineKind = "wasm" | "js-fallback";

export interface PlannerModelMetadata {
  cities: PlannerCity[];
  cityMap: Record<string, PlannerCity>;
  edges: PlannerEdge[];
  invalidRouteKeys: string[];
  /**
   * Identifies the engine that produced this metadata. Optional so legacy
   * metadata payloads stay structurally compatible; populated by the worker
   * (planner.worker.ts) and the inline fallback in planner-client.ts.
   */
  engineKind?: PlannerEngineKind;
}

export interface PlannerModel extends PlannerModelMetadata {
  adjacency: PlannerAdjacencyEntry[][];
  cityIndexByName: Map<string, number>;
  searchIndex: PlannerSearchIndexEntry[];
  dijkstra(startName: string, endName: string): PlannerRouteResult | null;
  dijkstraAll(startName: string): PlannerReachableDistances;
  findInterestingStops(
    segments: (PlannerSegment | null)[],
    tripNames: string[]
  ): PlannerSuggestion[];
  deriveTripPlan(trip: string[]): PlannerTripPlan;
  searchCities(query: string, limit?: number): PlannerCity[];
  /**
   * Hot-upgrade path: merge a freshly-loaded RawEdgeGeometries artifact into
   * the model's geometry index (and the metadata edges array) without
   * rebuilding the routing graph. Routing continues to use straight-line
   * fallbacks until the next derive that observes the augmented geometry.
   */
  augmentGeometry(rawEdgeGeometries: RawEdgeGeometries): void;
}

export interface PlannerEngine {
  metadata: PlannerModelMetadata;
  close(): void;
  deriveTripPlan(args: { trip: string[] }): Promise<PlannerTripPlan>;
  searchCities(args: { query: string; limit: number }): Promise<PlannerCity[]>;
  /**
   * Augment the worker-side planner model with previously-deferred edge
   * geometry. Resolves once the worker has merged the new geometry index
   * — the next derive call will produce route polylines with curves.
   */
  augmentGeometry(rawEdgeGeometries: RawEdgeGeometries): Promise<void>;
}

// Convenience re-exports so consumers can pull dataset shapes from one place.
export type {
  GeoPoint,
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
  SearchIndexEntry
};
