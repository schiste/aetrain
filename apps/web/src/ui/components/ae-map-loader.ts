// Small "map is loading" badge pinned to the top of the map column. It is a
// pure projection of the shell-level `mapLoadingState` signal: while any map
// asset load is in flight (`active > 0`) it shows a spinner + the current
// load label; when the last load drains it hides itself. It owns no loading
// logic and never touches the data gateway — boot() and the geometry-upgrade
// path drive the signal via beginMapLoading() (see map-loading.ts).
//
// Rendered as a SIBLING of #map (not a child): the map surface calls
// `mapRoot.replaceChildren()` on init, which would wipe any child overlay.
// CSS pins it over the map column at each breakpoint (see tokens.css).

import { createDiagnostics } from "../../app-shell/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { mapLoadingState } from "../shell/map-loading.ts";

const diagnostics = createDiagnostics("web/ui/map-loader");

defineComponent("ae-map-loader", (host) => {
  // role="status" + aria-live="polite" announces the load label to screen
  // readers as it appears/changes, mirroring the visual affordance. polite
  // avoids interrupting other live regions (e.g. the #citycount status).
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-atomic", "true");

  let wasVisible = false;

  return {
    render() {
      // Reading the signal here subscribes this component's render effect, so
      // it re-renders whenever a load begins or ends.
      const state = mapLoadingState();
      const visible = state.active > 0;

      if (visible !== wasVisible) {
        diagnostics.debug("map loader visibility changed", {
          visible,
          active: state.active,
          label: state.label
        });
        wasVisible = visible;
      }

      if (!visible) {
        host.removeAttribute("data-visible");
        return html``;
      }

      host.setAttribute("data-visible", "true");
      const label = state.label || "Loading map…";
      return html`
        <div class="map-loader">
          <span class="map-loader-spinner" aria-hidden="true"></span>
          <span class="map-loader-label">${label}</span>
        </div>
      `;
    }
  };
});
