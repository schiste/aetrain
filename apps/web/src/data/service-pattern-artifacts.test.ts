import test from "node:test";
import assert from "node:assert/strict";

import {
  combineChunkedServicePatternArtifact,
  fetchServicePatternArtifact,
  type RawServicePattern,
  type ServicePatternChunkResult,
  type ServicePatternFetcherDeps
} from "./service-pattern-artifacts.ts";

function servicePattern(id: string, replacementBus = false): RawServicePattern {
  return {
    pattern_id: id,
    source_id: "test-gtfs",
    route_id: `route-${id}`,
    route_type: replacementBus ? 3 : 2,
    mode: replacementBus ? "replacement_bus" : "rail",
    replacement_bus: replacementBus,
    trip_count: 1,
    sample_trip_ids: [`trip-${id}`],
    service_ids: [`service-${id}`],
    headsigns: [`headsign-${id}`],
    service_date_count: 1,
    first_service_date: "20260525",
    last_service_date: "20260525",
    stop_count: 2,
    mapped_city_count: 2,
    direct_journey_pair_count: 1,
    stops: [
      {
        stop_index: 0,
        stop_sequence: 1,
        source_stop_id: `stop-${id}-a`,
        station_key: `station-${id}-a`,
        station_id: `station-${id}-a`,
        city_id: `city-${id}-a-fr`,
        display_name: "Origin",
        lat_e5: 4_800_000,
        lon_e5: 200_000,
        departure_seconds: 7 * 3600
      },
      {
        stop_index: 1,
        stop_sequence: 2,
        source_stop_id: `stop-${id}-b`,
        station_key: `station-${id}-b`,
        station_id: `station-${id}-b`,
        city_id: `city-${id}-b-fr`,
        display_name: "Destination",
        lat_e5: 4_810_000,
        lon_e5: 210_000,
        arrival_seconds: 8 * 3600
      }
    ]
  };
}

test("combineChunkedServicePatternArtifact merges chunk arrays into one artifact", () => {
  const artifact = combineChunkedServicePatternArtifact(
    {
      version: 1,
      schema_version: 1,
      total_pattern_count: 3,
      chunks: [
        { file: "services/chunk-0000.json", pattern_count: 2 },
        { file: "services/chunk-0001.json", pattern_count: 1 }
      ]
    },
    [
      [servicePattern("a"), servicePattern("b", true)],
      [servicePattern("c")]
    ]
  );

  assert.equal(artifact.schema_version, 1);
  assert.equal(artifact.patterns.length, 3);
  assert.equal(artifact.patterns[1]!.mode, "replacement_bus");
});

test("combineChunkedServicePatternArtifact rejects mismatched pattern totals", () => {
  assert.throws(
    () =>
      combineChunkedServicePatternArtifact(
        {
          version: 1,
          schema_version: 1,
          total_pattern_count: 2,
          chunks: [{ file: "services/chunk-0000.json", pattern_count: 1 }]
        },
        [[servicePattern("a")]]
      ),
    /pattern count/
  );
});

function streamingDeps(chunkDelays: Record<string, number>): ServicePatternFetcherDeps {
  const manifest = {
    version: 1,
    schema_version: 1,
    total_pattern_count: 3,
    chunks: [
      { file: "chunk-0000.json", pattern_count: 1 },
      { file: "chunk-0001.json", pattern_count: 1 },
      { file: "chunk-0002.json", pattern_count: 1 }
    ]
  };
  const payloads: Record<string, unknown> = {
    "chunk-0000.json": [servicePattern("a")],
    "chunk-0001.json": [servicePattern("b")],
    "chunk-0002.json": [servicePattern("c", true)]
  };
  return {
    basePaths: ["/data/"],
    fetchJsonWithFallback: async () => {
      throw new Error("legacy path should not be hit");
    },
    fetchOptionalJsonWithFallback: async () => ({ basePath: "/data/", json: manifest }),
    fetchJsonFromBasePath: (_basePath: string, file: string) =>
      new Promise((resolve) =>
        setTimeout(() => resolve(payloads[file]), chunkDelays[file] ?? 0)
      )
  };
}

test("fetchServicePatternArtifact streams onChunk in resolution order", async () => {
  const emitted: ServicePatternChunkResult[] = [];
  const result = await fetchServicePatternArtifact(
    streamingDeps({ "chunk-0000.json": 30, "chunk-0001.json": 20, "chunk-0002.json": 10 }),
    {
      onChunk: (chunk) => {
        emitted.push(chunk);
      }
    }
  );

  assert.deepEqual(
    emitted.map((chunk) => chunk.chunkFile),
    ["chunk-0002.json", "chunk-0001.json", "chunk-0000.json"]
  );
  assert.deepEqual(emitted.map((chunk) => chunk.loadedCount), [1, 2, 3]);
  assert.equal(emitted[0]!.services.patterns[0]!.mode, "replacement_bus");
  assert.equal(result.services.patterns.length, 3);
  assert.deepEqual(result.loadedChunkFiles, [
    "chunk-0000.json",
    "chunk-0001.json",
    "chunk-0002.json"
  ]);
});
