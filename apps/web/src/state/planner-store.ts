import { createDiagnostics } from "../app-shell/diagnostics.ts";

const DEFAULT_MAX_LEG_MINUTES = 1440;
const diagnostics = createDiagnostics("web/state/planner-store");

export function createPlannerStore({ cities, planner, onStateChange, onStatusChange }) {
  const state = {
    distFromLast: {},
    filterInterest: 5,
    filterPop: 100,
    legDynMax: DEFAULT_MAX_LEG_MINUTES,
    legMax: DEFAULT_MAX_LEG_MINUTES,
    legMin: 0,
    searchQuery: "",
    searchResults: [],
    segments: [],
    suggestions: [],
    trip: []
  };

  let deriveVersion = 0;
  let searchVersion = 0;
  const listeners = new Set();
  diagnostics.info("created planner store", {
    city_count: cities.length
  });

  function emitStateChange() {
    diagnostics.debug("emitting planner state change", summarizePlannerState(state));
    onStateChange?.(state);
    for (const listener of listeners) {
      listener(state);
    }
  }

  function emitStatus(text) {
    onStatusChange?.(text);
  }

  function recomputeLegBounds() {
    if (state.trip.length < 1) {
      state.legDynMax = DEFAULT_MAX_LEG_MINUTES;
      clampLegRange(state);
      diagnostics.debug("reset leg bounds to defaults", {
        leg_dyn_max: state.legDynMax
      });
      return;
    }

    let maxTime = 0;
    for (const city of cities) {
      const travelTime = state.distFromLast[city.name];
      if (travelTime !== undefined && travelTime !== Infinity && travelTime > maxTime) {
        maxTime = travelTime;
      }
    }

    state.legDynMax = Math.max(60, Math.ceil(maxTime / 60) * 60);
    clampLegRange(state);
    diagnostics.debug("recomputed leg bounds", {
      leg_dyn_max: state.legDynMax,
      max_time: maxTime
    });
  }

  async function refreshDerivedTripState(version) {
    if (state.trip.length === 0) {
      state.distFromLast = {};
      state.segments = [];
      state.suggestions = [];
      diagnostics.debug("cleared derived trip state for empty trip", {
        derive_version: version
      });
      return true;
    }

    emitStatus("Updating trip…");
    diagnostics.debug("requesting derived trip state", {
      derive_version: version,
      trip: [...state.trip]
    });
    const derived = await planner.deriveTripPlan({ trip: [...state.trip] });
    if (deriveVersion !== version) {
      diagnostics.warn("discarded stale derived trip state", {
        requested_version: version,
        current_version: deriveVersion
      });
      return false;
    }

    state.distFromLast = derived.distFromLast;
    state.segments = derived.segments;
    state.suggestions = derived.suggestions;
    diagnostics.info("updated derived trip state", {
      derive_version: version,
      segment_count: state.segments.length,
      suggestion_count: state.suggestions.length,
      reachable_count: Object.keys(state.distFromLast || {}).length
    });
    return true;
  }

  async function syncTripState() {
    const version = deriveVersion + 1;
    deriveVersion = version;

    const applied = await refreshDerivedTripState(version);
    if (!applied) {
      return false;
    }

    recomputeLegBounds();
    emitStateChange();
    return true;
  }

  async function syncSearchState() {
    const query = String(state.searchQuery || "").trim();
    const version = searchVersion + 1;
    searchVersion = version;
    diagnostics.debug("syncing search state", {
      search_version: version,
      query
    });

    if (query.length < 1) {
      state.searchResults = [];
      diagnostics.debug("cleared search results for empty query", {
        search_version: version
      });
      emitStateChange();
      return true;
    }

    const results = await planner.searchCities({
      query,
      limit: 14
    });
    if (searchVersion !== version) {
      diagnostics.warn("discarded stale search results", {
        requested_version: version,
        current_version: searchVersion,
        query
      });
      return false;
    }

    state.searchResults = results;
    diagnostics.info("updated search results", {
      search_version: version,
      query,
      result_count: results.length
    });
    emitStateChange();
    return true;
  }

  function mutateTrip(mutator) {
    const beforeTrip = [...state.trip];
    mutator(state.trip);
    diagnostics.info("mutated trip", {
      before_trip: beforeTrip,
      after_trip: [...state.trip]
    });
    return syncTripState();
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      diagnostics.debug("subscribed planner store listener", {
        listener_count_before: listeners.size
      });
      listeners.add(listener);
      return () => {
        diagnostics.debug("unsubscribed planner store listener", {
          listener_count_before: listeners.size
        });
        listeners.delete(listener);
      };
    },
    initialize() {
      diagnostics.info("initializing planner store");
      recomputeLegBounds();
      emitStateChange();
    },
    async restoreState(snapshot) {
      diagnostics.info("restoring planner store from snapshot", {
        snapshot
      });
      const nextTrip = Array.isArray(snapshot?.trip)
        ? snapshot.trip.filter((name) => cities.some((city) => city.name === name))
        : [];

      state.trip.splice(0, state.trip.length, ...nextTrip);
      state.filterInterest = clampInteger(snapshot?.filterInterest, 1, 10);
      state.filterPop = clampInteger(snapshot?.filterPop, 0, 1000);
      state.searchQuery = String(snapshot?.searchQuery || "");

      await syncTripState();

      if (snapshot?.legMin !== undefined || snapshot?.legMax !== undefined) {
        state.legMin = clampInteger(snapshot?.legMin, 0, state.legDynMax);
        state.legMax = clampInteger(snapshot?.legMax, 0, state.legDynMax);
        if (state.legMin > state.legMax) {
          [state.legMin, state.legMax] = [state.legMax, state.legMin];
        }
      }

      if (state.searchQuery.trim().length > 0) {
        await syncSearchState();
        return;
      }

      emitStateChange();
    },
    toggleCity(name) {
      return mutateTrip((trip) => {
        const existingIndex = trip.indexOf(name);
        if (existingIndex === 0 && trip.length >= 2) {
          if (trip[trip.length - 1] === name) {
            trip.pop();
          } else {
            trip.push(name);
          }
          return;
        }

        if (existingIndex >= 0) {
          trip.splice(existingIndex, 1);
          return;
        }

        trip.push(name);
      });
    },
    removeStop(index) {
      return mutateTrip((trip) => {
        trip.splice(index, 1);
      });
    },
    addStopAfter(index, name) {
      return mutateTrip((trip) => {
        trip.splice(index + 1, 0, name);
      });
    },
    clearTrip() {
      return mutateTrip((trip) => {
        trip.splice(0, trip.length);
      });
    },
    setSearchQuery(value) {
      state.searchQuery = String(value || "");
      diagnostics.debug("updated search query", {
        query: state.searchQuery
      });
      return syncSearchState();
    },
    setFilterInterest(value) {
      state.filterInterest = clampInteger(value, 1, 10);
      diagnostics.debug("updated interest filter", {
        filter_interest: state.filterInterest
      });
      emitStateChange();
    },
    setFilterPop(value) {
      state.filterPop = clampInteger(value, 0, 1000);
      diagnostics.debug("updated population filter", {
        filter_pop: state.filterPop
      });
      emitStateChange();
    },
    setLegRange({ min, max }) {
      state.legMin = clampInteger(min, 0, state.legDynMax);
      state.legMax = clampInteger(max, 0, state.legDynMax);
      if (state.legMin > state.legMax) {
        [state.legMin, state.legMax] = [state.legMax, state.legMin];
      }
      diagnostics.debug("updated leg range", {
        leg_min: state.legMin,
        leg_max: state.legMax,
        leg_dyn_max: state.legDynMax
      });
      emitStateChange();
    }
  };
}

function clampLegRange(state) {
  state.legMin = Math.min(state.legMin, state.legDynMax);
  if (state.legMax >= state.legDynMax || state.legMax >= DEFAULT_MAX_LEG_MINUTES) {
    state.legMax = state.legDynMax;
  }
  if (state.legMax < state.legMin) {
    state.legMax = state.legMin;
  }
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return min;
  }

  return Math.max(min, Math.min(max, parsed));
}

function summarizePlannerState(state) {
  return {
    trip: [...state.trip],
    trip_length: state.trip.length,
    filter_interest: state.filterInterest,
    filter_pop: state.filterPop,
    leg_min: state.legMin,
    leg_max: state.legMax,
    leg_dyn_max: state.legDynMax,
    search_query: state.searchQuery,
    search_result_count: state.searchResults.length,
    segment_count: state.segments.length,
    suggestion_count: state.suggestions.length,
    reachable_count: Object.keys(state.distFromLast || {}).length
  };
}
