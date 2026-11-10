// ── YoEcho Service Worker ─────────────────────────────────────────────────────
// v8 — bumped for the body-language update (gestures, hands, expressions). The face files (/echo-face.js, /vendor/*, /avatars/*) are
// downloaded the first time someone opens Face to face, then cached by the cache-first rule
// below so the face keeps working offline. They are not precached, to save mobile data.
const CACHE_NAME = "yoecho-pwa-v23";

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

// ── Push notifications (reminders + check-ins) ───────────────────────────────
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : "" }; }
  const title = d.title || "YoEcho";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // if YoEcho is open and in front, show it inside the app instead of as a system notification
    if (wins.some((c) => c.visibilityState === "visible") && d.kind !== "test") { wins.forEach((c) => c.postMessage({ type: "echo-push", data: d })); return; }
    await self.registration.showNotification(title, {
      body: d.body || "I have something for you.", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      tag: d.tag || d.kind || "yoecho", renotify: true, vibrate: [90, 40, 90], data: d,
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins[0];
    if (w) { try { await w.focus(); } catch (e) {} w.postMessage({ type: "echo-push-open", data: d }); return; }
    await self.clients.openWindow("/?from=push&kind=" + encodeURIComponent(d.kind || ""));
  })());
});
