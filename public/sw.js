// ── YoEcho Service Worker ─────────────────────────────────────────────────────
// v7 — bumped for the faster, gzip-packed 3D face. The face files (/echo-face.js, /vendor/*, /avatars/*) are
// downloaded the first time someone opens Face to face, then cached by the cache-first rule
// below so the face keeps working offline. They are not precached, to save mobile data.
const CACHE_NAME = "yoecho-pwa-v7";

const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // Delete ALL old caches — v1, v2, anything before v3
    caches.keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache Netlify function calls — always hit network
  if (url.pathname.startsWith("/.netlify/functions/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Never cache cross-origin (CDN scripts like React, Babel)
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => new Response("", { status: 408 })));
    return;
  }

  // Network-first for app.jsx and index.html so updates always get through
  if (url.pathname === "/index.html" || url.pathname === "/") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else (icons, manifest)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (!res || res.status !== 200) return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        return res;
      }).catch(() => {
        if (event.request.mode === "navigate") return caches.match("/index.html");
        return new Response("Offline", { status: 503 });
      });
    })
  );
});
