import test from "node:test";
import assert from "node:assert/strict";

import {
  combineChunkedEdgeGeometryArtifact,
  fetchEdgeGeometryArtifact,
  type EdgeGeometryChunkResult,
  type EdgeGeometryFetcherDeps
} from "./edge-geometry-artifacts.ts";

test("combineChunkedEdgeGeometryArtifact merges chunk arrays into one artifact", () => {
  const artifact = combineChunkedEdgeGeometryArtifact(
    {
      version: 1,
      total_geometry_count: 3,
      chunks: [
        { file: "edge-geometries/chunk-0000.json", geometry_count: 2 },
        { file: "edge-geometries/chunk-0001.json", geometry_count: 1 }
      ]
    },
    [
      [
        { from_city_id: "paris-fr", to_city_id: "lyon-fr", points: [] },
        { from_city_id: "lyon-fr", to_city_id: "marseille-fr", points: [] }
      ],
      [{ from_city_id: "paris-fr", to_city_id: "lille-fr", points: [] }]
    ]
  );

  assert.equal(artifact.geometries.length, 3);
  assert.equal(artifact.geometries[2]!.to_city_id, "lille-fr");
});

test("combineChunkedEdgeGeometryArtifact rejects mismatched geometry totals", () => {
  assert.throws(
    () =>
      combineChunkedEdgeGeometryArtifact(
        {
          version: 1,
          total_geometry_count: 2,
          chunks: [{ file: "edge-geometries/chunk-0000.json", geometry_count: 1 }]
        },
        [[{ from_city_id: "paris-fr", to_city_id: "lyon-fr", points: [] }]]
      ),
    /geometry count/
  );
});

// A deps stub whose chunk fetches resolve after a per-file delay, so we can
// force resolution order to differ from manifest order and prove `onChunk`
// fires in the order chunks actually *land*, not the order they were listed.
function streamingDeps(chunkDelays: Record<string, number>): EdgeGeometryFetcherDeps {
  const manifest = {
    version: 1,
    total_geometry_count: 3,
    chunks: [
      { file: "chunk-0000.json", geometry_count: 1 },
      { file: "chunk-0001.json", geometry_count: 1 },
      { file: "chunk-0002.json", geometry_count: 1 }
    ]
  };
  const payloads: Record<string, unknown> = {
    "chunk-0000.json": [{ from_city_id: "a", to_city_id: "b", points: [] }],
    "chunk-0001.json": [{ from_city_id: "c", to_city_id: "d", points: [] }],
    "chunk-0002.json": [{ from_city_id: "e", to_city_id: "f", points: [] }]
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

test("fetchEdgeGeometryArtifact streams onChunk in resolution order", async () => {
  // chunk-0002 resolves first, then 0001, then 0000 — the reverse of the
  // manifest. onChunk must see loadedCount 1,2,3 paired with that landing
  // order, while the combined result still carries all three geometries.
  const emitted: EdgeGeometryChunkResult[] = [];
  const result = await fetchEdgeGeometryArtifact(
    streamingDeps({ "chunk-0000.json": 30, "chunk-0001.json": 20, "chunk-0002.json": 10 }),
    {
      onChunk: (chunk) => {
        emitted.push(chunk);
      }
    }
  );

  assert.deepEqual(
    emitted.map((c) => c.chunkFile),
    ["chunk-0002.json", "chunk-0001.json", "chunk-0000.json"]
  );
  assert.deepEqual(emitted.map((c) => c.loadedCount), [1, 2, 3]);
  assert.deepEqual(emitted.map((c) => c.totalCount), [3, 3, 3]);
  // Each emit carries only its own chunk's geometry, in isolation.
  assert.equal(emitted[0]!.geometries.geometries.length, 1);
  // The combined return value is unaffected by streaming.
  assert.equal(result.geometries.geometries.length, 3);
  assert.deepEqual(result.loadedChunkFiles, [
    "chunk-0000.json",
    "chunk-0001.json",
    "chunk-0002.json"
  ]);
});

test("fetchEdgeGeometryArtifact serializes onChunk even when applies are async", async () => {
  // A slow apply on the first-landing chunk must not be lapped by a faster
  // later one — the chain awaits each apply before starting the next.
  const order: string[] = [];
  await fetchEdgeGeometryArtifact(
    streamingDeps({ "chunk-0000.json": 10, "chunk-0001.json": 20, "chunk-0002.json": 30 }),
    {
      onChunk: async (chunk) => {
        order.push(`start:${chunk.chunkFile}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        order.push(`end:${chunk.chunkFile}`);
      }
    }
  );

  // Strictly interleaved start/end pairs prove no two applies overlapped.
  assert.deepEqual(order, [
    "start:chunk-0000.json",
    "end:chunk-0000.json",
    "start:chunk-0001.json",
    "end:chunk-0001.json",
    "start:chunk-0002.json",
    "end:chunk-0002.json"
  ]);
});
