// Zoom-aware default for the population filter.
//
// When the user hasn't touched the population slider, the map auto-
// adjusts the threshold so the visible city density stays roughly
// constant across zoom levels: zoomed out shows only major hubs,
// zoomed in surfaces smaller towns. As soon as the user moves the
// slider (or inline-edits the value), the store flips to "manual"
// mode and this function is no longer consulted until the user hits
// Reset.
//
// The choice of mapping is a UX decision more than a code one. See
// derivePopThresholdForZoom below — the meaningful trade-offs are
// captured there for you to author.

/**
 * Derive the population filter threshold (in thousands) for a given
 * map zoom level. Higher return value = stricter filter = fewer
 * cities drawn.
 *
 * The map's zoom range in practice is roughly 4 (full Europe view) to
 * 11 (single-city view). Recommended anchor points to think about:
 *
 *   zoom 4-5  (continental):  only national / regional capitals
 *   zoom 5-6  (country):      mid-sized cities + capitals
 *   zoom 6-8  (region):       towns of medium population
 *   zoom 8-10 (metro):        smaller towns + suburbs
 *   zoom 10+  (city):         everything in the dataset
 *
 * Constraints the rest of the codebase imposes:
 *   - Valid range is 0..1000 (clampInteger in planner-store).
 *   - 0 == "show all populations"; 100 is today's default.
 *   - Slider step is 10, so emitting non-multiples produces a
 *     visually-jumpy thumb. Round to the nearest 10 unless you have a
 *     reason to do otherwise.
 *
 * Design trade-offs:
 *   - Step function (e.g. switch on zoom buckets) is easier to predict
 *     and debug. Slider jumps in discrete steps as the user zooms.
 *   - Smooth function (e.g. exponential decay) feels more organic but
 *     makes it harder to anticipate "what will I see at zoom X".
 *   - The interest filter (filterInterest) overlaps with population
 *     filtering — high-interest small towns shouldn't get hidden when
 *     zoomed out. The pop filter is OR'd with interest in the render
 *     plan, so we don't need to compensate here; an interest-9 city
 *     of 30k still appears at continental zoom.
 *
 * Pick whatever shape best matches your sense of the European rail
 * dataset. The function will be called for every view-change event
 * (debounced by the map surface to ~50ms).
 */
export function derivePopThresholdForZoom(zoom: number): number {
  // CONTINUOUS curve (not a step function). The map surface samples this
  // every frame against the *live* camera zoom to gate city dots, so any
  // discontinuity would make dots pop in/out the instant the wheel
  // crosses a breakpoint instead of fading as the threshold slides past
  // their population. A piecewise-linear interpolation keeps the gate
  // smooth while still letting us hand-place the density at each zoom.
  //
  // The anchors are chosen so the visible-city count stays roughly
  // constant as zoom progresses across the European dataset's
  // heavy-tailed population distribution
  // (~70 cities ≥ 500k, ~250 ≥ 250k, ~700 ≥ 100k, ~1500 ≥ 50k,
  // ~3000 ≥ 30k, ~6000 ≥ 10k, 8929 total). Values roughly halve per
  // zoom level, which matches that tail.
  //
  // The low-population floor below zoom 10.5 matters: at zoom 9 in dense
  // regions (Ruhr, BeNeLux), dropping straight to "show everything"
  // floods the map with overlapping village dots, so we hold a small
  // floor and only reach 0 ("show all") once the user is genuinely
  // city-scale. Returns a *continuous* value (thousands); callers that
  // feed a step-10 slider should round — the dot gate uses it raw.
  return interpolatePopAnchors(zoom, POP_ANCHORS);
}

/** [zoom, threshold-in-thousands] anchors, ascending by zoom and strictly
 *  decreasing in threshold. Below the first zoom the first threshold
 *  holds; above the last, the last (0). */
const POP_ANCHORS: readonly (readonly [number, number])[] = [
  [4, 500],    // continent view: only multi-million hubs
  [5, 300],    // sub-continent: national capitals + majors
  [6, 150],    // country view: large cities
  [7, 70],     // multi-region: mid-sized cities
  [8, 30],     // region: small cities + larger towns
  [9, 12],     // metro: most towns
  [9.5, 8],    // dense-metro floor (holds village flood at bay)
  [10.5, 0]    // city view: everything
];

/** Self-contained piecewise-linear interpolation over `anchors`. Kept
 *  local (no import from map/render-model) so this state-layer module
 *  stays independent of the rendering internals — the surface receives
 *  this whole function via dependency injection, not the other way. */
function interpolatePopAnchors(
  zoom: number,
  anchors: readonly (readonly [number, number])[]
): number {
  const first = anchors[0];
  if (!first) return 0;
  if (zoom <= first[0]) return first[1];

  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const current = anchors[index];
    if (!previous || !current) continue;
    if (zoom > current[0]) continue;

    const span = current[0] - previous[0];
    const progress = span <= 0 ? 0 : (zoom - previous[0]) / span;
    return previous[1] + (current[1] - previous[1]) * progress;
  }

  return anchors[anchors.length - 1]?.[1] ?? 0;
}
