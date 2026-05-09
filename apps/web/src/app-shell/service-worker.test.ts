// Tests for the service-worker registration shim. Runs under node --test
// with no DOM — the module is designed to defensively skip when the
// serviceWorker API isn't present, so we exercise that path plus a
// stubbed-API path that captures the messages it would send.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureServiceWorker,
  notifyServiceWorkerDatasetVersion
} from "./service-worker.ts";

interface NavStub {
  serviceWorker?: unknown;
}

interface ServiceWorkerControllerStub {
  postedMessages: unknown[];
  postMessage(message: unknown): void;
}

interface RegistrationStub {
  active: ServiceWorkerControllerStub | null;
  scope: string;
  unregister(): Promise<boolean>;
}

interface ServiceWorkerContainerStub {
  controller: ServiceWorkerControllerStub | null;
  ready: Promise<RegistrationStub>;
  registered: { scope: string; url: string }[];
  unregisters: number;
  getRegistration(): Promise<RegistrationStub | undefined>;
  getRegistrations(): Promise<RegistrationStub[]>;
  register(url: string, options: { scope: string }): Promise<RegistrationStub>;
}

function withGlobals<T>(
  patch: { navigator?: NavStub; importMetaEnv?: { PROD: boolean } },
  fn: () => Promise<T>
): Promise<T> {
  const globalAny = globalThis as unknown as Record<string, unknown>;
  let previousDescriptor: PropertyDescriptor | undefined;
  if (patch.navigator !== undefined) {
    previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalAny, "navigator", {
      configurable: true,
      writable: true,
      enumerable: true,
      value: patch.navigator
    });
  }
  return fn().finally(() => {
    if (patch.navigator !== undefined) {
      if (previousDescriptor) {
        Object.defineProperty(globalAny, "navigator", previousDescriptor);
      } else {
        delete globalAny["navigator"];
      }
    }
  });
}

test("ensureServiceWorker no-ops when navigator.serviceWorker is unavailable", async () => {
  await withGlobals({ navigator: {} }, async () => {
    // Should not throw.
    await ensureServiceWorker();
  });
});

test("notifyServiceWorkerDatasetVersion no-ops without a version", async () => {
  await withGlobals({ navigator: {} }, async () => {
    await notifyServiceWorkerDatasetVersion(null);
    await notifyServiceWorkerDatasetVersion(undefined);
    await notifyServiceWorkerDatasetVersion("");
  });
});

test("notifyServiceWorkerDatasetVersion no-ops in non-prod env", async () => {
  // import.meta.env.PROD is false under node --test, so a present
  // navigator.serviceWorker should still result in no postMessage.
  const controller: ServiceWorkerControllerStub = {
    postedMessages: [],
    postMessage(message) {
      this.postedMessages.push(message);
    }
  };
  const registration: RegistrationStub = {
    active: controller,
    scope: "/",
    async unregister() {
      return true;
    }
  };
  const container: ServiceWorkerContainerStub = {
    controller,
    ready: Promise.resolve(registration),
    registered: [],
    unregisters: 0,
    async getRegistration() {
      return registration;
    },
    async getRegistrations() {
      return [registration];
    },
    async register(url, options) {
      this.registered.push({ url, scope: options.scope });
      return registration;
    }
  };

  await withGlobals({ navigator: { serviceWorker: container } as NavStub }, async () => {
    await notifyServiceWorkerDatasetVersion("v42");
    assert.equal(controller.postedMessages.length, 0);
  });
});

test("ensureServiceWorker unregisters leftover SWs in dev", async () => {
  const registration: RegistrationStub = {
    active: null,
    scope: "/",
    async unregister() {
      registration.active = null;
      return true;
    }
  };
  let unregisterCalls = 0;
  const tracked: RegistrationStub = {
    ...registration,
    async unregister() {
      unregisterCalls += 1;
      return true;
    }
  };
  const container: ServiceWorkerContainerStub = {
    controller: null,
    ready: Promise.resolve(tracked),
    registered: [],
    unregisters: 0,
    async getRegistration() {
      return tracked;
    },
    async getRegistrations() {
      return [tracked];
    },
    async register(url, options) {
      this.registered.push({ url, scope: options.scope });
      return tracked;
    }
  };

  await withGlobals({ navigator: { serviceWorker: container } as NavStub }, async () => {
    await ensureServiceWorker();
    // In dev we should have unregistered the leftover SW exactly once and
    // not registered a new one.
    assert.equal(unregisterCalls, 1);
    assert.equal(container.registered.length, 0);
  });
});
