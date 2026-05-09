// City search input + results dropdown.
//
// The input is built imperatively once and reused across renders so that
// typing in it does not blow away the focused element on every keystroke.
// Only the dropdown re-renders reactively when search results, the open
// flag, or the query change.

import { createDiagnostics, summarizeError } from "../../app-shell/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";
import { formatPopulation } from "../runtime/format.ts";
import type { PlannerCity } from "../../types/planner-dataset.ts";

const diagnostics = createDiagnostics("web/ui/search");

defineComponent("ae-search", (host) => {
  let inputNode: HTMLInputElement | null = null;
  let dropdownNode: HTMLDivElement | null = null;
  let initialized = false;

  function ensureScaffolding(): void {
    if (initialized) return;

    const ctx = tryUseAppContext();
    const wrapper = document.createElement("div");
    wrapper.className = "sb";

    const input = document.createElement("input");
    input.id = "sinput";
    input.type = "text";
    input.placeholder = "Search a city...";
    input.autocomplete = "off";

    input.addEventListener("input", () => {
      const liveCtx = tryUseAppContext();
      if (!liveCtx) return;
      liveCtx.search.setOpen(true);
      diagnostics.debug("search input changed", { query: input.value });
      void liveCtx.store.setSearchQuery(input.value).catch((error: unknown) => {
        diagnostics.error("setSearchQuery failed", { error: summarizeError(error) });
      });
    });
    input.addEventListener("blur", () => {
      const liveCtx = tryUseAppContext();
      window.setTimeout(() => {
        liveCtx?.search.setOpen(false);
      }, 200);
    });
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const liveCtx = tryUseAppContext();
        liveCtx?.search.setOpen(false);
        input.blur();
      }
    });

    const dropdown = document.createElement("div");
    dropdown.id = "sr";
    dropdown.style.display = "none";
    dropdown.addEventListener("click", (event: Event) => {
      const liveCtx = tryUseAppContext();
      if (!liveCtx) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const item = target.closest(".sri");
      if (!item) return;
      const dataCity = item.getAttribute("data-city");
      if (dataCity === null) return;
      const cityName = decodeURIComponent(dataCity);
      diagnostics.info("selected search result", { city_name: cityName });
      liveCtx.search.onSelectResult(cityName);
    });

    wrapper.append(input, dropdown);
    host.replaceChildren(wrapper);
    inputNode = input;
    dropdownNode = dropdown;
    initialized = true;
    void ctx;
  }

  return {
    render() {
      ensureScaffolding();
      const ctx = tryUseAppContext();
      if (!ctx || !inputNode || !dropdownNode) {
        return null;
      }

      const state = ctx.state();
      const isOpen = ctx.search.isOpen();

      // Sync input value without disturbing focus/cursor.
      if (inputNode !== document.activeElement && inputNode.value !== state.searchQuery) {
        inputNode.value = state.searchQuery;
      }

      const matches = state.searchResults;
      const showDropdown =
        isOpen && state.searchQuery.trim().length >= 1 && matches.length > 0;

      // Replace dropdown contents.
      dropdownNode.replaceChildren(
        ...matches.map((city) => renderResult(city, state.trip.includes(city.name)))
      );
      dropdownNode.style.display = showDropdown ? "block" : "none";

      return null;
    }
  };
});

function renderResult(city: PlannerCity, isActive: boolean): DocumentFragment {
  const dots: DocumentFragment[] = [];
  const filled = Math.ceil(city.interest / 2);
  for (let index = 0; index < 5; index += 1) {
    const on = index < filled;
    dots.push(html`<i class=${on ? "on" : ""}></i>`);
  }

  return html`
    <div
      class=${`sri${isActive ? " act" : ""}`}
      data-city=${encodeURIComponent(city.name)}
    >
      <span class="sn">${city.name}</span>
      <span class="sc">${`${city.country} · ${formatPopulation(city.pop)}`}</span>
      <span class="sq">${dots}</span>
    </div>
  `;
}
