// 4-stat grid (stops / travel time / countries / distance). Read-only:
// derives values from the live PlannerState signal in the AppContext.

import { createDiagnostics } from "../../app-shell/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";
import { formatMinutes, haversine } from "../runtime/format.ts";
import type { PlannerSegment } from "../../types/planner-engine.ts";

const diagnostics = createDiagnostics("web/ui/stats");

defineComponent("ae-stats", () => ({
  render() {
    const ctx = tryUseAppContext();
    if (!ctx) {
      return html`
        <div class="stats">
          <div class="st"><b id="sv-s">0</b><small>Stops</small></div>
          <div class="st"><b id="sv-h">0h</b><small>Travel</small></div>
          <div class="st"><b id="sv-c">0</b><small>Countries</small></div>
          <div class="st"><b id="sv-d">0km</b><small>Distance</small></div>
        </div>
      `;
    }

    const state = ctx.state();
    const segments = ctx.segmentsOf(state);
    const totalMinutes = segments.reduce(
      (sum: number, segment: PlannerSegment | null | undefined) =>
        sum + (segment?.time || 0),
      0
    );

    const countries: Record<string, true> = {};
    for (const stop of state.trip) {
      const city = ctx.graph.cityMap[stop];
      if (city) {
        countries[city.country] = true;
      }
    }

    let distanceKm = 0;
    for (let index = 1; index < state.trip.length; index += 1) {
      const previousStop = state.trip[index - 1];
      const currentStop = state.trip[index];
      if (previousStop === undefined || currentStop === undefined) {
        continue;
      }
      const from = ctx.graph.cityMap[previousStop];
      const to = ctx.graph.cityMap[currentStop];
      if (from && to) {
        distanceKm += haversine(from, to);
      }
    }

    diagnostics.debug("rendered stats", {
      stops: state.trip.length,
      total_minutes: totalMinutes,
      country_count: Object.keys(countries).length,
      distance_km: Math.round(distanceKm)
    });

    return html`
      <div class="stats">
        <div class="st"><b id="sv-s">${String(state.trip.length)}</b><small>Stops</small></div>
        <div class="st"><b id="sv-h">${formatMinutes(totalMinutes)}</b><small>Travel</small></div>
        <div class="st"><b id="sv-c">${String(Object.keys(countries).length)}</b><small>Countries</small></div>
        <div class="st"><b id="sv-d">${`${Math.round(distanceKm)}km`}</b><small>Distance</small></div>
      </div>
    `;
  }
}));
