const MAX_MERCATOR_LAT = 85.05112878;
const MIN_WORLD = 0;
const MAX_WORLD = 1;
const WORLD_SIZE = 256;

export function mercatorProject(lon, lat) {
  const clampedLat = clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
  const normalizedLon = clamp(lon, -180, 180);
  const latitudeRadians = (clampedLat * Math.PI) / 180;
  const x = (normalizedLon + 180) / 360;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) / (2 * Math.PI);

  return {
    x: clamp(x, MIN_WORLD, MAX_WORLD),
    y: clamp(y, MIN_WORLD, MAX_WORLD)
  };
}

export function mercatorUnproject(worldX, worldY) {
  const clampedX = clamp(worldX, MIN_WORLD, MAX_WORLD);
  const clampedY = clamp(worldY, MIN_WORLD, MAX_WORLD);
  const lon = clampedX * 360 - 180;
  const latRadians = Math.atan(Math.sinh(Math.PI * (1 - 2 * clampedY)));
  return {
    lat: (latRadians * 180) / Math.PI,
    lon
  };
}

export function scaleForZoom(zoom) {
  return WORLD_SIZE * 2 ** zoom;
}

export function projectWorldToScreen(worldPoint, camera, size) {
  const centerWorld = mercatorProject(camera.lon, camera.lat);
  const scale = scaleForZoom(camera.zoom);

  return {
    x: (worldPoint.x - centerWorld.x) * scale + size.x / 2,
    y: (worldPoint.y - centerWorld.y) * scale + size.y / 2
  };
}

export function panCameraByPixels(camera, dx, dy) {
  const centerWorld = mercatorProject(camera.lon, camera.lat);
  const scale = scaleForZoom(camera.zoom);
  const nextCenterWorld = {
    x: clamp(centerWorld.x - dx / scale, MIN_WORLD, MAX_WORLD),
    y: clamp(centerWorld.y - dy / scale, MIN_WORLD, MAX_WORLD)
  };
  const nextCenter = mercatorUnproject(nextCenterWorld.x, nextCenterWorld.y);

  return {
    lat: nextCenter.lat,
    lon: nextCenter.lon,
    zoom: camera.zoom
  };
}

export function zoomCameraAroundPoint(camera, size, anchorPoint, nextZoom) {
  const centerWorld = mercatorProject(camera.lon, camera.lat);
  const currentScale = scaleForZoom(camera.zoom);
  const nextScale = scaleForZoom(nextZoom);
  const anchorWorld = {
    x: centerWorld.x + (anchorPoint.x - size.x / 2) / currentScale,
    y: centerWorld.y + (anchorPoint.y - size.y / 2) / currentScale
  };
  const nextCenterWorld = {
    x: clamp(anchorWorld.x - (anchorPoint.x - size.x / 2) / nextScale, MIN_WORLD, MAX_WORLD),
    y: clamp(anchorWorld.y - (anchorPoint.y - size.y / 2) / nextScale, MIN_WORLD, MAX_WORLD)
  };
  const nextCenter = mercatorUnproject(nextCenterWorld.x, nextCenterWorld.y);

  return {
    lat: nextCenter.lat,
    lon: nextCenter.lon,
    zoom: nextZoom
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
