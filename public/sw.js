// GPX Studio service worker: the app opens without network, and map tiles
// already seen (or downloaded for a route) stay available in the field.
//
// - Pages: network first, the cached copy when offline.
// - Built files (/assets/…, hashed names): cache first, they never change.
// - Map and terrain tiles: cache first, at most MAX_TILES kept.
// - Everything else (routing, weather, reports…) is left to the network.

const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const TILES = "tiles-v1";
const MAX_TILES = 4000;
const MAX_ASSETS = 80;

const TILE_HOSTS = [
  "tile.opentopomap.org",
  "basemaps.cartocdn.com",
  "server.arcgisonline.com",
  "data.geopf.fr",
  "tile.waymarkedtrails.org",
  "elevation-tiles-prod",
];

const isTile = (url) => TILE_HOSTS.some((h) => url.hostname.includes(h) || url.pathname.includes(h));

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // The app page and the files it links to, so the next visit works offline
      for (const page of ["./app.html", "./"]) {
        try {
          const res = await fetch(page, { cache: "no-cache" });
          if (!res.ok) continue;
          await cache.put(page, res.clone());
          const html = await res.text();
          const files = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|svg|png|woff2|webmanifest))"/g)].map((m) => new URL(m[1], self.registration.scope).href);
          const assets = await caches.open(ASSETS);
          await Promise.all(files.map((f) => assets.add(f).catch(() => {})));
          // Parts of the app loaded on demand are only named inside the scripts
          for (const js of files.filter((f) => f.endsWith(".js"))) {
            const text = await (await assets.match(js))?.text();
            const parts = [...new Set([...(text ?? "").matchAll(/["'`]\.\/([\w.-]+\.(?:js|css))["'`]/g)].map((m) => new URL(m[1], js).href))];
            await Promise.all(parts.map((f) => assets.add(f).catch(() => {})));
          }
          // Fonts are only named inside the stylesheets
          for (const css of files.filter((f) => f.endsWith(".css"))) {
            const text = await (await assets.match(css))?.text();
            const fonts = [...(text ?? "").matchAll(/url\(([^)]+\.woff2)\)/g)].map((m) => new URL(m[1].replace(/["']/g, ""), css).href);
            // Latin only: the other alphabets are rarely needed
            await Promise.all(fonts.filter((f) => /latin-(?!ext)/.test(f)).map((f) => assets.add(f).catch(() => {})));
          }
        } catch {
          /* offline during install: the next visit will fill the cache */
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL, ASSETS, TILES];
      for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  // Oldest first: drop a tenth at once so trimming stays rare
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max + Math.floor(max / 10)).map((k) => cache.delete(k)));
}

let tileWrites = 0;

async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") {
    await cache.put(request, res.clone());
    if (++tileWrites % 200 === 0) trim(TILES, MAX_TILES);
  }
  return res;
}

async function asset(request) {
  const cache = await caches.open(ASSETS);
  // Module scripts are fetched with an Origin header, the precached copy without: ignore Vary
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    trim(ASSETS, MAX_ASSETS);
  }
  return res;
}

async function page(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(new URL(request.url).pathname.endsWith("/") ? "./" : request, res.clone());
    return res;
  } catch {
    const url = new URL(request.url);
    return (
      (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
      (await cache.match(url.pathname.endsWith("/") ? "./" : "./app.html", { ignoreVary: true })) ||
      new Response("<h1>Hors ligne</h1><p>Reconnectez-vous pour ouvrir GPX Studio une première fois.</p>", {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    );
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes("/api/")) return;
    if (request.mode === "navigate") return event.respondWith(page(request));
    if (url.pathname.includes("/assets/") || /\.(svg|png|webmanifest|woff2?)$/.test(url.pathname)) return event.respondWith(asset(request));
    return;
  }
  if (isTile(url)) event.respondWith(tile(request).catch(() => new Response("", { status: 504 })));
});

// Tiles of a route, downloaded on request from the app ("carte hors ligne")
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "cache-tiles" || !Array.isArray(data.urls)) return;
  const port = event.ports[0];
  event.waitUntil(
    (async () => {
      const cache = await caches.open(TILES);
      let done = 0;
      let failed = 0;
      const queue = data.urls.slice();
      const worker = async () => {
        while (queue.length) {
          const u = queue.shift();
          try {
            const req = new Request(u, { mode: "cors", credentials: "omit" });
            if (!(await cache.match(req, { ignoreVary: true }))) {
              const res = await fetch(req);
              if (res.ok) await cache.put(req, res);
              else failed++;
            }
          } catch {
            failed++;
          }
          done++;
          if (done % 10 === 0 || !queue.length) port?.postMessage({ done, failed, total: data.urls.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      port?.postMessage({ done, failed, total: data.urls.length, finished: true });
      trim(TILES, MAX_TILES);
    })(),
  );
});
