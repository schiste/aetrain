import test from "node:test";
import assert from "node:assert/strict";

import { borderData } from "../legacy/landmass.ts";
import { buildLandmassPolygons } from "./landmass-model.ts";

test("buildLandmassPolygons normalizes polygon and multipolygon inputs", () => {
  const polygons = buildLandmassPolygons([
    {
      t: "P",
      c: [[[1, 2], [3, 4], [5, 6]]]
    },
    {
      t: "M",
      c: [
        [[[7, 8], [9, 10], [11, 12]]],
        [[[13, 14], [15, 16], [17, 18]]]
      ]
    }
  ]);

  assert.equal(polygons.length, 3);
  assert.deepEqual(polygons[0][0][0], { lat: 2, lon: 1 });
  assert.deepEqual(polygons[2][0][2], { lat: 18, lon: 17 });
});

test("buildLandmassPolygons produces drawable polygons for the bundled landmass dataset", () => {
  const polygons = buildLandmassPolygons(borderData);

  assert.equal(polygons.length > 0, true);
  assert.equal(polygons[0].length > 0, true);
  assert.equal(polygons[0][0].length >= 3, true);
  assert.equal(typeof polygons[0][0][0].lat, "number");
  assert.equal(typeof polygons[0][0][0].lon, "number");
});
