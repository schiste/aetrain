# Web Map Layer

This folder is for browser map rendering and geographic interaction.

Long-term direction:

- custom performance-oriented rendering
- dense network and city layers rendered without thousands of DOM-like objects
- separation between camera/input handling and visual drawing
- Leaflet can remain the camera and interaction shell while rendering moves to
  canvas or WebGL surfaces behind a stable map API

The renderer should consume compact runtime data and precomputed engine output.
