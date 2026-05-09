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
      diagnostics.info("remove stop requested", { index });
      void ctx.store.removeStop(index).catch((error: unknown) => {
        diagnostics.error("removeStop failed", { error: summarizeError(error) });
      });
    };
    const onAddAfter = (index: number, name: string) => () => {
      diagnostics.info("add stop requested", { index, city_name: name });
      void ctx.store.addStopAfter(index, name).catch((error: unknown) => {
        diagnostics.error("addStopAfter failed", { error: summarizeError(error) });
      });
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
        <div class="ts" role="listitem" aria-label=${tripStopAriaLabel}>
          ${index > 0 ? html`<div class="tcon"></div>` : null}
          <div class="tn" aria-hidden="true">${String(index + 1)}</div>
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
  return html`
    <div id="empty">
      <div class="icon" aria-hidden="true">🚂</div>
      Click any city on the map<br />
      or search to build your trip.<br /><br />
      Interesting stops along your<br />
      route will be suggested automatically.
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
