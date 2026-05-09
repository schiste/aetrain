/**
 * Aetrain service worker — Phase 3 deliverable.
 *
 * Cache strategy:
 *   - cache-first for /assets/<hash>.{js,css,wasm} — Vite emits content-
 *     hashed filenames so entries are immutable for their lifetime.
 *   - cache-first for /data/<dataset_version>/... — production dataset
 *     artifacts are versioned via meta.dataset_version. Old data caches
 *     are pruned on activate (and on dataset_version change pings from
 *     the page; see "DATASET_VERSION" message handler below).
 *   - network-first for index.html — users always get the latest shell so
 *     a deploy never strands them on a cached HTML referencing pruned
 *     assets.
 *   - default for everything else — leave it to the network.
 *
 * The file is plain JS on purpose: it must be deployable from /aetrain-sw.js
 * with no build step. Keep it self-contained.
 */

/* eslint-disable no-restricted-globals */

const SW_VERSION = "ae-sw-v1";
const ASSET_CACHE = `${SW_VERSION}::assets`;
const HTML_CACHE = `${SW_VERSION}::html`;
const DATA_CACHE_PREFIX = `${SW_VERSION}::data::`;

const SW_OWN_PREFIXES = [
  ASSET_CACHE,
  HTML_CACHE,
  DATA_CACHE_PREFIX
];

let activeDataCacheName = `${DATA_CACHE_PREFIX}initial`;

self.addEventListener("install", (event) => {
  // Activate immediately so the new SW takes over without a manual reload.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    // Drop any old SW-version caches and any data caches that don't match
    // the active dataset version (the page broadcasts the active version
    // via DATASET_VERSION; until then we keep the latest data cache).
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames.map(async (name) => {
        if (!isOwnedCache(name)) {
          return;
        }
        if (name === ASSET_CACHE || name === HTML_CACHE) {
          return;
        }
        if (name === activeDataCacheName) {
          return;
        }
        if (name.startsWith(DATA_CACHE_PREFIX)) {
          // Will be pruned on the next DATASET_VERSION ping.
          return;
        }
        await caches.delete(name);
      })
    );
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "DATASET_VERSION" && typeof data.version === "string") {
    const next = `${DATA_CACHE_PREFIX}${data.version}`;
    if (next !== activeDataCacheName) {
      activeDataCacheName = next;
      event.waitUntil(pruneStaleDataCaches(next));
    }
  } else if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Only handle same-origin requests. Leaflet CDN, Google fonts, etc. fall
  // through to the network without us caching them.
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isAssetRequest(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (isDataRequest(url)) {
    event.respondWith(cacheFirst(request, activeDataCacheName));
    return;
  }

  if (isHtmlNavigation(request, url)) {
    event.respondWith(networkFirst(request, HTML_CACHE));
    return;
  }
});

function isOwnedCache(name) {
  for (const prefix of SW_OWN_PREFIXES) {
    if (name === prefix || name.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function isAssetRequest(url) {
  return url.pathname.startsWith("/assets/");
}

function isDataRequest(url) {
  return url.pathname.startsWith("/data/");
}

function isHtmlNavigation(request, url) {
  if (request.mode === "navigate") {
    return true;
  }
  if (request.destination === "document") {
    return true;
  }
  // Treat the bare root and explicit index.html requests as the shell.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return true;
  }
  return false;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type !== "opaque") {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (error) {
    // Last resort: surface a useful 504 instead of throwing into the page.
    return new Response("Service unavailable", {
      status: 504,
      statusText: "Gateway Timeout",
      headers: { "Content-Type": "text/plain" }
    });
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function pruneStaleDataCaches(keepName) {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames.map(async (name) => {
      if (name.startsWith(DATA_CACHE_PREFIX) && name !== keepName) {
        await caches.delete(name);
      }
    })
  );
}
