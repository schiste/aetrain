# Web Map Layer

This folder is for browser map rendering and geographic interaction.

Long-term direction:

- custom performance-oriented rendering
- dense network and city layers rendered without thousands of DOM-like objects
- separation between camera/input handling and visual drawing
- Leaflet can remain the camera and interaction shell while rendering moves to
  canvas or WebGL surfaces behind a stable map API

Current web renderer rules:

- schedule redraws onto animation frames instead of rendering immediately from
  event handlers
- keep explicit invalidation between network, route, city, and label layers
- cull work to the viewport and apply level-of-detail rules by zoom
- pool DOM labels instead of recreating them every redraw
- use a dedicated hit-testing structure instead of scanning every rendered city

The renderer should consume compact runtime data and precomputed engine output.
