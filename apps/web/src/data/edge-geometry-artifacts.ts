import type { Diagnostics } from "../types/diagnostics.ts";
import type { RawEdgeGeometries, RawEdgeGeometry } from "../types/planner-dataset.ts";

const EDGE_GEOMETRY_MANIFEST_FILE = "edge-geometries.manifest.json";
const EDGE_GEOMETRY_LEGACY_FILE = "edge-geometries.json";

export interface EdgeGeometryManifestChunk {
  file: string;
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

export async function fetchEdgeGeometryArtifact(
  deps: EdgeGeometryFetcherDeps
): Promise<RawEdgeGeometries> {
  const {
    basePaths,
    fetchJsonWithFallback,
    fetchOptionalJsonWithFallback,
    fetchJsonFromBasePath,
    diagnostics
  } = deps;
  const manifestResult = await fetchOptionalJsonWithFallback(EDGE_GEOMETRY_MANIFEST_FILE);
  if (manifestResult?.json) {
    const manifest = manifestResult.json;
    diagnostics?.info("loading chunked edge geometry artifact", {
      base_path: manifestResult.basePath,
      chunk_count: manifest.chunks?.length || 0,
      total_geometry_count: manifest.total_geometry_count ?? null
    });
    const chunkPayloads = await Promise.all(
      (manifest.chunks || []).map((chunk) =>
        fetchJsonFromBasePath(manifestResult.basePath, chunk.file)
      )
    );
    return combineChunkedEdgeGeometryArtifact(manifest, chunkPayloads);
  }

  diagnostics?.info("loading legacy edge geometry artifact", {
    base_path_count: basePaths.length
  });
  return (await fetchJsonWithFallback(EDGE_GEOMETRY_LEGACY_FILE)) as RawEdgeGeometries;
}

export function combineChunkedEdgeGeometryArtifact(
  manifest: EdgeGeometryManifest,
  chunkPayloads: readonly unknown[]
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
    Number.isFinite(manifest.total_geometry_count) &&
    geometries.length !== manifest.total_geometry_count
  ) {
    throw new Error("Edge geometry chunk payloads do not match manifest geometry count");
  }

  return { geometries };
}
