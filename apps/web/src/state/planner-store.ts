import { createDiagnostics } from "../app-shell/diagnostics.ts";
import type { PlannerCity } from "../types/planner-dataset.ts";
import type {
  PlannerEngine,
  PlannerReachableDistances,
  PlannerSegment,
  PlannerSuggestion
} from "../types/planner-engine.ts";

const DEFAULT_MAX_LEG_MINUTES = 1440;
const diagnostics = createDiagnostics("web/state/planner-store");

export interface PlannerState {
  distFromLast: PlannerReachableDistances;
  filterInterest: number;
  filterPop: number;
  /**
   * False until the user explicitly touches the population slider /
   * inline edit. While false, the shell auto-adjusts filterPop based
   * on the map zoom level (see auto-pop-scale.ts). The Reset button
   * flips it back to false and re-derives from the current zoom.
   */
  popFilterManual: boolean;
  legDynMax: number;
  legMax: number;
  legMin: number;
  searchQuery: string;
  searchResults: PlannerCity[];
  segments: (PlannerSegment | null)[];
  suggestions: PlannerSuggestion[];
  trip: string[];
}

export interface PlannerStoreSnapshot {
  trip?: string[];
  filterInterest?: number | string;
  filterPop?: number | string;
  /**
   * When omitted from the snapshot we treat the pop filter as
   * "auto" — sharing a link with someone shouldn't pin them to a
   * specific population threshold unless the sender explicitly chose
   * one. The URL-state codec only serializes this when true.
   */
  popFilterManual?: boolean;
  legMin?: number | string;
  legMax?: number | string;
  searchQuery?: string;
  mapView?: { zoom: number; lat: number; lon: number } | null;
}

export type PlannerStateListener = (state: PlannerState) => void;
export type PlannerStatusListener = (text: string) => void;

export interface PlannerStoreOptions {
  cities: PlannerCity[];
  planner: PlannerEngine;
  onStateChange?: PlannerStateListener;
  onStatusChange?: PlannerStatusListener;
}

export interface PlannerStore {
  getState(): PlannerState;
  subscribe(listener: PlannerStateListener): () => void;
  initialize(): void;
  restoreState(snapshot: PlannerStoreSnapshot | null | undefined): Promise<void>;
  toggleCity(name: string): Promise<boolean>;
  removeStop(index: number): Promise<boolean>;
  addStopAfter(index: number, name: string): Promise<boolean>;
  /**
   * Insert a city at an arbitrary index. Used by both the
   * insert-between-stops UX (click a route segment) and the undo
   * affordance after a removal — both want surgical control over the
   * insertion index rather than the "always last+1" semantics of
   * addStopAfter.
   */
  insertStop(index: number, name: string): Promise<boolean>;
  reorderTrip(fromIndex: number, toIndex: number): Promise<boolean>;
  clearTrip(): Promise<boolean>;
  setSearchQuery(value: string): Promise<boolean>;
  setFilterInterest(value: number | string): void;
  setFilterPop(value: number | string): void;
  /**
   * Auto-mode write: updates filterPop without flipping popFilterManual,
   * so the user's "auto" intent is preserved across view-change events.
   * No-op when popFilterManual is already true.
   */
  setAutoFilterPop(value: number | string): void;
  /** Restore "auto" mode for the pop filter and re-emit state. */
  clearManualFilterPop(): void;
  setLegRange(args: { min: number | string; max: number | string }): void;
  /**
   * Re-run the derive pipeline for the current trip without otherwise
   * mutating state. Used by the deferred-geometry hot upgrade so the
   * current trip picks up curved geometry without the user touching
   * anything. Bumps deriveVersion so any in-flight derive is discarded.
   */
  refreshDerivedState(): Promise<boolean>;
}

