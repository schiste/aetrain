// Browser-facing planner data shapes.
// These are the runtime (renderable, queryable) projections of the canonical
// pipeline artifacts; see ../data/planner-dataset-contracts.ts for the
// runtime validators that police the boundary.

// The runtime carries a single canonical dataset; the source-switch UX
// (and the POC fallback) was removed in favour of a hard error state when
// the production load fails.
export type PlannerDataSourceId = "production";

export interface PlannerCity {
  name: string;
  lat: number;
  lon: number;
  country: string;
  pop: number;
  interest: number;
}

export interface PlannerStation {
  stationId: string;
  name: string;
  cityIndex: number;
  cityName: string;
  lat: number;
  lon: number;
  railAnchorLat?: number | null;
  railAnchorLon?: number | null;
  stationKind?: string | null;
  stationScope?: string | null;
  stationComplexId?: string | null;
  wikidataQid?: string | null;
  uicCode?: string | null;
  prominence?: number | null;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface RoutePair {
  from: string;
  to: string;
  minutes: number;
  geometry?: GeoPoint[];
  // True when geometry is a synthesized 2-point endpoint stub rather than a
  // real polyline. The map surface uses this to hide grey straight-line
  // edges for routes whose chunk hasn't loaded (or never will).
  isStubGeometry?: boolean;
}

export interface SearchIndexEntry {
  cityIndex: number;
  cityNameNormalized: string;
  countryNormalized: string;
  searchText: string;
}

export interface PlannerArtifacts {
  routePairs?: RoutePair[];
  searchIndex?: SearchIndexEntry[];
  /**
   * Reverse map from raw city_id → resolved display name, populated by
   * production-adapter so engines can resolve a deferred RawEdgeGeometries
   * artifact (which is keyed by city_id) against the in-memory edge list
   * (which is keyed by display name) when augmentGeometry runs.
   */
  nameByCityId?: Record<string, string>;
}

export type PlannerRouteData = Record<string, number>;

export interface RuntimeArtifactMeta {
  dataset_version: string;
  schema_version: number;
  generated_at?: string;
  [key: string]: unknown;
}

export interface PlannerDataset {
  id: PlannerDataSourceId;
  label: string;
  description: string;
  cities: PlannerCity[];
  stations?: PlannerStation[];
  routeData: PlannerRouteData;
  plannerArtifacts?: PlannerArtifacts;
  meta?: RuntimeArtifactMeta;
}

// Raw artifact shapes (as fetched from data/build/stage1/<target>/runtime/).

export interface RawCityLocation {
  lat: number;
  lon: number;
}

export interface RawCityRailTerminalAnchor {
  station_id?: string | null;
  display_name?: string | null;
  station_location?: RawCityLocation | null;
  rail_location: RawCityLocation;
  station_to_rail_distance_m?: number | null;
  edge_endpoint_use_count: number;
}

export interface RawCityRailProfile {
  city_id: string;
  map_location: RawCityLocation;
  anchor_strategy: string;
  confidence: string;
  terminal_count: number;
  terminal_station_ids: string[];
  terminal_spread_m: number;
  civic_to_map_distance_m: number;
  terminals: RawCityRailTerminalAnchor[];
}

export interface RawCity {
  city_id: string;
  display_name: string;
  country_code: string;
  location: RawCityLocation;
  map_location?: RawCityLocation | null;
  rail_profile?: RawCityRailProfile | null;
  wikidata_qid?: string | null;
  population?: number | null;
  interest_score?: number | null;
  station_ids?: string[];
  aliases?: string[];
}

export interface RawEdge {
  from_city_id: string;
  to_city_id: string;
  duration_min: number;
  [key: string]: unknown;
}

export interface RawStation {
  station_id: string;
  city_index: number;
  display_name: string;
  lat_e5: number;
  lon_e5: number;
  rail_anchor_lat_e5?: number | null;
  rail_anchor_lon_e5?: number | null;
  station_kind?: string | null;
  station_scope?: string | null;
  station_complex_id?: string | null;
  wikidata_qid?: string | null;
  uic_code?: string | null;
  prominence?: number | null;
}

export interface RawStationArtifact {
  stations: RawStation[];
}

export interface RawEdgeGeometryPoint {
  lat_e5: number;
  lon_e5: number;
}

export interface RawEdgeGeometry {
  from_city_id: string;
  to_city_id: string;
  source: string;
  points: RawEdgeGeometryPoint[];
}

export interface RawEdgeGeometries {
  geometries: RawEdgeGeometry[];
}

export type RawServicePatternMode = "rail" | "replacement_bus";

export interface RawServicePatternStop {
  stop_index: number;
  stop_sequence: number;
  source_stop_id: string;
  station_key: string;
  station_id?: string | null;
  city_id?: string | null;
  display_name: string;
  lat_e5: number;
  lon_e5: number;
  arrival_seconds?: number | null;
  departure_seconds?: number | null;
}

export interface RawServicePattern {
  pattern_id: string;
  source_id: string;
  route_id: string;
  route_type: number;
  mode: RawServicePatternMode;
  replacement_bus: boolean;
  trip_count: number;
  sample_trip_ids: string[];
  service_ids: string[];
  headsigns: string[];
  service_date_count: number;
  first_service_date?: string | null;
  last_service_date?: string | null;
  stop_count: number;
  mapped_city_count: number;
  direct_journey_pair_count: number;
  stops: RawServicePatternStop[];
}

export interface RawServicePatternArtifact {
  schema_version: number;
  patterns: RawServicePattern[];
}

export type RawRuntimePlaceRole = "rail_city" | "replacement_bus_stop" | "registry_place";

export interface RawRuntimePlace {
  place_id: string;
  role: RawRuntimePlaceRole;
  display_name: string;
  country_code?: string | null;
  lat_e5: number;
  lon_e5: number;
  linked_city_id?: string | null;
  linked_city_index?: number | null;
  linked_station_id?: string | null;
  wikidata_qid?: string | null;
  population?: number | null;
  source_ids?: string[];
  source_stop_ids?: string[];
  service_pattern_count: number;
}

export interface RawRuntimePlaceLayerArtifact {
  schema_version: number;
  layer_id: string;
  places: RawRuntimePlace[];
}

export interface ProductionArtifactBundle {
  meta: RuntimeArtifactMeta;
  rawCities: RawCity[];
  rawEdges: RawEdge[];
  rawEdgeGeometries: RawEdgeGeometries;
  rawStations?: RawStationArtifact | null;
}
