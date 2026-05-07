export const EMPTY_TRIP_MARKUP = `
  <div id="empty">
    <div class="icon">&#x1F682;</div>
    Click any city on the map<br>
    or search to build your trip.<br><br>
    Interesting stops along your<br>
    route will be suggested automatically.
  </div>
`;

export function renderShell(root) {
  root.innerHTML = `
    <div id="side">
      <div class="sh">
        <h1>Aetrain</h1>
        <p>Plan your European rail adventure</p>
      </div>

      <div class="stats">
        <div class="st"><b id="sv-s">0</b><small>Stops</small></div>
        <div class="st"><b id="sv-h">0h</b><small>Travel</small></div>
        <div class="st"><b id="sv-c">0</b><small>Countries</small></div>
        <div class="st"><b id="sv-d">0km</b><small>Distance</small></div>
      </div>

      <details class="filters" open>
        <summary>Map Filters</summary>
        <div class="fc">
          <div class="fg">
            <label for="f-int">Interest</label>
            <input type="range" id="f-int" min="1" max="10" value="5">
            <span class="fv" id="fv-int">5+</span>
          </div>

          <div class="fg">
            <label for="f-pop">Pop.</label>
            <input type="range" id="f-pop" min="0" max="1000" value="100" step="10">
            <span class="fv" id="fv-pop">100k+</span>
          </div>

          <div id="leg-filter" style="display:none">
            <div style="height:1px;background:#1e293b;margin:8px 0"></div>
            <div style="font-size:10px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.3px">
              Next leg from <b id="leg-from" style="color:#f59e0b">—</b>
            </div>

            <div class="fg">
              <label for="f-leg-min">Leg</label>
              <div class="dual-range">
                <input type="range" id="f-leg-min" min="0" max="1440" value="0" step="15">
                <input type="range" id="f-leg-max" min="0" max="1440" value="1440" step="15">
                <div class="dual-track"></div>
                <div class="dual-fill" id="dual-fill"></div>
              </div>
              <span class="fv" id="fv-leg" style="width:80px">0h — 24h</span>
            </div>

            <div id="leg-info" style="font-size:10px;color:#475569;font-style:italic">
              Reachable cities: —
            </div>
          </div>

          <div class="fi" id="fi-txt">Loading...</div>
        </div>
      </details>

      <div class="sb">
        <input id="sinput" type="text" placeholder="Search a city..." autocomplete="off">
        <div id="sr"></div>
      </div>

      <div id="tl">${EMPTY_TRIP_MARKUP}</div>

      <div class="actions">
        <button class="btn bd" type="button" data-action="clear-trip">Clear</button>
        <button class="btn bp" type="button" id="copyBtn" data-action="share-trip">Copy Summary</button>
      </div>
    </div>

    <div id="map"></div>

    <div id="citycount">
      Showing <b id="cc-n">0</b> / <b id="cc-t">0</b> cities
    </div>
  `;
}
