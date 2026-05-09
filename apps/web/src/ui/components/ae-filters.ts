// Map filter panel — interest range, population range, leg dual-range,
// and the "next leg from <last stop>" hint. Click-to-edit is implemented
// directly on the value spans (the legacy implementation did the same
// thing imperatively in app.ts; here it lives inside the component).

import { createDiagnostics } from "../../app-shell/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";
import { formatLeg } from "../runtime/format.ts";

const diagnostics = createDiagnostics("web/ui/filters");

defineComponent("ae-filters", (host) => ({
  render() {
    const ctx = tryUseAppContext();
    if (!ctx) {
      return html`<details class="filters" open><summary>Map Filters</summary></details>`;
    }

    const state = ctx.state();
    const visibility = ctx.visibility();
    const status = ctx.statusText();
    const showLegFilter = state.trip.length >= 1;
    const lastStop = showLegFilter ? state.trip[state.trip.length - 1] : "";

    const range = state.legDynMax || 1440;
    const left = (state.legMin / range) * 100;
    const right = (state.legMax / range) * 100;
    const fillStyle = `left:${left}%; width:${Math.max(0, right - left)}%`;

    const isOpen = host.dataset.filtersOpen !== "closed";
    const onToggle = (event: Event) => {
      const target = event.currentTarget as HTMLDetailsElement;
      host.dataset.filtersOpen = target.open ? "open" : "closed";
    };

    const onIntChange = (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      ctx.store.setFilterInterest(target.value);
    };
    const onPopChange = (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      ctx.store.setFilterPop(target.value);
    };
    const onLegMinChange = (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      ctx.store.setLegRange({ min: target.value, max: state.legMax });
    };
    const onLegMaxChange = (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      ctx.store.setLegRange({ min: state.legMin, max: target.value });
    };

    const reachableInfo =
      showLegFilter
        ? `Reachable in ${formatLeg(state.legMin)} - ${formatLeg(state.legMax)}: ${visibility.reachable} cities`
        : "Reachable cities: —";

    const interestValueText = `${state.filterInterest} or higher`;
    const popValueText =
      state.filterPop === 0 ? "All populations" : `${state.filterPop} thousand or higher`;
    const legMinValueText = `Minimum ${formatLeg(state.legMin)}`;
    const legMaxValueText = `Maximum ${formatLeg(state.legMax)}`;

    return html`
      <details class="filters" ?open=${isOpen} ontoggle=${onToggle}>
        <summary>Map Filters</summary>
        <div class="fc">
          <div class="fg">
            <label for="f-int">Interest</label>
            <input
              type="range"
              id="f-int"
              min="1"
              max="10"
              aria-label="Minimum city interest rating"
              aria-valuetext=${interestValueText}
              .value=${String(state.filterInterest)}
              oninput=${onIntChange}
            />
            <span
              class="fv"
              id="fv-int"
              onclick=${editInterestSpan(ctx, state.filterInterest)}
            >${`${state.filterInterest}+`}</span>
          </div>

          <div class="fg">
            <label for="f-pop">Pop.</label>
            <input
              type="range"
              id="f-pop"
              min="0"
              max="1000"
              step="10"
              aria-label="Minimum city population in thousands"
              aria-valuetext=${popValueText}
              .value=${String(state.filterPop)}
              oninput=${onPopChange}
            />
            <span
              class="fv"
              id="fv-pop"
              onclick=${editPopSpan(ctx, state.filterPop)}
            >${state.filterPop === 0 ? "All" : `${state.filterPop}k+`}</span>
          </div>

          <div id="leg-filter" style=${showLegFilter ? "display:block" : "display:none"}>
            <div style="height:1px;background:#1e293b;margin:8px 0"></div>
            <div style="font-size:10px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.3px">
              Next leg from <b id="leg-from" style="color:#f59e0b">${lastStop ?? "—"}</b>
            </div>

            <div class="fg">
              <label for="f-leg-min">Leg</label>
              <div class="dual-range">
                <input
                  type="range"
                  id="f-leg-min"
                  min="0"
                  step="15"
                  max=${String(state.legDynMax)}
                  aria-label="Minimum next leg duration"
                  aria-valuetext=${legMinValueText}
                  .value=${String(state.legMin)}
                  oninput=${onLegMinChange}
                />
                <input
                  type="range"
                  id="f-leg-max"
                  min="0"
                  step="15"
                  max=${String(state.legDynMax)}
                  aria-label="Maximum next leg duration"
                  aria-valuetext=${legMaxValueText}
                  .value=${String(state.legMax)}
                  oninput=${onLegMaxChange}
                />
                <div class="dual-track"></div>
                <div class="dual-fill" id="dual-fill" style=${fillStyle}></div>
              </div>
              <span
                class="fv"
                id="fv-leg"
                style="width:80px"
                onclick=${editLegSpan(ctx, state.legMin, state.legMax, state.legDynMax)}
              >${`${formatLeg(state.legMin)} — ${formatLeg(state.legMax)}`}</span>
            </div>

            <div id="leg-info" style="font-size:10px;color:#475569;font-style:italic">
              ${reachableInfo}
            </div>
          </div>

          <div class="fi" id="fi-txt">${status}</div>
        </div>
      </details>
    `;
  }
}));

