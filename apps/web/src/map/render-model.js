const DEFAULT_HIT_GRID_CELL_SIZE = 48;

export function buildLodProfile(zoom, labelThreshold) {
  const label = labelThreshold(zoom);

  if (zoom <= 4) {
    return {
      cityPadding: 24,
      labelBudget: 16,
      labelThreshold: label,
      minInterest: 7,
      minPopulation: 250_000,
      networkMinInterest: 7,
      networkPadding: 120
    };
  }

  if (zoom <= 5) {
    return {
      cityPadding: 28,
      labelBudget: 24,
      labelThreshold: label,
      minInterest: 6,
      minPopulation: 120_000,
      networkMinInterest: 6,
      networkPadding: 132
    };
  }

  if (zoom <= 7) {
    return {
      cityPadding: 32,
      labelBudget: 40,
      labelThreshold: label,
      minInterest: 4,
      minPopulation: 40_000,
      networkMinInterest: 4,
      networkPadding: 144
    };
  }

  return {
    cityPadding: 40,
    labelBudget: 72,
    labelThreshold: label,
    minInterest: 1,
    minPopulation: 0,
    networkMinInterest: 1,
    networkPadding: 156
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
