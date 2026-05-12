// Map filter panel — interest range, population range, leg dual-range,
// and the "next leg from <last stop>" hint.
//
// Why this component scaffolds DOM imperatively instead of returning a
// fresh `html\`...\`` fragment on every render: the runtime calls
// host.replaceChildren() on each render, which is correct for static
// content but destroys live DOM state on form inputs. When a slider
// fires `input` continuously during a drag, the resulting state change
// triggers a re-render → new <input> nodes → drag tracking lost.
//
// Solution mirrors ae-search: build the inputs + spans once on first
// connect, wire event listeners once, and on subsequent renders only
// update values and visibility — never replace the nodes themselves.
// Inputs that currently have focus are NOT synced to state (the user
// is actively dragging; their input value is the source of truth until
// they release). Everything else updates each render.

import { createDiagnostics } from "../../app-shell/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { tryUseAppContext, type AppContext } from "../runtime/context.ts";
import { formatLeg } from "../runtime/format.ts";

const diagnostics = createDiagnostics("web/ui/filters");

defineComponent("ae-filters", (host) => {
  interface Scaffolding {
    detailsEl: HTMLDetailsElement;
    summaryLabel: HTMLSpanElement;
    resetBtn: HTMLButtonElement;
    intInput: HTMLInputElement;
    intSpan: HTMLSpanElement;
    popInput: HTMLInputElement;
    popSpan: HTMLSpanElement;
    legFilterEl: HTMLDivElement;
    legFromEl: HTMLElement;
    legMinInput: HTMLInputElement;
    legMaxInput: HTMLInputElement;
    dualFillEl: HTMLDivElement;
    legSpan: HTMLSpanElement;
    legInfoEl: HTMLDivElement;
    statusEl: HTMLDivElement;
  }

  let scaffold: Scaffolding | null = null;

  function ensureScaffolding(ctx: AppContext): Scaffolding {
    if (scaffold) return scaffold;

    const details = document.createElement("details");
    details.className = "filters";
    details.open = host.dataset.filtersOpen !== "closed";
    details.addEventListener("toggle", () => {
      host.dataset.filtersOpen = details.open ? "open" : "closed";
    });

    const summary = document.createElement("summary");
    const summaryLabel = document.createElement("span");
    summaryLabel.textContent = "Map Filters";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "filters-reset";
    resetBtn.textContent = "Reset";
    resetBtn.setAttribute("aria-label", "Reset filters to defaults");
    resetBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const state = ctx.state.peek();
      ctx.store.setFilterInterest(5);
      ctx.store.setFilterPop(100);
      ctx.store.setLegRange({ min: 0, max: state.legDynMax });
    });
    summary.append(summaryLabel, resetBtn);
    details.appendChild(summary);

    const fc = document.createElement("div");
    fc.className = "fc";

    // Interest row
    const intRow = document.createElement("div");
    intRow.className = "fg";
    const intLabel = document.createElement("label");
    intLabel.htmlFor = "f-int";
    intLabel.textContent = "Interest";
    const intInput = document.createElement("input");
    intInput.type = "range";
    intInput.id = "f-int";
    intInput.min = "1";
    intInput.max = "10";
    intInput.setAttribute("aria-label", "Minimum city interest rating");
    intInput.addEventListener("input", () => {
      ctx.store.setFilterInterest(intInput.value);
    });
    const intSpan = document.createElement("span");
    intSpan.className = "fv";
    intSpan.id = "fv-int";
    intSpan.addEventListener("click", () => {
      inlineEditNumber(intSpan, {
        current: ctx.state.peek().filterInterest,
        min: 1,
        max: 10,
        step: 1,
        format: (value) => `${value}+`,
        apply: (value) => ctx.store.setFilterInterest(value)
      });
    });
    intRow.append(intLabel, intInput, intSpan);
    fc.appendChild(intRow);

    // Pop row
    const popRow = document.createElement("div");
    popRow.className = "fg";
    const popLabel = document.createElement("label");
    popLabel.htmlFor = "f-pop";
    popLabel.textContent = "Pop.";
    const popInput = document.createElement("input");
    popInput.type = "range";
    popInput.id = "f-pop";
    popInput.min = "0";
    popInput.max = "1000";
    popInput.step = "10";
    popInput.setAttribute("aria-label", "Minimum city population in thousands");
    popInput.addEventListener("input", () => {
      ctx.store.setFilterPop(popInput.value);
    });
    const popSpan = document.createElement("span");
    popSpan.className = "fv";
    popSpan.id = "fv-pop";
    popSpan.addEventListener("click", () => {
      inlineEditNumber(popSpan, {
        current: ctx.state.peek().filterPop,
        min: 0,
        max: 1000,
        step: 10,
        format: (value) => (value === 0 ? "All" : `${value}k+`),
        apply: (value) => ctx.store.setFilterPop(value)
      });
    });
    popRow.append(popLabel, popInput, popSpan);
    fc.appendChild(popRow);

    // Leg filter (hidden when trip is empty)
    const legFilterEl = document.createElement("div");
    legFilterEl.id = "leg-filter";

    const legSeparator = document.createElement("div");
    legSeparator.style.cssText = "height:1px;background:#1e293b;margin:8px 0";
    legFilterEl.appendChild(legSeparator);

    const legHeader = document.createElement("div");
    legHeader.style.cssText = "font-size:10px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.3px";
    legHeader.append("Next leg from ");
    const legFromEl = document.createElement("b");
    legFromEl.id = "leg-from";
    legFromEl.style.color = "#f59e0b";
    legHeader.appendChild(legFromEl);
    legFilterEl.appendChild(legHeader);

    const legRow = document.createElement("div");
    legRow.className = "fg";
    const legLabel = document.createElement("label");
    legLabel.htmlFor = "f-leg-min";
    legLabel.textContent = "Duration";
    legRow.appendChild(legLabel);

    const dualRange = document.createElement("div");
    dualRange.className = "dual-range";
    const legMinInput = document.createElement("input");
    legMinInput.type = "range";
    legMinInput.id = "f-leg-min";
    legMinInput.min = "0";
    legMinInput.step = "15";
    legMinInput.setAttribute("aria-label", "Minimum next leg duration");
    legMinInput.addEventListener("input", () => {
      const stateNow = ctx.state.peek();
      ctx.store.setLegRange({ min: legMinInput.value, max: stateNow.legMax });
    });
    const legMaxInput = document.createElement("input");
    legMaxInput.type = "range";
    legMaxInput.id = "f-leg-max";
    legMaxInput.min = "0";
    legMaxInput.step = "15";
    legMaxInput.setAttribute("aria-label", "Maximum next leg duration");
    legMaxInput.addEventListener("input", () => {
      const stateNow = ctx.state.peek();
      ctx.store.setLegRange({ min: stateNow.legMin, max: legMaxInput.value });
    });
    const dualTrack = document.createElement("div");
    dualTrack.className = "dual-track";
    const dualFillEl = document.createElement("div");
    dualFillEl.className = "dual-fill";
    dualFillEl.id = "dual-fill";
    dualRange.append(legMinInput, legMaxInput, dualTrack, dualFillEl);
    legRow.appendChild(dualRange);

    const legSpan = document.createElement("span");
    legSpan.className = "fv";
    legSpan.id = "fv-leg";
    legSpan.style.width = "80px";
    legSpan.addEventListener("click", () => {
      const stateNow = ctx.state.peek();
      openLegInlineEdit(legSpan, ctx, stateNow.legMin, stateNow.legMax, stateNow.legDynMax);
    });
    legRow.appendChild(legSpan);
    legFilterEl.appendChild(legRow);

    const legInfoEl = document.createElement("div");
    legInfoEl.id = "leg-info";
    legInfoEl.style.cssText = "font-size:10px;color:#475569;font-style:italic";
    legFilterEl.appendChild(legInfoEl);

    fc.appendChild(legFilterEl);

    const statusEl = document.createElement("div");
    statusEl.className = "fi";
    statusEl.id = "fi-txt";
    // Filter status text changes whenever the user adjusts a slider —
    // announce it politely so screen readers keep up with the filter
    // hit-count without interrupting the drag.
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    fc.appendChild(statusEl);

    details.appendChild(fc);
    host.replaceChildren(details);

    scaffold = {
      detailsEl: details,
      summaryLabel,
      resetBtn,
      intInput,
      intSpan,
      popInput,
      popSpan,
      legFilterEl,
      legFromEl,
      legMinInput,
      legMaxInput,
      dualFillEl,
      legSpan,
      legInfoEl,
      statusEl
    };
    return scaffold;
  }

  return {
    render() {
      const ctx = tryUseAppContext();
      if (!ctx) {
        // Pre-context render: skip scaffolding until the shell is ready.
        return null;
      }
      const s = ensureScaffolding(ctx);

      const state = ctx.state();
      const visibility = ctx.visibility();
      const status = ctx.statusText();
      const showLegFilter = state.trip.length >= 1;
      const lastStop = showLegFilter ? state.trip[state.trip.length - 1] : "";

      // Sync inputs, but only when NOT focused — a focused input may be
      // mid-drag, and stomping its value would lose the user's gesture.
      syncInputValue(s.intInput, state.filterInterest);
      syncInputAria(s.intInput, "aria-valuetext", `${state.filterInterest} or higher`);

      syncInputValue(s.popInput, state.filterPop);
      syncInputAria(s.popInput, "aria-valuetext", state.filterPop === 0 ? "All populations" : `${state.filterPop} thousand or higher`);

      const dynMaxStr = String(state.legDynMax);
      if (s.legMinInput.max !== dynMaxStr) s.legMinInput.max = dynMaxStr;
      if (s.legMaxInput.max !== dynMaxStr) s.legMaxInput.max = dynMaxStr;
      syncInputValue(s.legMinInput, state.legMin);
      syncInputValue(s.legMaxInput, state.legMax);
      syncInputAria(s.legMinInput, "aria-valuetext", `Minimum ${formatLeg(state.legMin)}`);
      syncInputAria(s.legMaxInput, "aria-valuetext", `Maximum ${formatLeg(state.legMax)}`);

      // Spans (no DOM stability concern — they're text-only).
      if (s.intSpan.querySelector("input") === null) {
        s.intSpan.textContent = `${state.filterInterest}+`;
      }
      if (s.popSpan.querySelector("input") === null) {
        s.popSpan.textContent = state.filterPop === 0 ? "All" : `${state.filterPop}k+`;
      }
      if (s.legSpan.querySelector("input") === null) {
        s.legSpan.textContent = `${formatLeg(state.legMin)} — ${formatLeg(state.legMax)}`;
      }

      const range = state.legDynMax || 1440;
      const left = (state.legMin / range) * 100;
      const right = (state.legMax / range) * 100;
      s.dualFillEl.style.left = `${left}%`;
      s.dualFillEl.style.width = `${Math.max(0, right - left)}%`;

      s.legFromEl.textContent = lastStop ?? "—";
      s.legFilterEl.style.display = showLegFilter ? "block" : "none";

      s.legInfoEl.textContent =
        showLegFilter
          ? `Reachable in ${formatLeg(state.legMin)} - ${formatLeg(state.legMax)}: ${visibility.reachable} cities`
          : "Reachable cities: —";

      s.statusEl.textContent = status;

      const isAtDefaults =
        state.filterInterest === 5
        && state.filterPop === 100
        && state.legMin === 0
        && state.legMax === state.legDynMax;
      s.resetBtn.hidden = isAtDefaults;

      return null;
    }
  };
});

function syncInputValue(input: HTMLInputElement, next: number | string): void {
  const nextStr = String(next);
  if (input.value === nextStr) return;
  // The focused input is the source of truth during drag — don't stomp.
  if (document.activeElement === input) return;
  input.value = nextStr;
}

function syncInputAria(input: HTMLInputElement, attr: string, value: string): void {
  if (input.getAttribute(attr) === value) return;
  input.setAttribute(attr, value);
}

interface InlineEditConfig {
  current: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  apply: (value: number) => void;
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
    diagnostics.debug("inline number edit committed", { value });
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

function openLegInlineEdit(
  target: HTMLElement,
  ctx: AppContext,
  legMin: number,
  legMax: number,
  legDynMax: number
): void {
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
    ctx.store.setLegRange({
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
}