interface InlineEditConfig {
  current: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  apply: (value: number) => void;
}

function editInterestSpan(
  ctx: ReturnType<typeof tryUseAppContext>,
  current: number
): (event: Event) => void {
  return (event: Event) => {
    if (!ctx) return;
    inlineEditNumber(event.currentTarget as HTMLElement, {
      current,
      min: 1,
      max: 10,
      step: 1,
      format: (value) => `${value}+`,
      apply: (value) => ctx.store.setFilterInterest(value)
    });
  };
}

function editPopSpan(
  ctx: ReturnType<typeof tryUseAppContext>,
  current: number
): (event: Event) => void {
  return (event: Event) => {
    if (!ctx) return;
    inlineEditNumber(event.currentTarget as HTMLElement, {
      current,
      min: 0,
      max: 1000,
      step: 10,
      format: (value) => (value === 0 ? "All" : `${value}k+`),
      apply: (value) => ctx.store.setFilterPop(value)
    });
  };
}

function editLegSpan(
  ctx: ReturnType<typeof tryUseAppContext>,
  legMin: number,
  legMax: number,
  legDynMax: number
): (event: Event) => void {
  return (event: Event) => {
    if (!ctx) return;
    const target = event.currentTarget as HTMLElement;
    if (target.querySelector("input")) {
      return;
    }

    target.textContent = "";

    const minInput = document.createElement("input");
    minInput.type = "number";
    minInput.className = "fv-input";
    minInput.value = String(Math.round((legMin / 60) * 10) / 10);
    minInput.min = "0";
    minInput.max = String(Math.ceil(legDynMax / 60));
    minInput.step = "0.25";
    minInput.style.width = "28px";
    minInput.style.textAlign = "center";

    const dash = document.createElement("span");
    dash.textContent = " — ";
    dash.style.color = "#475569";
    dash.style.fontSize = "10px";

    const maxInput = document.createElement("input");
    maxInput.type = "number";
    maxInput.className = "fv-input";
    maxInput.value = String(Math.round((legMax / 60) * 10) / 10);
    maxInput.min = "0";
    maxInput.max = String(Math.ceil(legDynMax / 60));
    maxInput.step = "0.25";
    maxInput.style.width = "28px";
    maxInput.style.textAlign = "center";

    const suffix = document.createElement("span");
    suffix.textContent = "h";
    suffix.style.color = "#f59e0b";
    suffix.style.fontSize = "10px";

    target.append(minInput, dash, maxInput, suffix);
    minInput.focus();
    minInput.select();

    function commit(): void {
      let nextMin = Number.parseFloat(minInput.value);
      let nextMax = Number.parseFloat(maxInput.value);
      if (Number.isNaN(nextMin)) nextMin = legMin / 60;
      if (Number.isNaN(nextMax)) nextMax = legMax / 60;

      const maxHours = Math.ceil(legDynMax / 60);
      nextMin = Math.max(0, Math.min(maxHours, nextMin));
      nextMax = Math.max(0, Math.min(maxHours, nextMax));
      if (nextMin > nextMax) {
        [nextMin, nextMax] = [nextMax, nextMin];
      }

      diagnostics.info("inline leg range edit committed", {
        next_min: nextMin,
        next_max: nextMax
      });
      ctx?.store.setLegRange({
        min: Math.round(nextMin * 60),
        max: Math.round(nextMax * 60)
      });
    }

    minInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        maxInput.focus();
        maxInput.select();
      }
      if (event.key === "Escape") {
        commit();
      }
    });

    maxInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        commit();
      }
    });

    maxInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement !== minInput) {
          commit();
        }
      }, 100);
    });

    minInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement !== maxInput) {
          commit();
        }
      }, 100);
    });
  };
}

function inlineEditNumber(target: HTMLElement, config: InlineEditConfig): void {
  if (target.querySelector("input")) {
    return;
  }

  const input = document.createElement("input");
  input.type = "number";
  input.className = "fv-input";
  input.value = String(config.current);
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = String(config.step);

  target.textContent = "";
  target.appendChild(input);
  input.focus();
  input.select();

  function commit(): void {
    let value = Number.parseInt(input.value, 10);
    if (Number.isNaN(value)) {
      value = config.current;
    }
    value = Math.max(config.min, Math.min(config.max, value));
    diagnostics.debug("inline number edit committed", {
      value
    });
    config.apply(value);
    target.textContent = config.format(value);
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      input.value = String(config.current);
      input.blur();
    }
  });
}
