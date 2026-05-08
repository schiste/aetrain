export function buildLandmassPolygons(borderData) {
  const polygons = [];

  for (const record of borderData || []) {
    if (record?.t === "P") {
      polygons.push(normalizePolygon(record.c));
      continue;
    }

    if (record?.t === "M") {
      for (const polygon of record.c || []) {
        polygons.push(normalizePolygon(polygon));
      }
    }
  }

  return polygons.filter((polygon) => polygon.length > 0);
}

function normalizePolygon(rawPolygon) {
  return (rawPolygon || [])
    .map((ring) =>
      (ring || []).map(([lon, lat]) => ({
        lat,
        lon
      }))
    )
    .filter((ring) => ring.length >= 3);
}
