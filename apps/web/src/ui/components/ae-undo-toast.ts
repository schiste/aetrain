// Floating "Undo" toast shown after a stop is removed from the trip.
// Triggered via the `aetrain:request-undo-toast` CustomEvent dispatched
// on document — the trip-list fires it after a successful removeStop;
// the toast captures the (name, index) tuple and offers a 5s window to
// restore the stop via store.insertStop. After the window expires the
// toast fades out and the captured state is discarded.

import { createDiagnostics, summarizeError } from "../../app-shell/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";
import { tryUseAppContext } from "../runtime/context.ts";
import { signal } from "../runtime/signal.ts";

const diagnostics = createDiagnostics("web/ui/undo-toast");

export const UNDO_TOAST_EVENT = "aetrain:request-undo-toast";
export const UNDO_TOAST_WINDOW_MS = 5000;

export interface UndoToastEventDetail {
  cityName: string;
  index: number;
}

interface PendingUndo {
  cityName: string;
  index: number;
  // Monotonic id used so a fresh removal cancels any older timer
  // without leaking — the timer's first action is to check that the
  // current pending id still matches.
  id: number;
}

defineComponent("ae-undo-toast", (host) => {
  // role="status" + aria-live="polite" announces the toast text to
  // screen readers as it appears, matching the affordance the toast
  // gives sighted users. polite (not assertive) avoids interrupting
  // ongoing announcements from the trip list.
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-atomic", "true");

  const pending = signal<PendingUndo | null>(null);
  let nextId = 0;
  let dismissTimerId = 0;

  function clearDismissTimer(): void {
    if (dismissTimerId) {
      window.clearTimeout(dismissTimerId);
      dismissTimerId = 0;
    }
  }

  function dismiss(reason: string): void {
    const current = pending.peek();
    if (!current) return;
    diagnostics.debug("dismissing undo toast", {
      reason,
      city_name: current.cityName,
      index: current.index
    });
    pending.set(null);
    clearDismissTimer();
  }

  function handleRequest(event: Event): void {
    const custom = event as CustomEvent<UndoToastEventDetail | undefined>;
    const detail = custom.detail;
    if (!detail || typeof detail.cityName !== "string" || typeof detail.index !== "number") {
      diagnostics.warn("ignored malformed undo-toast request", {
        detail_keys: detail ? Object.keys(detail) : null
      });
      return;
    }
    const id = nextId;
    nextId += 1;
    pending.set({ cityName: detail.cityName, index: detail.index, id });
    diagnostics.info("queued undo toast", {
      city_name: detail.cityName,
      index: detail.index,
      window_ms: UNDO_TOAST_WINDOW_MS,
      toast_id: id
    });

    clearDismissTimer();
    dismissTimerId = window.setTimeout(() => {
      const current = pending.peek();
      if (current && current.id === id) {
        dismiss("timeout");
      }
    }, UNDO_TOAST_WINDOW_MS);
  }

  document.addEventListener(UNDO_TOAST_EVENT, handleRequest);

  return {
    render() {
      const current = pending();
      if (!current) {
        host.removeAttribute("data-visible");
        return html``;
      }
      const ctx = tryUseAppContext();
      host.setAttribute("data-visible", "true");

      const onUndo = (): void => {
        if (!ctx) {
          diagnostics.warn("undo clicked with no app context attached");
          dismiss("no-context");
          return;
        }
        diagnostics.info("undo requested", {
          city_name: current.cityName,
          index: current.index
        });
        void ctx.store
          .insertStop(current.index, current.cityName)
          .catch((error: unknown) => {
            diagnostics.error("insertStop failed during undo", {
              error: summarizeError(error)
            });
          });
        dismiss("user-undo");
      };

      const onClose = (): void => {
        dismiss("user-dismiss");
      };

      return html`
        <div class="undo-toast">
          <span class="msg">Removed ${current.cityName}</span>
          <button
            class="undo-btn"
            type="button"
            onclick=${onUndo}
            aria-label=${`Undo removing ${current.cityName}`}
          >Undo</button>
          <button
            class="dismiss-btn"
            type="button"
            onclick=${onClose}
            aria-label="Dismiss undo toast"
          >×</button>
        </div>
      `;
    },
    dispose() {
      document.removeEventListener(UNDO_TOAST_EVENT, handleRequest);
      clearDismissTimer();
    }
  };
});
