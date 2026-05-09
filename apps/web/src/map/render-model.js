const DEFAULT_HIT_GRID_CELL_SIZE = 48;

export function buildLodProfile(zoom, labelThreshold) {
  return {
    cityPadding: Math.round(interpolateByZoom(zoom, [
      [3, 28],
      [5, 30],
      [7, 34],
      [10, 42]
    ])),
    cityBudget: Math.round(interpolateByZoom(zoom, [
      [3, 450],
      [4, 900],
      [5, 1800],
      [6, 3200],
      [7.5, 5600],
      [9, 9600],
      [10, 18_000]
    ])),
    labelBudget: Math.round(interpolateByZoom(zoom, [
      [3, 20],
      [4.5, 28],
      [6, 38],
      [7.5, 52],
      [9, 68],
      [10, 84]
    ])),
    labelThreshold: interpolateLabelThreshold(zoom, labelThreshold),
    minInterest: interpolateByZoom(zoom, [
      [3, 6.5],
      [4.5, 5.8],
      [6, 4.8],
      [7.5, 3.5],
      [9, 2],
      [10, 1]
    ]),
    minPopulation: Math.round(interpolateByZoom(zoom, [
      [3, 180_000],
      [4.5, 120_000],
      [6, 70_000],
      [7.5, 30_000],
      [9, 8_000],
      [10, 0]
    ])),
    networkMinInterest: interpolateByZoom(zoom, [
      [3, 6],
      [4.5, 5.3],
      [6, 4.5],
      [7.5, 3],
      [9, 1.8],
      [10, 1]
    ]),
    networkEdgeBudget: Math.round(interpolateByZoom(zoom, [
      [3, 1200],
      [4, 3200],
      [5, 6800],
      [6, 11_000],
      [7.5, 18_000],
      [9, 30_000],
      [10, 50_000]
    ])),
    networkPadding: Math.round(interpolateByZoom(zoom, [
      [3, 124],
      [5, 136],
      [7, 148],
      [10, 164]
    ]))
  };
}

export function pointInViewport(point, size, padding = 0) {
  return (
    point.x >= -padding &&
    point.y >= -padding &&
    point.x <= size.x + padding &&
    point.y <= size.y + padding
  );
}

export function lineIntersectsViewport(fromPoint, toPoint, size, padding = 0) {
  const minX = -padding;
  const minY = -padding;
  const maxX = size.x + padding;
  const maxY = size.y + padding;

  return !(
    Math.max(fromPoint.x, toPoint.x) < minX ||
    Math.max(fromPoint.y, toPoint.y) < minY ||
    Math.min(fromPoint.x, toPoint.x) > maxX ||
    Math.min(fromPoint.y, toPoint.y) > maxY
  );
}

export function createSpatialGrid(entries, cellSize = DEFAULT_HIT_GRID_CELL_SIZE) {
  const buckets = new Map();

  for (const entry of entries) {
    const cellKey = keyForPoint(entry, cellSize);
    const bucket = buckets.get(cellKey) || [];
    bucket.push(entry);
    buckets.set(cellKey, bucket);
  }

  return {
    buckets,
    cellSize
  };
}

export function hitTestSpatialGrid(grid, point) {
  if (!grid) {
    return null;
  }

  const baseColumn = Math.floor(point.x / grid.cellSize);
  const baseRow = Math.floor(point.y / grid.cellSize);
  let bestHit = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  for (let column = baseColumn - 1; column <= baseColumn + 1; column += 1) {
    for (let row = baseRow - 1; row <= baseRow + 1; row += 1) {
      const bucket = grid.buckets.get(`${column}:${row}`);
      if (!bucket) {
        continue;
      }

      for (const entry of bucket) {
        const dx = point.x - entry.x;
        const dy = point.y - entry.y;
        const distanceSq = dx * dx + dy * dy;
        const hitRadius = Math.max(8, entry.radius + 4);
        if (distanceSq > hitRadius * hitRadius) {
          continue;
        }

        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestHit = entry;
        }
      }
    }
  }

  return bestHit;
}

export function selectLabelCandidates(candidates, budget) {
  const accepted = [];
  const occupied = [];

  for (const candidate of candidates) {
    if (accepted.length >= budget) {
      break;
    }

    const bounds = estimateLabelBounds(candidate);
    if (occupied.some((rect) => rectsIntersect(rect, bounds))) {
      continue;
    }

    occupied.push(bounds);
    accepted.push(candidate);
  }

  return accepted;
}

function estimateLabelBounds(candidate) {
  const fontSize = candidate.className.includes("trip-lbl")
    ? 12
    : candidate.className.includes("top")
      ? 11
      : 10;
  const width = Math.max(20, Math.round(candidate.text.length * fontSize * 0.58) + 4);
  const height = fontSize + 4;

  return {
    bottom: candidate.y + height,
    left: candidate.x,
    right: candidate.x + width,
    top: candidate.y - 2
  };
}

function rectsIntersect(left, right) {
  return !(
    left.right < right.left ||
    left.left > right.right ||
    left.bottom < right.top ||
    left.top > right.bottom
  );
}

function keyForPoint(point, cellSize) {
  return `${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`;
}

function interpolateLabelThreshold(zoom, labelThreshold) {
  const floorZoom = Math.floor(zoom);
  const ceilZoom = Math.ceil(zoom);
  const floorValue = labelThreshold(floorZoom);
  const ceilValue = labelThreshold(ceilZoom);
  const progress = zoom - floorZoom;

  return {
    interest: lerp(floorValue.interest, ceilValue.interest, progress),
    pop: Math.round(lerp(floorValue.pop, ceilValue.pop, progress))
  };
}

function interpolateByZoom(zoom, points) {
  if (zoom <= points[0][0]) {
    return points[0][1];
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (zoom > current[0]) {
      continue;
    }

    const progress = (zoom - previous[0]) / (current[0] - previous[0]);
    return lerp(previous[1], current[1], progress);
  }

  return points[points.length - 1][1];
}

function lerp(from, to, progress) {
  return from + (to - from) * progress;
}
