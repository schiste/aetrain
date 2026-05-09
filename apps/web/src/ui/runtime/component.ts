// `defineComponent` wires a custom-element class to a factory that returns a
// `render` function. The factory runs once per instance (on first
// connectedCallback). The render function is registered as an effect so any
// signals it reads will trigger re-renders. Cleanup runs on
// disconnectedCallback.
//
// Light-DOM only: rendered nodes go directly into the host element so
// existing #-id and CSS-class-based selectors (Playwright, the Leaflet
// surface, the URL state binding) keep working. No Shadow DOM.

import { effect } from "./signal.ts";

export interface ComponentLifecycle {
  /**
   * Render the component's children. Called eagerly the first time the
   * element connects, then again whenever a signal it reads has changed.
   * Should return a DocumentFragment (typically built with the `html`
   * helper) — the host's previous children are replaced with it.
   *
   * Returning `null` skips the render (use this for "no change" guards).
   */
  render: () => DocumentFragment | null;
  /**
   * Optional teardown hook — called from disconnectedCallback after the
   * effect subscription is torn down.
   */
  dispose?: () => void;
}

export type ComponentFactory<T extends HTMLElement = HTMLElement> = (
  host: T
) => ComponentLifecycle;

interface ComponentInstance {
  stopEffect: () => void;
  dispose?: () => void;
}

const COMPONENT_INSTANCES = new WeakMap<HTMLElement, ComponentInstance>();

export function defineComponent<T extends HTMLElement = HTMLElement>(
  tag: string,
  factory: ComponentFactory<T>
): CustomElementConstructor {
  if (customElements.get(tag)) {
    return customElements.get(tag) as CustomElementConstructor;
  }

  class Component extends HTMLElement {
    private __lifecycle: ComponentLifecycle | null = null;

    connectedCallback(): void {
      if (!this.__lifecycle) {
        this.__lifecycle = factory(this as unknown as T);
      }
      const lifecycle = this.__lifecycle;
      const stopEffect = effect(() => {
        const fragment = lifecycle.render();
        if (fragment === null) {
          return;
        }
        // Replace existing children atomically. Cheap because each render is
        // a fresh fragment built from the cached template.
        this.replaceChildren(fragment);
      });

      COMPONENT_INSTANCES.set(this, {
        stopEffect,
        dispose: lifecycle.dispose
      });
    }

    disconnectedCallback(): void {
      const instance = COMPONENT_INSTANCES.get(this);
      if (!instance) {
        return;
      }
      COMPONENT_INSTANCES.delete(this);
      instance.stopEffect();
      instance.dispose?.();
    }
  }

  customElements.define(tag, Component);
  return Component;
}
