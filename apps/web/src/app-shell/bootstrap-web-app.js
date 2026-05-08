import { mountLegacyApp } from "../legacy/app.js";

export async function bootstrapWebApp() {
  const root = document.querySelector("#app");

  if (!(root instanceof HTMLDivElement)) {
    throw new Error("Expected #app root element");
  }

  await mountLegacyApp(root);
}
