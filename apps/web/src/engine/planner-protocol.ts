export const PLANNER_WORKER_MESSAGE_TYPES = Object.freeze({
  INITIALIZE: "planner/initialize",
  DERIVE_TRIP: "planner/derive-trip",
  SEARCH_CITIES: "planner/search-cities"
});

export function serializePlannerError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}

export function deserializePlannerError(error) {
  if (!error) {
    return new Error("Unknown planner error");
  }

  const restored = new Error(error.message || "Unknown planner error");
  restored.name = error.name || "Error";
  if (error.stack) {
    restored.stack = error.stack;
  }
  return restored;
}
