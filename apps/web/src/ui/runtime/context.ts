// Shared per-app context registry. The shell (`ae-app`) creates an
// AppContext during boot and attaches it via `setAppContext`. Components
// read it inside their render functions through `useAppContextSignal()`,
// which exposes a tracked Signal — so when the shell finishes booting and
// publishes the real context, every dependent component re-renders.
//
// We avoid a custom-element-attribute selector pattern (would require
// every host to define connectedCallback wiring) and a full DI container
// (overkill for a single shell).

import { signal, type Signal } from "./signal.ts";
import type { PlannerStore, PlannerState } from "../../state/planner-store.ts";
import type {
  PlannerModelMetadata,
  PlannerSegment,
  PlannerSuggestion
} from "../../types/planner-engine.ts";
import type { PlannerCity } from "../../types/planner-dataset.ts";

export interface VisibilityStats {
  shown: number;
  total: number;
  reachable: number;
}

export interface AppContext {
  store: PlannerStore;
  state: Signal<PlannerState>;
  graph: PlannerModelMetadata;
  cities: PlannerCity[];
  segmentsOf(state: PlannerState): (PlannerSegment | null)[];
  suggestionsOf(state: PlannerState): PlannerSuggestion[];
  visibility: Signal<VisibilityStats>;
  statusText: Signal<string>;
  // Human-readable description of the loaded dataset (label + version etc.)
  // The legacy POC ↔ Production toggle is gone; this is now read-only.
  datasetMeta: Signal<string>;
  search: {
    isOpen: Signal<boolean>;
    setOpen(open: boolean): void;
    onSelectResult(name: string): void;
    /**
     * When non-null, the next search result will be inserted at this
     * trip index instead of appended/toggled. Set by the trip-list
     * "+ insert between" affordance and the map route-segment click
     * handler; cleared automatically inside onSelectResult and when
     * the search panel closes.
     */
    pendingInsertAt: Signal<number | null>;
    requestInsertAt(index: number): void;
  };
  onShareTrip(): Promise<void>;
  onClearTrip(): void;
  /**
   * Reset map filters to defaults. Lives on the context (not directly
   * on the store) because the pop filter reset has to round-trip the
   * map surface: clear the manual flag, then re-derive the threshold
   * from the current zoom. Only the shell holds both references.
   */
  onResetFilters(): void;
  copyButtonLabel: Signal<string>;
}

const contextSignal = signal<AppContext | null>(null);

export function setAppContext(context: AppContext | null): void {
  contextSignal.set(context);
}

/** Tracking access — components reading this in `render()` will re-render
 *  when the context becomes available (or is replaced). */
export function tryUseAppContext(): AppContext | null {
  return contextSignal();
}

/** Non-tracking access for places (boot wiring, dispose hooks) that
 *  should not subscribe. */
export function peekAppContext(): AppContext | null {
  return contextSignal.peek();
}

export function useAppContext(): AppContext {
  const context = tryUseAppContext();
  if (!context) {
    throw new Error(
      "Aetrain UI context not available — did you mount <ae-app>?"
    );
  }
  return context;
}
