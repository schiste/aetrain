# Bug report: edge-geometry chunks need per-chunk bounding boxes

**Filed by:** frontend
**Affects:** production runtime artifact `edge-geometries.manifest.json`
**Severity:** perf — blocker for viewport-streamed geometry loading
**Frontend tracking:** stub already shipped, gated on bbox presence (see below)

## Problem

The frontend wants to stream edge-geometry chunks **only when their region
becomes visible on the map**. Today's manifest (excerpt) gives us no way to
decide which chunks contain which regions:

```json
{
  "version": 1,
  "total_geometry_count": 39628,
  "chunk_target_bytes": 20971520,
  "chunks": [
    { "file": "edge-geometries/chunk-0000.json", "geometry_count": 15587 },
    { "file": "edge-geometries/chunk-0001.json", "geometry_count": 11168 },
    { "file": "edge-geometries/chunk-0002.json", "geometry_count": 10661 },
    { "file": "edge-geometries/chunk-0003.json", "geometry_count":  2212 }
  ]
}
```

`file` + `geometry_count` only. No spatial metadata.

The chunks themselves are split for size targeting (~20 MB each), not for
geographic clustering — so we can't even use chunk index as a heuristic for
"this chunk covers Iberia" or similar.

We could derive bboxes client-side by joining each geometry's
`from_city_id`/`to_city_id` to `cities.json` lat/lon, but that requires
fetching at least one chunk to inspect it — defeating the purpose.

## What we need

Add a `bbox` field per chunk entry:

```json
{
  "file": "edge-geometries/chunk-0000.json",
  "geometry_count": 15587,
  "bbox": { "west": -10.5, "south": 36.0, "east": 12.3, "north": 60.1 }
}
```

`bbox` is the bounding box of ALL geometries in the chunk, in WGS84 degrees.

That's enough for the frontend to:
- On boot, fetch only the chunk(s) overlapping the initial viewport
  (Europe overview by default → may still be all of them, but small
  detail viewports drop to one chunk).
- On pan/zoom, fetch additional chunks the moment they intersect the
  viewport, with caching so each chunk loads at most once.

Estimated savings: users who never pan from the default European overview
download all chunks (no change). Users zoomed into one country download
~25-50% of the chunks. Across all sessions that's ~30-60% bandwidth saved.

## Pipeline change scope

In the chunker that emits `edge-geometries/`:

```rust
// pseudocode
for chunk in chunks {
    let bbox = chunk.geometries.fold(BBox::empty(), |acc, geom| {
        geom.points.fold(acc, |a, p| a.extend(p.lat, p.lon))
    });
    manifest.chunks.push(ChunkEntry { file, geometry_count, bbox });
}
```

A few extra `min`/`max` ops per geometry. No additional data exposed
(coordinates are already public via the chunk file itself).

Optional: a `total_bbox` at the top of the manifest would let the
frontend skip the per-chunk pass when viewport is unrestricted.

## Frontend status

I've shipped the **frontend stub** in commit `<TBD this commit hash>`:

- `EdgeGeometryChunkManifestEntry` type now declares an optional `bbox` field
- `selectVisibleChunks(chunks, viewport)` filters the manifest by viewport
  intersection when bboxes are present
- `loadEdgeGeometries(viewport)` accepts the current map viewport
- Map surface drives re-fetches on view change (debounced)
- A `Set<chunkIndex>` tracks already-fetched chunks to dedupe

**While bboxes are absent the stub falls through to "fetch all chunks"** —
behavior matches today exactly. The moment the manifest grows `bbox`
fields, the streaming activates with no further frontend changes required.

## Reproduction (current behaviour)

```sh
curl http://127.0.0.1:5173/data/production/edge-geometries.manifest.json | jq
# → manifest with no bbox fields → frontend loads all 4 chunks (~10 MB gz)
```

After the backend change, expect:

```sh
curl ... | jq '.chunks[0]'
# → { "file": "...", "geometry_count": 15587, "bbox": { ... } }
# Frontend will then fetch only chunks intersecting the visible map.
```

## Owner request

Pick this up alongside the population/Wikidata enrichment work the
previous bug report flagged (these are the same pipeline area). No
schema versioning needed — `bbox` is additive and the frontend treats
its absence as the "fetch everything" fallback.
