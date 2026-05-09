import type { SummarizedError } from "../types/diagnostics.ts";

export const PLANNER_WORKER_MESSAGE_TYPES = Object.freeze({
  INITIALIZE: "planner/initialize",
  DERIVE_TRIP: "planner/derive-trip",
  SEARCH_CITIES: "planner/search-cities"
} as const);

export type PlannerWorkerMessageType =
  (typeof PLANNER_WORKER_MESSAGE_TYPES)[keyof typeof PLANNER_WORKER_MESSAGE_TYPES];

export interface PlannerWorkerRequest<TPayload = unknown> {
  type: PlannerWorkerMessageType;
  requestId: string;
  payload: TPayload;
}

export type PlannerWorkerResponse<TPayload = unknown> =
  | {
      ok: true;
      requestId: string;
      payload: TPayload;
    }
  | {
      ok: false;
      requestId: string;
      error: SummarizedError;
    };

export function serializePlannerError(error: unknown): SummarizedError {
  if (!error || typeof error !== "object") {
    return {
      name: "Error",
      message: error == null ? "Unknown error" : String(error),
      stack: null
    };
  }

  const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "Error",
    message:
      typeof candidate.message === "string" ? candidate.message : String(error),
    stack: typeof candidate.stack === "string" ? candidate.stack : null
  };
}

export function deserializePlannerError(
  error: SummarizedError | null | undefined
): Error {
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
