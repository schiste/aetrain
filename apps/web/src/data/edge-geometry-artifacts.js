const EDGE_GEOMETRY_MANIFEST_FILE = "edge-geometries.manifest.json";
const EDGE_GEOMETRY_LEGACY_FILE = "edge-geometries.json";

export async function fetchEdgeGeometryArtifact({
  basePaths,
  fetchJsonWithFallback,
  fetchOptionalJsonWithFallback,
  fetchJsonFromBasePath,
  diagnostics
}) {
  const manifestResult = await fetchOptionalJsonWithFallback(EDGE_GEOMETRY_MANIFEST_FILE);
  if (manifestResult?.json) {
    diagnostics?.info?.("loading chunked edge geometry artifact", {
      base_path: manifestResult.basePath,
      chunk_count: manifestResult.json.chunks?.length || 0,
      total_geometry_count: manifestResult.json.total_geometry_count ?? null
    });
    const chunkPayloads = await Promise.all(
      (manifestResult.json.chunks || []).map((chunk) =>
        fetchJsonFromBasePath(manifestResult.basePath, chunk.file)
      )
    );
    return combineChunkedEdgeGeometryArtifact(manifestResult.json, chunkPayloads);
  }

  diagnostics?.info?.("loading legacy edge geometry artifact", {
    base_path_count: basePaths.length
  });
  return fetchJsonWithFallback(EDGE_GEOMETRY_LEGACY_FILE);
}

export function combineChunkedEdgeGeometryArtifact(manifest, chunkPayloads) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Edge geometry manifest must be an object");
  }

  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  if (chunks.length !== chunkPayloads.length) {
    throw new Error("Edge geometry chunk payload count does not match manifest");
  }

  const geometries = [];
  for (let index = 0; index < chunkPayloads.length; index += 1) {
    const chunkPayload = chunkPayloads[index];
    const chunkGeometries = Array.isArray(chunkPayload)
      ? chunkPayload
      : chunkPayload?.geometries;
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
