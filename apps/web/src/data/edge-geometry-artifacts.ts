import type { Diagnostics } from "../types/diagnostics.ts";
import type { RawEdgeGeometries, RawEdgeGeometry } from "../types/planner-dataset.ts";

const EDGE_GEOMETRY_MANIFEST_FILE = "edge-geometries.manifest.json";
const EDGE_GEOMETRY_LEGACY_FILE = "edge-geometries.json";

/**
 * Geographic bounding box in WGS84 degrees. Optional per-chunk metadata
 * the backend will start emitting (see
 * docs/bugs/2026-05-edge-geometry-chunk-bboxes.md). When present the
 * frontend uses it to skip chunks that don't overlap the visible map.
 */
export interface EdgeGeometryBoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface EdgeGeometryManifestChunk {
  file: string;
  geometry_count?: number;
  /** Optional — added by the backend per the linked bug report. */
  bbox?: EdgeGeometryBoundingBox;
  [key: string]: unknown;
}

export interface EdgeGeometryManifest {
  chunks: EdgeGeometryManifestChunk[];
  total_geometry_count?: number;
  [key: string]: unknown;
}

export interface EdgeGeometryChunkPayload {
  geometries: RawEdgeGeometry[];
}

export interface EdgeGeometryFetcherDeps {
  basePaths: readonly string[];
  fetchJsonWithFallback(fileName: string): Promise<unknown>;
  fetchOptionalJsonWithFallback(
    fileName: string
  ): Promise<{ basePath: string; json: EdgeGeometryManifest } | null>;
  fetchJsonFromBasePath(basePath: string, fileName: string): Promise<unknown>;
  diagnostics?: Diagnostics;
}

export interface EdgeGeometryFetchOptions {
  /** Map viewport bbox (degrees). When set, chunks with non-intersecting
   *  bbox metadata are skipped. Chunks with no bbox are always fetched
   *  (graceful fallback for the pre-bbox manifest era). */
  viewport?: EdgeGeometryBoundingBox;
  /** Set of chunk `file` strings already fetched on previous calls.
   *  Used by the view-change re-fetcher to avoid re-loading the same
   *  chunk on every pan. */
  seenChunkFiles?: ReadonlySet<string>;
}

/**
 * Decide which manifest chunks need to be fetched right now.
 *
 * Filtering rules, in order:
 *   1. Drop chunks whose `file` is in `alreadyLoaded` (cache hit).
 *   2. If the chunk has no `bbox`, KEEP it (we can't filter without
 *      spatial metadata; this is the pre-backend-bbox-rollout state).
 *   3. If `viewport` is undefined, KEEP everything (initial load, no
 *      viewport awareness needed).
 *   4. Otherwise KEEP only chunks whose bbox intersects the viewport.
 */
export function selectVisibleChunks(
  chunks: readonly EdgeGeometryManifestChunk[],
  viewport: EdgeGeometryBoundingBox | undefined,
  alreadyLoaded: ReadonlySet<string> = new Set<string>()
): EdgeGeometryManifestChunk[] {
  const out: EdgeGeometryManifestChunk[] = [];
  for (const chunk of chunks) {
    if (alreadyLoaded.has(chunk.file)) {
      continue;
    }
    if (!viewport || !chunk.bbox) {
      out.push(chunk);
      continue;
    }
    if (boundingBoxesIntersect(chunk.bbox, viewport)) {
      out.push(chunk);
    }
  }
  return out;
}

function boundingBoxesIntersect(
  left: EdgeGeometryBoundingBox,
  right: EdgeGeometryBoundingBox
): boolean {
  return !(
    left.east < right.west
    || left.west > right.east
    || left.north < right.south
    || left.south > right.north
  );
}

export interface EdgeGeometryFetchResult {
  geometries: RawEdgeGeometries;
  /** The `file` strings the fetcher actually loaded. The legacy
   *  unchunked artifact path returns `[]` since there were no chunks. */
  loadedChunkFiles: string[];
}

export async function fetchEdgeGeometryArtifact(
  deps: EdgeGeometryFetcherDeps,
  options: EdgeGeometryFetchOptions = {}
): Promise<EdgeGeometryFetchResult> {
  const {
    basePaths,
    fetchJsonWithFallback,
    fetchOptionalJsonWithFallback,
    fetchJsonFromBasePath,
    diagnostics
  } = deps;
  const { viewport, seenChunkFiles } = options;
  const manifestResult = await fetchOptionalJsonWithFallback(EDGE_GEOMETRY_MANIFEST_FILE);
  if (manifestResult?.json) {
    const manifest = manifestResult.json;
    const allChunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
    const visible = selectVisibleChunks(allChunks, viewport, seenChunkFiles);
    diagnostics?.info("loading chunked edge geometry artifact", {
      base_path: manifestResult.basePath,
      chunk_count_total: allChunks.length,
      chunk_count_visible: visible.length,
      total_geometry_count: manifest.total_geometry_count ?? null,
      viewport_filtered: Boolean(viewport)
    });
    if (visible.length === 0) {
      return { geometries: { geometries: [] }, loadedChunkFiles: [] };
    }
    const chunkPayloads = await Promise.all(
      visible.map((chunk) =>
        fetchJsonFromBasePath(manifestResult.basePath, chunk.file)
      )
    );
    return {
      geometries: combineChunkedEdgeGeometryArtifact(
        { ...manifest, chunks: visible },
        chunkPayloads,
        { skipTotalCheck: visible.length !== allChunks.length }
      ),
      loadedChunkFiles: visible.map((chunk) => chunk.file)
    };
  }

  diagnostics?.info("loading legacy edge geometry artifact", {
    base_path_count: basePaths.length
  });
  return {
    geometries: (await fetchJsonWithFallback(EDGE_GEOMETRY_LEGACY_FILE)) as RawEdgeGeometries,
    loadedChunkFiles: []
  };
}

export function combineChunkedEdgeGeometryArtifact(
  manifest: EdgeGeometryManifest,
  chunkPayloads: readonly unknown[],
  options: { skipTotalCheck?: boolean } = {}
): RawEdgeGeometries {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Edge geometry manifest must be an object");
  }

  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  if (chunks.length !== chunkPayloads.length) {
    throw new Error("Edge geometry chunk payload count does not match manifest");
  }

  const geometries: RawEdgeGeometry[] = [];
  for (let index = 0; index < chunkPayloads.length; index += 1) {
    const chunkPayload = chunkPayloads[index];
    const chunkGeometries = Array.isArray(chunkPayload)
      ? (chunkPayload as RawEdgeGeometry[])
      : (chunkPayload as { geometries?: RawEdgeGeometry[] } | undefined)?.geometries;
    if (!Array.isArray(chunkGeometries)) {
      throw new Error(`Edge geometry chunk ${index} is not an array payload`);
    }
    geometries.push(...chunkGeometries);
  }

  if (
    !options.skipTotalCheck
    && Number.isFinite(manifest.total_geometry_count)
    && geometries.length !== manifest.total_geometry_count
  ) {
    throw new Error("Edge geometry chunk payloads do not match manifest geometry count");
  }

  return { geometries };
}
