import test from "node:test";
import assert from "node:assert/strict";

import {
  mercatorProject,
  mercatorUnproject,
  panCameraByPixels,
  projectWorldToScreen,
  zoomCameraAroundPoint
} from "./camera-model.js";

test("mercator projection roundtrips representative coordinates", () => {
  const paris = { lat: 48.8566, lon: 2.3522 };
  const world = mercatorProject(paris.lon, paris.lat);
  const restored = mercatorUnproject(world.x, world.y);

  assert.ok(Math.abs(restored.lat - paris.lat) < 0.0001);
  assert.ok(Math.abs(restored.lon - paris.lon) < 0.0001);
});

test("zoomCameraAroundPoint preserves the anchored world point on screen", () => {
  const size = { x: 1200, y: 800 };
  const camera = { lat: 50, lon: 10, zoom: 5 };
  const anchor = { x: 900, y: 240 };
  const cityWorld = mercatorProject(4.8357, 45.764);

  const before = projectWorldToScreen(cityWorld, camera, size);
  const nextCamera = zoomCameraAroundPoint(camera, size, before, 6.5);
  const after = projectWorldToScreen(cityWorld, nextCamera, size);

  assert.ok(Math.abs(after.x - before.x) < 0.001);
  assert.ok(Math.abs(after.y - before.y) < 0.001);
});

test("panCameraByPixels shifts the projected scene by the requested screen delta", () => {
  const size = { x: 1000, y: 700 };
  const camera = { lat: 50, lon: 10, zoom: 5.25 };
  const cityWorld = mercatorProject(2.3522, 48.8566);
  const before = projectWorldToScreen(cityWorld, camera, size);
  const nextCamera = panCameraByPixels(camera, 42, -18);
  const after = projectWorldToScreen(cityWorld, nextCamera, size);

  assert.ok(Math.abs((after.x - before.x) - 42) < 0.01);
  assert.ok(Math.abs((after.y - before.y) + 18) < 0.01);
});
