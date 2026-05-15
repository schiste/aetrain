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
  // TODO(user): author the mapping. A starter step function is below —
  // tweak the breakpoints and values, or rewrite as a smooth function.
  if (zoom < 5) return 500;     // continent view: only major capitals
  if (zoom < 6) return 250;     // country view: large cities
  if (zoom < 7) return 100;     // region view: today's default
  if (zoom < 8) return 50;      // sub-region: smaller towns
  if (zoom < 9) return 20;      // metro: most towns
  return 0;                     // city view: everything
}
