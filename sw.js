// Ayers Aquariums service worker: caches the app shell so it opens fast.
// Data always comes live from the server and is never cached here.
const CACHE = "aa-shell-v24";
const SHELL = ["./", "index.html", "styles.css?v=14", "app.js?v=14", "config.js?v=14", "manifest.webmanifest",
               "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  // Only same-origin GETs (the app shell). API calls, Google sign-in and images pass straight through.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("version.json")) return;   // always straight from the network
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html")))
  );
});
