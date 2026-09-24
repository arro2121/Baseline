// Baseline offline helper and notifications. The app opens instantly and still works without signal,
// showing the last ratings and scores it saw. Build: 20260924-1980592
const CACHE = "baseline-20260924-1980592";
const SHELL = ["./", "index.html", "live.json", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin && (e.request.mode === "navigate" || url.pathname.endsWith("live.json") || url.pathname.endsWith("index.html"))) {
    // fresh first: new scores and nightly ratings win, the cached copy is the offline fallback
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(url.pathname.endsWith("live.json") ? "live.json" : e.request, c)); return r; })
      .catch(() => caches.match(url.pathname.endsWith("live.json") ? "live.json" : e.request).then(r => r || caches.match("index.html"))));
    return;
  }
  // icons, fonts: cached copy first (see below)
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
    if (res.ok && (url.origin === location.origin || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com"))) { const c = res.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); }
    return res; })));
});
// Match alerts from the alerts service arrive here, even when the app is closed.
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Baseline", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Baseline", { body: d.body || "", tag: d.tag || "baseline", renotify: true,
    icon: "icon-192.png", badge: "icon-192.png", data: { url: d.url || "./?tab=watch" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.navigate(target); return c.focus(); }
    return clients.openWindow(target);
  }));
});
