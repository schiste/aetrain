// Custom element that renders the POC ↔ Production data source toggle.
// Reads the active/requested ids and the dataset description from the
// shared AppContext; writes navigation back through navigateToDataSource.

import { createDiagnostics } from "../../app-shell/diagnostics.ts";
import { navigateToDataSource } from "../../data/runtime-data.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";

const diagnostics = createDiagnostics("web/ui/source-switch");

defineComponent("ae-source-switch", () => ({
  render() {
    const ctx = tryUseAppContext();
    if (!ctx) {
      return html`<div class="source-switch source-switch--pending">
        <span class="source-label">Data</span>
      </div>`;
    }

    const active = ctx.source.activeSourceId();
    const meta = ctx.source.metaText();

    return html`
      <div class="source-switch">
        <span class="source-label">Data</span>
        <div class="source-toggle" role="group" aria-label="Data source">
          <button
            class=${`source-btn${active === "poc" ? " active" : ""}`}
            type="button"
            id="source-poc"
            data-source-id="poc"
            onclick=${onSelect("poc", active)}
          >POC</button>
          <button
            class=${`source-btn${active === "production" ? " active" : ""}`}
            type="button"
            id="source-production"
            data-source-id="production"
            onclick=${onSelect("production", active)}
          >Production</button>
        </div>
      </div>
      <div class="source-meta" id="source-meta">${meta}</div>
    `;
  }
}));

function onSelect(target: string, current: string): (event: Event) => void {
  return () => {
    if (target === current) {
      return;
    }
    diagnostics.info("source toggle requested", {
      from_source_id: current,
      to_source_id: target
    });
    navigateToDataSource(target);
  };
}
