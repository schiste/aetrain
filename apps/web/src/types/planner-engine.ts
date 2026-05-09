// Public planner engine interface used by the store, UI, workers, and clients.
// The legacy/core.ts module provides an inline implementation; the worker/client
// pair (engine/planner-client.ts + workers/planner.worker.ts) provides a
// concurrent implementation that conforms to the same shape.

import type {
  GeoPoint,
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
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
}

export interface PlannerAdjacencyEntry {
  toIndex: number;
  t: number;
  geometry?: GeoPoint[];
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

export interface PlannerModelMetadata {
  cities: PlannerCity[];
  cityMap: Record<string, PlannerCity>;
  edges: PlannerEdge[];
  invalidRouteKeys: string[];
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
}

export interface PlannerEngine {
  metadata: PlannerModelMetadata;
  close(): void;
  deriveTripPlan(args: { trip: string[] }): Promise<PlannerTripPlan>;
  searchCities(args: { query: string; limit: number }): Promise<PlannerCity[]>;
}

// Convenience re-exports so consumers can pull dataset shapes from one place.
export type {
  GeoPoint,
  PlannerArtifacts,
  PlannerCity,
  PlannerRouteData,
  SearchIndexEntry
};
