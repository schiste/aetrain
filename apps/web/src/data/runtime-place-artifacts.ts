// Lazy runtime-place layer fetcher + browser projection.
//
// Two place layers ship beside the eager `cities.json` rail layer and are
// fetched on demand (manifest + bare-array chunk files), mirroring the
// edge-geometry and service-pattern lazy layers:
//
//   - service-places  (replacement_bus_stop) — revealed along loaded rail
//   - registry-places (registry_place)       — standalone authority municipalities
//
// This module owns BOTH the wire format and the renderable `PlannerPlace`
// projection. The canonical raw shapes live in types/planner-dataset.ts; we
// import them read-only and keep the browser-facing projection here (the
// production-adapter that would otherwise host it carries unrelated in-flight
// changes). A single `manifestFile` arg lets one fetcher serve both layers.

import type { Diagnostics } from "../types/diagnostics.ts";
import type {
  RawRuntimePlace,
  RawRuntimePlaceRole
} from "../types/planner-dataset.ts";

export interface RuntimePlaceManifestChunk {
  file: string;
  place_count?: number;
  rail_city_count?: number;
  replacement_bus_stop_count?: number;
  registry_place_count?: number;
  [key: string]: unknown;
}

export interface RuntimePlaceManifest {
  schema_version?: number;
  layer_id?: string;
  total_place_count?: number;
  rail_city_count?: number;
  replacement_bus_stop_count?: number;
  registry_place_count?: number;
  chunks: RuntimePlaceManifestChunk[];
  [key: string]: unknown;
}

/**
 * Renderable projection of a `RawRuntimePlace`. lat/lon are decoded from the
 * e5 fixed-point wire encoding; role + linked ids pass through so consumers
 * can distinguish layers and (later) dedupe against cities.
 */
export interface PlannerPlace {
  placeId: string;
  role: RawRuntimePlaceRole;
  displayName: string;
  lat: number;
  lon: number;
  linkedCityId?: string | null;
  linkedCityIndex?: number | null;
  population?: number | null;
}

export interface RuntimePlaceChunkResult {
  places: PlannerPlace[];
  chunkFile: string;
  loadedCount: number;
  totalCount: number;
}

export interface RuntimePlaceFetcherDeps {
  basePaths: readonly string[];
  fetchOptionalJsonWithFallback(
    fileName: string
  ): Promise<{ basePath: string; json: RuntimePlaceManifest } | null>;
  fetchJsonFromBasePath(basePath: string, fileName: string): Promise<unknown>;
  diagnostics?: Diagnostics;
}

export interface RuntimePlaceFetchOptions {
  /** Which layer's manifest to load (`service-places.manifest.json` or
   *  `registry-places.manifest.json`). Required — there is no legacy fallback
   *  file for place layers. */
  manifestFile: string;
  seenChunkFiles?: ReadonlySet<string>;
  onChunk?(chunk: RuntimePlaceChunkResult): void | Promise<void>;
}

export interface RuntimePlaceFetchResult {
  places: PlannerPlace[];
  loadedChunkFiles: string[];
}

/**
 * Decode a batch of raw places into renderable `PlannerPlace`s. The e5 →
 * degrees decode matches the station/geometry idiom (lat_e5 / 100_000) used
 * across the runtime adapters.
 */
export function adaptRuntimePlaces(raw: readonly RawRuntimePlace[]): PlannerPlace[] {
  return raw.map((place) => ({
    placeId: place.place_id,
    role: place.role,
    displayName: place.display_name,
    lat: place.lat_e5 / 100_000,
    lon: place.lon_e5 / 100_000,
    linkedCityId: place.linked_city_id ?? null,
    linkedCityIndex: place.linked_city_index ?? null,
    population: place.population ?? null
  }));
}

export function selectPendingPlaceChunks(
  chunks: readonly RuntimePlaceManifestChunk[],
  alreadyLoaded: ReadonlySet<string> = new Set<string>()
): RuntimePlaceManifestChunk[] {
  return chunks.filter((chunk) => !alreadyLoaded.has(chunk.file));
}

export async function fetchRuntimePlaceArtifact(
  deps: RuntimePlaceFetcherDeps,
  options: RuntimePlaceFetchOptions
): Promise<RuntimePlaceFetchResult> {
  const { fetchOptionalJsonWithFallback, fetchJsonFromBasePath, diagnostics } = deps;
  const { manifestFile, seenChunkFiles, onChunk } = options;

  const manifestResult = await fetchOptionalJsonWithFallback(manifestFile);
  if (!manifestResult?.json) {
    // No manifest for this layer (e.g. an older dataset without the place
    // layers). Treat as "nothing to load" rather than an error — the layer is
    // optional and the map degrades to cities-only.
    diagnostics?.info("runtime place layer manifest absent", {
      manifest_file: manifestFile
    });
    return { places: [], loadedChunkFiles: [] };
  }

  const manifest = manifestResult.json;
  const allChunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const pending = selectPendingPlaceChunks(allChunks, seenChunkFiles);
  diagnostics?.info("loading runtime place artifact", {
    manifest_file: manifestFile,
    layer_id: manifest.layer_id ?? null,
    base_path: manifestResult.basePath,
    chunk_count_total: allChunks.length,
    chunk_count_pending: pending.length,
    total_place_count: manifest.total_place_count ?? null,
    streaming: Boolean(onChunk)
  });

  if (pending.length === 0) {
    return { places: [], loadedChunkFiles: [] };
  }

  const totalCount = pending.length;
  let loadedCount = 0;
  // Serial emit chain so streamed chunk callbacks run one at a time in
  // resolution order, matching the edge-geometry/service-pattern fetchers.
  let emitChain: Promise<void> = Promise.resolve();
  const allPlaces: PlannerPlace[] = [];

  const chunkPlaces = await Promise.all(
    pending.map(async (chunk, index) => {
      const payload = await fetchJsonFromBasePath(manifestResult.basePath, chunk.file);
      const places = adaptRuntimePlaces(chunkPayloadToPlaces(payload, index));
      if (onChunk) {
        emitChain = emitChain.then(() => {
          loadedCount += 1;
          return onChunk({
            places,
            chunkFile: chunk.file,
            loadedCount,
            totalCount
          });
        });
      }
      return places;
    })
  );
  if (onChunk) {
    await emitChain;
  }

  for (const places of chunkPlaces) {
    allPlaces.push(...places);
  }

  return {
    places: allPlaces,
    loadedChunkFiles: pending.map((chunk) => chunk.file)
  };
}

/**
 * Place chunks are bare JSON arrays of `RawRuntimePlace` (the
 * `RawRuntimePlaceLayerArtifact {schema_version, layer_id, places}` wrapper
 * describes the combined layer, never an individual chunk). Accept the bare
 * array, tolerate the wrapper, else throw.
 */
export function chunkPayloadToPlaces(
  chunkPayload: unknown,
  index: number
): RawRuntimePlace[] {
  const chunkPlaces = Array.isArray(chunkPayload)
    ? (chunkPayload as RawRuntimePlace[])
    : (chunkPayload as { places?: RawRuntimePlace[] } | undefined)?.places;
  if (!Array.isArray(chunkPlaces)) {
    throw new Error(`Runtime place chunk ${index} is not an array payload`);
  }
  return chunkPlaces;
}
