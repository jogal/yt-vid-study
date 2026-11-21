/* Neuro Notes service worker — オフライン用キャッシュ */
const VERSION = "__VERSION__";
const CACHE = "nn-" + VERSION;
const RUNTIME = "nn-runtime";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("nn-") && k !== CACHE && k !== RUNTIME) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => { if (e.data === "skip") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // ページ本体: キャッシュ優先（更新は新しい SW のインストールで取り込む）
  if (req.mode === "navigate") {
    e.respondWith(caches.match("index.html", { cacheName: CACHE }).then((r) => r || fetch(req)));
    return;
  }
  // 画像（ノートに貼った外部画像も含む）: 一度見たものをキャッシュ
  if (req.destination === "image") {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") (await caches.open(RUNTIME)).put(req, res.clone());
        return res;
      } catch { return new Response("", { status: 504 }); }
    })());
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
