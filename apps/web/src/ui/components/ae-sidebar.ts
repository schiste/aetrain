// Composes the existing sidebar building blocks (header, source switch,
// stats, filters, search, trip list, action footer). The previous markup
// in the prior shell had a single inline structure; here we delegate to
// the individual custom elements so they own their lifecycle.

import "./ae-source-switch.ts";
import "./ae-stats.ts";
import "./ae-filters.ts";
import "./ae-search.ts";
import "./ae-trip-list.ts";

import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";

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

    return html`
      <aside id="side" role="complementary" aria-label="Trip planner">
        <div class="side-main">
          <div class="sh">
            <h1>Aetrain</h1>
            <p>Plan your European rail adventure</p>
            <ae-source-switch></ae-source-switch>
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
