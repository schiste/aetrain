import type { GeoPoint } from "../types/planner-dataset.ts";

export type LandmassRing = GeoPoint[];
export type LandmassPolygon = LandmassRing[];

export interface RawBorderRecord {
  n?: string;
  t?: "P" | "M";
  c?: unknown;
}

export function buildLandmassPolygons(
  borderData: readonly RawBorderRecord[] | null | undefined
): LandmassPolygon[] {
  const polygons: LandmassPolygon[] = [];

  for (const record of borderData || []) {
    if (record?.t === "P") {
      polygons.push(normalizePolygon(record.c));
      continue;
    }

    if (record?.t === "M") {
      const multi = Array.isArray(record.c) ? (record.c as unknown[]) : [];
      for (const polygon of multi) {
        polygons.push(normalizePolygon(polygon));
      }
    }
  }

  return polygons.filter((polygon) => polygon.length > 0);
}

function normalizePolygon(rawPolygon: unknown): LandmassPolygon {
  const rings = Array.isArray(rawPolygon) ? (rawPolygon as unknown[]) : [];
  return rings
    .map((ring) => normalizeRing(ring))
    .filter((ring): ring is LandmassRing => ring.length >= 3);
}

function normalizeRing(ring: unknown): LandmassRing {
  if (!Array.isArray(ring)) {
    return [];
  }
  const points: GeoPoint[] = [];
  for (const entry of ring) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const lon = entry[0];
      const lat = entry[1];
      if (typeof lon === "number" && typeof lat === "number") {
        points.push({ lat, lon });
      }
    }
  }
  return points;
}
