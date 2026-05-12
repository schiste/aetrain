// Trip stop list with inline suggestions. Reads trip + suggestions from
// the AppContext; calls store.removeStop / store.addStopAfter on click.

import { createDiagnostics, summarizeError } from "../../app-shell/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";
import { formatMinutes, formatPopulation } from "../runtime/format.ts";
import type { PlannerSuggestion } from "../../types/planner-engine.ts";

const diagnostics = createDiagnostics("web/ui/trip-list");

defineComponent("ae-trip-list", (host) => {
  // Mark the host element as a polite live region so screen readers
  // announce stops being added or removed without stealing focus.
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-relevant", "additions removals");
  host.setAttribute("aria-label", "Trip itinerary");
  // The first render produces children; mark it as ready so CSS can
  // run a one-shot fade-in keyframe on each suggestion as it appears.
  queueMicrotask(() => {
    host.dataset.revealed = "true";
  });

  // Drag-reorder state, kept across renders so the dragstart →
  // dragover → drop sequence survives any reactive re-render that
  // might fire mid-gesture.
  let dragFromIndex: number | null = null;

  function tripStopAt(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const stop = target.closest<HTMLElement>(".ts[data-trip-index]");
    return stop;
  }

  function setDropTarget(stop: HTMLElement | null, position: "before" | "after" | null): void {
    // Clear any previous drop indicator before applying a new one.
    host.querySelectorAll<HTMLElement>(".ts.drag-over-before, .ts.drag-over-after").forEach((node) => {
      node.classList.remove("drag-over-before", "drag-over-after");
    });
    if (!stop || !position) return;
    stop.classList.add(`drag-over-${position}`);
  }

  host.addEventListener("dragstart", (event) => {
    const stop = tripStopAt(event.target);
    if (!stop || !event.dataTransfer) return;
    const indexAttr = stop.dataset.tripIndex;
    if (indexAttr === undefined) return;
    dragFromIndex = Number.parseInt(indexAttr, 10);
    if (!Number.isFinite(dragFromIndex)) {
      dragFromIndex = null;
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    // Firefox requires setData() to actually start a drag; the payload
    // itself is unused (we read dragFromIndex from closure).
    event.dataTransfer.setData("text/plain", indexAttr);
    stop.classList.add("dragging");
    diagnostics.debug("drag start", { from_index: dragFromIndex });
  });

  host.addEventListener("dragover", (event) => {
    if (dragFromIndex === null) return;
    const stop = tripStopAt(event.target);
    if (!stop) {
      setDropTarget(null, null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    // Show the drop indicator above or below the hovered stop based on
    // the pointer's vertical position within the stop's bounding box.
    const rect = stop.getBoundingClientRect();
    const above = event.clientY < rect.top + rect.height / 2;
    setDropTarget(stop, above ? "before" : "after");
  });

  host.addEventListener("dragleave", (event) => {
    // dragleave fires when the pointer enters a child element; only
    // clear if it's actually leaving the trip list root.
    if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
    setDropTarget(null, null);
  });

  host.addEventListener("drop", (event) => {
    if (dragFromIndex === null) return;
    const stop = tripStopAt(event.target);
    if (!stop) return;
    event.preventDefault();
    const indexAttr = stop.dataset.tripIndex;
    if (indexAttr === undefined) return;
    const overIndex = Number.parseInt(indexAttr, 10);
    if (!Number.isFinite(overIndex)) return;
    const rect = stop.getBoundingClientRect();
    const above = event.clientY < rect.top + rect.height / 2;
    const toIndex = above ? overIndex : overIndex + 1;
    const fromIndex = dragFromIndex;
    setDropTarget(null, null);
    dragFromIndex = null;
    if (fromIndex === toIndex || fromIndex + 1 === toIndex) return;
    const ctx = tryUseAppContext();
    if (!ctx) return;
    diagnostics.info("reorder requested", { from_index: fromIndex, to_index: toIndex });
    void ctx.store.reorderTrip(fromIndex, toIndex).catch((error: unknown) => {
      diagnostics.error("reorderTrip failed", { error: summarizeError(error) });
    });
  });

  host.addEventListener("dragend", () => {
    setDropTarget(null, null);
    host.querySelectorAll<HTMLElement>(".ts.dragging").forEach((node) => node.classList.remove("dragging"));
    dragFromIndex = null;
  });

  // Keyboard-driven reorder. Mirrors the drag-reorder gesture: the user
  // tabs to a trip stop (tabindex=0 on the row), then presses
  // Alt+ArrowUp / Alt+ArrowDown to swap with its neighbour. Plain Up/Down
  // is left alone so users can still tab through the list normally;
  // requiring Alt is the same shortcut convention as Trello/Notion's
  // keyboard reorder. After the reorder we re-focus the row at its new
  // index so chained keystrokes "carry" the stop along the list.
  host.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const stop = tripStopAt(event.target);
    if (!stop) return;
    const indexAttr = stop.dataset.tripIndex;
    if (indexAttr === undefined) return;
    const fromIndex = Number.parseInt(indexAttr, 10);
    if (!Number.isFinite(fromIndex)) return;
    const ctx = tryUseAppContext();
    if (!ctx) return;

    const tripLen = ctx.state().trip.length;
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const targetSlot = fromIndex + direction;
    if (targetSlot < 0 || targetSlot >= tripLen) return;
    event.preventDefault();

    // reorderTrip uses splice-then-insert semantics; targetSlot is the
    // final position we want the stop to occupy. Translate to the
    // splice-target index (the index BEFORE the removal). For a swap
    // with the next neighbour we want to land on (targetSlot + 1) so
    // that after the splice-removal of fromIndex the moved element ends
    // up at targetSlot.
    const spliceTarget = direction === 1 ? targetSlot + 1 : targetSlot;
    diagnostics.info("keyboard reorder requested", {
      from_index: fromIndex,
      to_index: spliceTarget,
      direction: direction === -1 ? "up" : "down"
    });
    void ctx.store
      .reorderTrip(fromIndex, spliceTarget)
      .then((changed) => {
        if (!changed) return;
        // After re-render, re-focus the row at its new index so the
        // user can keep nudging without re-finding it. queueMicrotask
        // gives the signal-driven render a chance to flush.
        queueMicrotask(() => {
          const moved = host.querySelector<HTMLElement>(
            `.ts[data-trip-index="${String(targetSlot)}"]`
          );
          moved?.focus();
        });
      })
      .catch((error: unknown) => {
        diagnostics.error("reorderTrip failed", { error: summarizeError(error) });
      });
  });

  return {
  render() {
    const ctx = tryUseAppContext();
    if (!ctx) {
      return html`<div id="tl" role="list" aria-label="Trip stops">${renderEmpty()}</div>`;
    }

    const state = ctx.state();
    if (state.trip.length === 0) {
      return html`<div id="tl" role="list" aria-label="Trip stops">${renderEmpty()}</div>`;
    }

    const segments = ctx.segmentsOf(state);
    const suggestions = ctx.suggestionsOf(state);

    const onRemove = (index: number) => () => {
      // Capture the city name BEFORE removing so the undo toast can
      // restore the right stop — once removeStop resolves, ctx.state()
      // has already shifted indexes.
      const stateBeforeRemoval = ctx.state();
      const removedName = stateBeforeRemoval.trip[index];
      diagnostics.info("remove stop requested", {
        index,
        city_name: removedName ?? null
      });
      void ctx.store
        .removeStop(index)
        .then((changed) => {
          if (!changed || !removedName) return;
          document.dispatchEvent(
            new CustomEvent("aetrain:request-undo-toast", {
              detail: { cityName: removedName, index }
            })
          );
        })
        .catch((error: unknown) => {
          diagnostics.error("removeStop failed", { error: summarizeError(error) });
        });
    };
    const onAddAfter = (index: number, name: string) => () => {
      diagnostics.info("add stop requested", { index, city_name: name });
      void ctx.store.addStopAfter(index, name).catch((error: unknown) => {
        diagnostics.error("addStopAfter failed", { error: summarizeError(error) });
      });
    };
    const onInsertBetween = (insertAt: number) => () => {
      diagnostics.info("insert between stops requested", { insert_at: insertAt });
      ctx.search.requestInsertAt(insertAt);
    };

    const items: DocumentFragment[] = [];
    for (let index = 0; index < state.trip.length; index += 1) {
      const cityName = state.trip[index];
      if (cityName === undefined) continue;
      const city = ctx.graph.cityMap[cityName];
      const segment = index > 0 ? segments[index - 1] : null;

      let badge: DocumentFragment | null = null;
      if (segment?.time) {
        const previousStop = state.trip[index - 1] ?? "";
        badge = html`<div class="tt">${`🚂 ${formatMinutes(segment.time)} from ${previousStop}`}</div>`;
      } else if (index > 0) {
        badge = html`<div class="tt err">⚠ No route found</div>`;
      }

      const meta = city
        ? html`${city.country}${" · ★"}${String(city.interest)}/10`
        : html``;
      const popLabel = city ? formatPopulation(city.pop) : "";

      const tripStopAriaLabel = city
        ? `Stop ${index + 1}: ${cityName}, ${city.country}`
        : `Stop ${index + 1}: ${cityName}`;

      items.push(html`
        <div
          class="ts"
          role="listitem"
          aria-label=${tripStopAriaLabel}
          aria-description="Use Alt+Up or Alt+Down to reorder"
          tabindex="0"
          draggable="true"
          data-trip-index=${String(index)}
        >
          ${index > 0 ? html`<div class="tcon"></div>` : null}
          <div
            class="tn drag-handle"
            aria-hidden="true"
            title="Drag to reorder"
          >${String(index + 1)}</div>
          <div class="ti">
            <div class="cn">
              ${cityName}
              ${city
                ? html`<span style="color:#475569;font-size:10px"> ${popLabel}</span>`
                : null}
            </div>
            <div class="cc">${meta}</div>
            ${badge}
          </div>
          <button
            class="tx"
            type="button"
            data-action="remove-stop"
            data-index=${String(index)}
            title="Remove"
            aria-label=${`Remove stop ${index + 1}: ${cityName}`}
            onclick=${onRemove(index)}
          >×</button>
        </div>
      `);

      // Inserter affordance between this stop and the next (skip after
       // the last stop — appending a new final stop is the job of
       // search / clicking on a city on the map). Slotting it between
       // the trip stop and the AI-driven suggestions keeps the visual
       // order: stop → "+ Insert stop" → suggested cities for this gap.
      if (index < state.trip.length - 1) {
        const insertAt = index + 1;
        const nextStop = state.trip[insertAt] ?? "";
        const insertLabel = `Insert a stop between ${cityName} and ${nextStop}`;
        items.push(html`
          <div
            class="insert-gap"
            role="button"
            tabindex="0"
            data-insert-at=${String(insertAt)}
            aria-label=${insertLabel}
            onclick=${onInsertBetween(insertAt)}
            onkeydown=${onSuggestionKeydown(onInsertBetween(insertAt))}
          >
            <span class="rail" aria-hidden="true"></span>
            <span class="label"><span aria-hidden="true">＋</span> Insert stop here</span>
            <span class="rail" aria-hidden="true"></span>
          </div>
        `);
      }

      const segmentSuggestions = suggestions
        .filter((suggestion: PlannerSuggestion) => suggestion.afterStop === index)
        .slice(0, 2);
      for (const suggestion of segmentSuggestions) {
        const detourLabel =
          suggestion.detourMin > 0
            ? `+${formatMinutes(suggestion.detourMin)} detour`
            : "on your route";
        const suggestionLabel = `Add ${suggestion.name} after stop ${index + 1}`;
        items.push(html`
          <div
            class="suggest"
            data-action="add-stop"
            data-index=${String(index)}
            data-city=${encodeURIComponent(suggestion.name)}
            role="button"
            tabindex="0"
            aria-label=${suggestionLabel}
            onclick=${onAddAfter(index, suggestion.name)}
            onkeydown=${onSuggestionKeydown(onAddAfter(index, suggestion.name))}
          >
            <span aria-hidden="true">💎</span>
            <span class="sg-n">${suggestion.name}</span>
            <span style="color:#475569">${suggestion.city.country}</span>
            <span class="sg-i">${`★${String(suggestion.city.interest)} · ${detourLabel}`}</span>
          </div>
        `);
      }
    }

    return html`<div id="tl" role="list" aria-label="Trip stops">${items}</div>`;
  }
  };
});

function renderEmpty(): DocumentFragment {
  // role="status" announces this empty state to screen readers without
  // stealing focus (matches aria-live="polite" on the host). The pulse
  // hint draws the eye toward the map — see the matching pulse on the
  // highest-interest visible city in leaflet-map-surface.ts.
  return html`
    <div id="empty" role="status">
      <div class="icon" aria-hidden="true">🚂</div>
      Click any city on the map<br />
      or search to build your trip.<br /><br />
      Interesting stops along your<br />
      route will be suggested automatically.
      <div class="hint" aria-hidden="true">
        <span class="dot"></span>
        Tap a glowing city to start
      </div>
    </div>
  `;
}

function onSuggestionKeydown(
  trigger: () => void
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      trigger();
    }
  };
}
