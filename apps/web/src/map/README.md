# Web Map Layer

This folder is for browser map rendering and geographic interaction.

Long-term direction:

- custom performance-oriented rendering
- dense network and city layers rendered without thousands of DOM-like objects
- separation between camera/input handling and visual drawing

The renderer should consume compact runtime data and precomputed engine output.