export function createPlannerStore({
  cities,
  planner,
  onStateChange,
  onStatusChange
}: PlannerStoreOptions): PlannerStore {
  const state: PlannerState = {
    distFromLast: {},
    filterInterest: 5,
    filterPop: 100,
    popFilterManual: false,
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
  const listeners = new Set<PlannerStateListener>();
  diagnostics.info("created planner store", {
    city_count: cities.length
  });

  function emitStateChange(): void {
    diagnostics.debug("emitting planner state change", summarizePlannerState(state));
    onStateChange?.(state);
    for (const listener of listeners) {
      listener(state);
    }
  }

  function emitStatus(text: string): void {
    onStatusChange?.(text);
  }

  function recomputeLegBounds(): void {
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

  async function refreshDerivedTripState(version: number): Promise<boolean> {
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

  async function syncTripState(): Promise<boolean> {
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

  async function syncSearchState(): Promise<boolean> {
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

  function mutateTrip(mutator: (trip: string[]) => void): Promise<boolean> {
    const beforeTrip = [...state.trip];
    mutator(state.trip);
    diagnostics.info("mutated trip", {
      before_trip: beforeTrip,
      after_trip: [...state.trip]
    });
    return syncTripState();
  }

  return {
    getState(): PlannerState {
      return state;
    },
    subscribe(listener: PlannerStateListener): () => void {
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
    initialize(): void {
      diagnostics.info("initializing planner store");
      recomputeLegBounds();
      emitStateChange();
    },
    async restoreState(snapshot: PlannerStoreSnapshot | null | undefined): Promise<void> {
      diagnostics.info("restoring planner store from snapshot", {
        snapshot
      });
      const nextTrip = Array.isArray(snapshot?.trip)
        ? snapshot.trip.filter((name) => cities.some((city) => city.name === name))
        : [];

      state.trip.splice(0, state.trip.length, ...nextTrip);
      state.filterInterest = clampInteger(snapshot?.filterInterest, 1, 10);
      state.filterPop = clampInteger(snapshot?.filterPop, 0, 1000);
      // Treat the pop filter as "auto" unless the sender of the snapshot
      // explicitly marked it manual. See the popFilterManual JSDoc.
      state.popFilterManual = snapshot?.popFilterManual === true;
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
    toggleCity(name: string): Promise<boolean> {
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
    removeStop(index: number): Promise<boolean> {
      return mutateTrip((trip) => {
        trip.splice(index, 1);
      });
    },
    addStopAfter(index: number, name: string): Promise<boolean> {
      return mutateTrip((trip) => {
        trip.splice(index + 1, 0, name);
      });
    },
    insertStop(index: number, name: string): Promise<boolean> {
      return mutateTrip((trip) => {
        // Clamp out-of-bounds requests to the nearest valid insertion
        // index rather than rejecting them. Undo restores at the
        // original index, but the trip may have shrunk if other stops
        // were removed during the 5s window — clamping keeps the
        // operation idempotent rather than throwing.
        const clamped = Math.max(0, Math.min(index, trip.length));
        trip.splice(clamped, 0, name);
      });
    },
    reorderTrip(fromIndex: number, toIndex: number): Promise<boolean> {
      return mutateTrip((trip) => {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || fromIndex >= trip.length) return;
        if (toIndex < 0 || toIndex > trip.length) return;
        const moved = trip.splice(fromIndex, 1)[0];
        if (moved === undefined) return;
        // Adjust the target index if we removed an item before it.
        const target = toIndex > fromIndex ? toIndex - 1 : toIndex;
        trip.splice(target, 0, moved);
      });
    },
    clearTrip(): Promise<boolean> {
      return mutateTrip((trip) => {
        trip.splice(0, trip.length);
      });
    },
    setSearchQuery(value: string): Promise<boolean> {
      state.searchQuery = String(value || "");
      diagnostics.debug("updated search query", {
        query: state.searchQuery
      });
      return syncSearchState();
    },
    setFilterInterest(value: number | string): void {
      state.filterInterest = clampInteger(value, 1, 10);
      diagnostics.debug("updated interest filter", {
        filter_interest: state.filterInterest
      });
      emitStateChange();
    },
    setFilterPop(value: number | string): void {
      const previous = state.filterPop;
      state.filterPop = clampInteger(value, 0, 1000);
      // Any explicit setFilterPop call is a manual override — slider
      // drag, inline edit, or restoring a manual-mode snapshot. Even
      // if the resulting value matches what auto would produce, the
      // user has expressed intent.
      const flipped = !state.popFilterManual;
      state.popFilterManual = true;
      diagnostics.debug("updated population filter (manual)", {
        filter_pop: state.filterPop,
        previous,
        flipped_to_manual: flipped
      });
      emitStateChange();
    },
    setAutoFilterPop(value: number | string): void {
      // Honour the user's manual override — auto writes are ignored
      // once popFilterManual is true. This keeps the per-frame
      // view-change listener cheap (no setState churn) and prevents
      // accidental zoom-driven nudges from undoing a slider drag.
      if (state.popFilterManual) {
        return;
      }
      const next = clampInteger(value, 0, 1000);
      if (next === state.filterPop) {
        return;
      }
      state.filterPop = next;
      diagnostics.debug("updated population filter (auto)", {
        filter_pop: state.filterPop
      });
      emitStateChange();
    },
    clearManualFilterPop(): void {
      if (!state.popFilterManual) return;
      state.popFilterManual = false;
      diagnostics.debug("restored auto-mode population filter");
      emitStateChange();
    },
    async refreshDerivedState(): Promise<boolean> {
      diagnostics.info("refreshing derived state", {
        trip_length: state.trip.length
      });
      return syncTripState();
    },
    setLegRange({ min, max }: { min: number | string; max: number | string }): void {
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

function clampLegRange(state: PlannerState): void {
  state.legMin = Math.min(state.legMin, state.legDynMax);
  if (state.legMax >= state.legDynMax || state.legMax >= DEFAULT_MAX_LEG_MINUTES) {
    state.legMax = state.legDynMax;
  }
  if (state.legMax < state.legMin) {
    state.legMax = state.legMin;
  }
}

function clampInteger(
  value: number | string | undefined | null,
  min: number,
  max: number
): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) {
    return min;
  }

  return Math.max(min, Math.min(max, parsed));
}

function summarizePlannerState(state: PlannerState): Record<string, unknown> {
  return {
    trip: [...state.trip],
    trip_length: state.trip.length,
    filter_interest: state.filterInterest,
    filter_pop: state.filterPop,
    pop_filter_manual: state.popFilterManual,
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
