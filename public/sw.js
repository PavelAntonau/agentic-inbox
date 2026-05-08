// ActionNowAI Mail — App-Shell Service Worker
//
// Cache versioning scheme:
//   CACHE_VERSION is a string slug. Bump the suffix (v1 → v2) whenever
//   the precache list changes or you want existing users to download fresh
//   assets. On `activate` every cache whose name is NOT CACHE_VERSION is
//   deleted, which evicts the old shell in a single pass.
//   Do NOT rename the constant itself — the activate cleanup matches by
//   the string prefix 'anai-shell-'; rename the suffix only.
//
// Precache list (hard-coded; kept small — only the genuine app shell):
//   /            — root HTML (authenticated inbox)
//   /login       — pre-auth login page
//   /manifest.webmanifest — manifest (needed offline for installability)
//   /favicon-192.png         — icon (used by browser UI after install)
//   /favicon-512.png         — large icon (splash screen)
//   /icon-maskable-192.png   — maskable icon (Android adaptive shape)
//   /icon-maskable-512.png   — maskable icon (large)
//
// Fetch strategy:
//   HTML routes  (/login, /, /consent)  → network-first  (always try live)
//   Static assets (*.png, *.ico, *.js, *.css, *.webmanifest) → cache-first
//   Everything else → network-first, fall back to cache, then offline page
//
// Offline fallback:
//   A minimal inline HTML page is returned when both network and cache fail.
//   It tells the user to reconnect — no interactive elements.

"use strict";

const CACHE_VERSION = "anai-shell-v2";

// Minimal offline fallback HTML — inlined so it needs no network fetch.
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ActionNowAI Mail — Offline</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0;
           background: #ece8e2; color: #1a1a1a; }
    .card { text-align: center; padding: 2rem; max-width: 320px; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p  { font-size: 0.9rem; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You're offline</h1>
    <p>Please check your connection and try again.</p>
  </div>
</body>
</html>`;

// ─── Install ────────────────────────────────────────────────────────────────
// Precache the app shell. skipWaiting so the new SW activates immediately
// on first install (no waiting for existing clients to close).
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        cache.addAll([
          "/",
          "/login",
          "/manifest.webmanifest",
          "/favicon-192.png",
          "/favicon-512.png",
          "/icon-maskable-192.png",
          "/icon-maskable-512.png",
        ]),
      )
      .then(() => self.skipWaiting()),
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────
// Claim all open clients immediately and evict every cache except the
// current CACHE_VERSION.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ─── Fetch ──────────────────────────────────────────────────────────────────
// HTML routes  → network-first (stale content is bad for an inbox app)
// Static files → cache-first  (immutable hashed assets; saves bandwidth)
// Everything else → network-first with cache fallback
const HTML_ROUTES = ["/", "/login", "/consent"];

function isHtmlRoute(url) {
  const path = new URL(url).pathname;
  return HTML_ROUTES.some((r) => path === r || path === r + "/");
}

function isStaticAsset(url) {
  const path = new URL(url).pathname;
  return /\.(png|ico|jpg|jpeg|svg|webp|gif|js|css|woff2?|webmanifest)$/.test(
    path,
  );
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineFallback();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

function offlineFallback() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only intercept same-origin GET requests.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isHtmlRoute(request.url)) {
    event.respondWith(networkFirst(request));
  } else if (isStaticAsset(request.url)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});
