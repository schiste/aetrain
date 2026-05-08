import { createDiagnostics } from "../app-shell/diagnostics.js";

const URL_STATE_VERSION = "v1";
const STORE_COMMIT_DELAY_MS = 50;
const VIEW_COMMIT_DELAY_MS = 180;
const diagnostics = createDiagnostics("web/state/planner-url-state");

export function parsePlannerUrlHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) {
    diagnostics.debug("url hash empty, nothing to hydrate");
    return null;
  }

  const parts = raw.split(";");
  if (parts[0] !== URL_STATE_VERSION) {
    diagnostics.warn("ignored unsupported planner url hash version", {
      hash,
      version: parts[0]
    });
    return null;
  }

  const state = {
    trip: [],
    filterInterest: 5,
    filterPop: 100,
    legMin: 0,
    legMax: 1440,
    searchQuery: "",
    mapView: null
  };

  for (const part of parts.slice(1)) {
    if (!part) {
      continue;
    }

    const [key, value = ""] = part.split("=");
    switch (key) {
      case "t":
        state.trip = value
          ? value.split(",").map((token) => decodeComponent(token)).filter(Boolean)
          : [];
        break;
      case "fi":
        state.filterInterest = parseInteger(value, state.filterInterest);
        break;
      case "fp":
        state.filterPop = parseInteger(value, state.filterPop);
        break;
      case "ll": {
        const [min = "", max = ""] = value.split("-");
        state.legMin = parseInteger(min, state.legMin);
        state.legMax = parseInteger(max, state.legMax);
        break;
      }
      case "ui.q":
        state.searchQuery = decodeComponent(value);
        break;
      case "ui.map":
        state.mapView = parseMapView(value);
        break;
      default:
        break;
    }
  }

  diagnostics.info("parsed planner url hash", state);
  return state;
}

export function writePlannerUrlHash({ plannerState, mapView }) {
  const segments = [URL_STATE_VERSION];
  segments.push(
    `t=${plannerState.trip.map((name) => encodeComponent(name)).join(",")}`
  );
  segments.push(`fi=${plannerState.filterInterest}`);
  segments.push(`fp=${plannerState.filterPop}`);
  segments.push(`ll=${plannerState.legMin}-${plannerState.legMax}`);

  if (plannerState.searchQuery?.trim()) {
    segments.push(`ui.q=${encodeComponent(plannerState.searchQuery.trim())}`);
  }

  if (mapView) {
    segments.push(
      `ui.map=${encodeComponent(
        `${mapView.zoom.toFixed(3)}/${mapView.lat.toFixed(4)}/${mapView.lon.toFixed(4)}`
      )}`
    );
  }

  return `#${segments.join(";")}`;
}

export function bindPlannerUrlState({ plannerStore, mapSurface }) {
  let muted = false;
  let scheduledCommitTimer = 0;
  diagnostics.info("bound planner url state");

  function commit(reason) {
    if (muted) {
      diagnostics.debug("skipped url commit while muted");
      return;
    }

    const nextHash = writePlannerUrlHash({
      plannerState: plannerStore.getState(),
      mapView: mapSurface.getViewState()
    });
    const url = new URL(window.location.href);
    if (url.hash === nextHash) {
      diagnostics.debug("skipped url commit because hash is unchanged", {
        hash: nextHash
      });
      return;
    }

    url.hash = nextHash;
    diagnostics.info("committing planner url hash", {
      hash: nextHash,
      reason
    });
    window.history.replaceState(null, "", url.toString());
  }

  function scheduleCommit(reason, delayMs) {
    if (muted) {
      diagnostics.debug("skipped scheduling url commit while muted", {
        reason
      });
      return;
    }

    window.clearTimeout(scheduledCommitTimer);
    diagnostics.debug("scheduled planner url commit", {
      delay_ms: delayMs,
      reason
    });
    scheduledCommitTimer = window.setTimeout(() => {
      scheduledCommitTimer = 0;
      commit(reason);
    }, delayMs);
  }

  return {
    async hydrate() {
      const parsed = parsePlannerUrlHash(window.location.hash);
      if (!parsed) {
        diagnostics.debug("planner url hydrate skipped");
        return;
      }

      muted = true;
      try {
        diagnostics.info("hydrating planner state from url", parsed);
        await plannerStore.restoreState(parsed);
        if (parsed.mapView) {
          mapSurface.setViewState(parsed.mapView);
        }
      } finally {
        muted = false;
      }

      commit("hydrate");
    },
    start() {
      diagnostics.info("starting planner url synchronization");
      const unsubscribeStore = plannerStore.subscribe(() => {
        scheduleCommit("planner-store", STORE_COMMIT_DELAY_MS);
      });
      const unsubscribeMap = mapSurface.subscribeViewChange(() => {
        scheduleCommit("map-view", VIEW_COMMIT_DELAY_MS);
      });

      return () => {
        diagnostics.info("stopping planner url synchronization");
        window.clearTimeout(scheduledCommitTimer);
        unsubscribeStore();
        unsubscribeMap();
      };
    }
  };
}

function parseMapView(value) {
  const decoded = decodeComponent(value);
  const [zoomRaw = "", latRaw = "", lonRaw = ""] = decoded.split("/");
  const zoom = Number.parseFloat(zoomRaw);
  const lat = Number.parseFloat(latRaw);
  const lon = Number.parseFloat(lonRaw);
  if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return { zoom, lat, lon };
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function encodeComponent(value) {
  return encodeURIComponent(String(value || ""))
    .replaceAll("%3A", ":")
    .replaceAll("%7E", "~");
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
