// Composes the sidebar building blocks (header, dataset meta, stats,
// filters, search, trip list, action footer). The previous markup had a
// single inline structure; here we delegate to the individual custom
// elements so they own their lifecycle.

import "./ae-stats.ts";
import "./ae-filters.ts";
import "./ae-search.ts";
import "./ae-trip-list.ts";

import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";
import { signal } from "../runtime/signal.ts";

// Bottom-sheet collapse state for the mobile layout. Persisted via the
// `data-sheet-state` attribute on #side; CSS reacts via the
// `@media (max-width: 800px)` rules in tokens.css. On desktop the
// attribute is set but no styles consume it.
type SheetState = "peek" | "expanded";
const sheetState = signal<SheetState>("expanded");

defineComponent("ae-sidebar", () => ({
  render() {
    const ctx = tryUseAppContext();
    const copyLabel = ctx ? ctx.copyButtonLabel() : "Copy Summary";

    const onClear = (event: Event) => {
      event.preventDefault();
      ctx?.onClearTrip();
    };
    const onShare = (event: Event) => {
      event.preventDefault();
      void ctx?.onShareTrip();
    };
    const onToggleSheet = (event: Event) => {
      event.preventDefault();
      sheetState.set(sheetState.peek() === "expanded" ? "peek" : "expanded");
    };

    const datasetMeta = ctx ? ctx.datasetMeta() : "Loading dataset…";
    const currentSheetState = sheetState();
    const sheetLabel =
      currentSheetState === "expanded" ? "Collapse sidebar" : "Expand sidebar";

    return html`
      <aside
        id="side"
        role="complementary"
        aria-label="Trip planner"
        data-sheet-state=${currentSheetState}
      >
        <button
          class="sheet-handle"
          type="button"
          aria-label=${sheetLabel}
          aria-expanded=${currentSheetState === "expanded" ? "true" : "false"}
          aria-controls="side"
          onclick=${onToggleSheet}
        >
          <span class="grip" aria-hidden="true"></span>
        </button>
        <div class="side-main">
          <div class="sh">
            <h1>Aetrain</h1>
            <p>Plan your European rail adventure</p>
            <div class="source-meta" id="source-meta">${datasetMeta}</div>
          </div>
          <ae-stats></ae-stats>
          <ae-filters></ae-filters>
          <ae-search></ae-search>
          <ae-trip-list></ae-trip-list>
        </div>
        <div class="actions">
          <button
            class="btn bd"
            type="button"
            data-action="clear-trip"
            aria-label="Clear all trip stops"
            onclick=${onClear}
          >Clear</button>
          <button
            class="btn bp"
            type="button"
            id="copyBtn"
            data-action="share-trip"
            aria-label="Copy trip summary to clipboard"
            onclick=${onShare}
          >${copyLabel}</button>
        </div>
      </aside>
    `;
  }
}));
