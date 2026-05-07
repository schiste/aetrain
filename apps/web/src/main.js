import { mountLegacyApp } from "./legacy/app.js";

const root = document.querySelector("#app");

if (!(root instanceof HTMLDivElement)) {
  throw new Error("Expected #app root element");
}

mountLegacyApp(root);
