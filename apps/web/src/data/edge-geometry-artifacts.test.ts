import test from "node:test";
import assert from "node:assert/strict";

import { combineChunkedEdgeGeometryArtifact } from "./edge-geometry-artifacts.ts";

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
  assert.equal(artifact.geometries[2].to_city_id, "lille-fr");
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
