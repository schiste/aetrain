import type { Diagnostics } from "../types/diagnostics.ts";

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

const SERVICE_PATTERN_MANIFEST_FILE = "services.manifest.json";
const SERVICE_PATTERN_LEGACY_FILE = "services.json";

export interface ServicePatternManifestChunk {
  file: string;
  pattern_count?: number;
  rail_pattern_count?: number;
  replacement_bus_pattern_count?: number;
  [key: string]: unknown;
}

export interface ServicePatternManifest {
  schema_version?: number;
  total_pattern_count?: number;
  rail_pattern_count?: number;
  replacement_bus_pattern_count?: number;
  chunks: ServicePatternManifestChunk[];
  [key: string]: unknown;
}

export interface ServicePatternChunkResult {
  services: RawServicePatternArtifact;
  chunkFile: string;
  loadedCount: number;
  totalCount: number;
}

export interface ServicePatternFetcherDeps {
  basePaths: readonly string[];
  fetchJsonWithFallback(fileName: string): Promise<unknown>;
  fetchOptionalJsonWithFallback(
    fileName: string
  ): Promise<{ basePath: string; json: ServicePatternManifest } | null>;
  fetchJsonFromBasePath(basePath: string, fileName: string): Promise<unknown>;
  diagnostics?: Diagnostics;
}

export interface ServicePatternFetchOptions {
  seenChunkFiles?: ReadonlySet<string>;
  onChunk?(chunk: ServicePatternChunkResult): void | Promise<void>;
}

export interface ServicePatternFetchResult {
  services: RawServicePatternArtifact;
  loadedChunkFiles: string[];
}

export function selectPendingServiceChunks(
  chunks: readonly ServicePatternManifestChunk[],
  alreadyLoaded: ReadonlySet<string> = new Set<string>()
): ServicePatternManifestChunk[] {
  return chunks.filter((chunk) => !alreadyLoaded.has(chunk.file));
}

export async function fetchServicePatternArtifact(
  deps: ServicePatternFetcherDeps,
  options: ServicePatternFetchOptions = {}
): Promise<ServicePatternFetchResult> {
  const {
    basePaths,
    fetchJsonWithFallback,
    fetchOptionalJsonWithFallback,
    fetchJsonFromBasePath,
    diagnostics
  } = deps;
  const { seenChunkFiles, onChunk } = options;
  const manifestResult = await fetchOptionalJsonWithFallback(SERVICE_PATTERN_MANIFEST_FILE);
  if (manifestResult?.json) {
    const manifest = manifestResult.json;
    const allChunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
    const pending = selectPendingServiceChunks(allChunks, seenChunkFiles);
    diagnostics?.info("loading chunked service pattern artifact", {
      base_path: manifestResult.basePath,
      chunk_count_total: allChunks.length,
      chunk_count_pending: pending.length,
      total_pattern_count: manifest.total_pattern_count ?? null,
      rail_pattern_count: manifest.rail_pattern_count ?? null,
      replacement_bus_pattern_count: manifest.replacement_bus_pattern_count ?? null,
      streaming: Boolean(onChunk)
    });
    if (pending.length === 0) {
      return {
        services: {
          schema_version: manifest.schema_version ?? 0,
          patterns: []
        },
        loadedChunkFiles: []
      };
    }

    const totalCount = pending.length;
    let loadedCount = 0;
    let emitChain: Promise<void> = Promise.resolve();
    const chunkPayloads = await Promise.all(
      pending.map(async (chunk, index) => {
        const payload = await fetchJsonFromBasePath(manifestResult.basePath, chunk.file);
        if (onChunk) {
          const patterns = chunkPayloadToPatterns(payload, index);
          emitChain = emitChain.then(() => {
            loadedCount += 1;
            return onChunk({
              services: {
                schema_version: manifest.schema_version ?? 0,
                patterns
              },
              chunkFile: chunk.file,
              loadedCount,
              totalCount
            });
          });
        }
        return payload;
      })
    );
    if (onChunk) {
      await emitChain;
    }

    return {
      services: combineChunkedServicePatternArtifact(
        { ...manifest, chunks: pending },
        chunkPayloads,
        { skipTotalCheck: pending.length !== allChunks.length }
      ),
      loadedChunkFiles: pending.map((chunk) => chunk.file)
    };
  }

  diagnostics?.info("loading legacy service pattern artifact", {
    base_path_count: basePaths.length
  });
  return {
    services: (await fetchJsonWithFallback(SERVICE_PATTERN_LEGACY_FILE)) as RawServicePatternArtifact,
    loadedChunkFiles: []
  };
}

export function combineChunkedServicePatternArtifact(
  manifest: ServicePatternManifest,
  chunkPayloads: readonly unknown[],
  options: { skipTotalCheck?: boolean } = {}
): RawServicePatternArtifact {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Service pattern manifest must be an object");
  }

  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  if (chunks.length !== chunkPayloads.length) {
    throw new Error("Service pattern chunk payload count does not match manifest");
  }

  const patterns: RawServicePattern[] = [];
  for (let index = 0; index < chunkPayloads.length; index += 1) {
    patterns.push(...chunkPayloadToPatterns(chunkPayloads[index], index));
  }

  if (
    !options.skipTotalCheck
    && Number.isFinite(manifest.total_pattern_count)
    && patterns.length !== manifest.total_pattern_count
  ) {
    throw new Error("Service pattern chunk payloads do not match manifest pattern count");
  }

  return {
    schema_version: manifest.schema_version ?? 0,
    patterns
  };
}

function chunkPayloadToPatterns(
  chunkPayload: unknown,
  index: number
): RawServicePattern[] {
  const chunkPatterns = Array.isArray(chunkPayload)
    ? (chunkPayload as RawServicePattern[])
    : (chunkPayload as { patterns?: RawServicePattern[] } | undefined)?.patterns;
  if (!Array.isArray(chunkPatterns)) {
    throw new Error(`Service pattern chunk ${index} is not an array payload`);
  }
  return chunkPatterns;
}
