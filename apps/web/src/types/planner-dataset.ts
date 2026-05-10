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

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface RoutePair {
  from: string;
  to: string;
  minutes: number;
  geometry?: GeoPoint[];
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
  routeData: PlannerRouteData;
  plannerArtifacts?: PlannerArtifacts;
  meta?: RuntimeArtifactMeta;
}

// Raw artifact shapes (as fetched from data/build/stage1/<target>/runtime/).

export interface RawCityLocation {
  lat: number;
  lon: number;
}

export interface RawCity {
  city_id: string;
  display_name: string;
  country_code: string;
  location: RawCityLocation;
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

export interface ProductionArtifactBundle {
  meta: RuntimeArtifactMeta;
  rawCities: RawCity[];
  rawEdges: RawEdge[];
  rawEdgeGeometries: RawEdgeGeometries;
}
