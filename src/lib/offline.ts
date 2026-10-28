import { useEffect, useState } from "react";
import type { LatLng } from "./geo";
import { reportError } from "./report";

/** Registers the service worker (production only: in dev it would cache stale code). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => reportError(e, "service-worker", "warn"));
  });
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, []);
  return online;
}

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** "Install the app" when the browser offers it (Chrome, Edge, Android); iOS gets instructions instead. */
export function useInstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const standalone = typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone;
  useEffect(() => {
    const grab = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    const done = () => setEvent(null);
    addEventListener("beforeinstallprompt", grab);
    addEventListener("appinstalled", done);
    return () => {
      removeEventListener("beforeinstallprompt", grab);
      removeEventListener("appinstalled", done);
    };
  }, []);
  return {
    canInstall: !!event,
    ios,
    standalone,
    install: async () => {
      if (!event) return false;
      await event.prompt();
      const { outcome } = await event.userChoice;
      setEvent(null);
      return outcome === "accepted";
    },
  };
}

// ── Map tiles along a route, for use without network ────────────────────────

const tileX = (lng: number, z: number) => Math.floor(((lng + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
};

/** Tiles covering the route and a margin around it, for each zoom from `minZoom` to `maxZoom`. */
export function tilesAlong(track: LatLng[], minZoom: number, maxZoom: number, margin = 1): { z: number; x: number; y: number }[] {
  const out = new Map<string, { z: number; x: number; y: number }>();
  for (let z = minZoom; z <= maxZoom; z++) {
    // Sample often enough that no tile along the way is skipped
    const step = Math.max(1, Math.floor(track.length / 4000));
    let prev: LatLng | null = null;
    const visit = (p: LatLng) => {
      const x = tileX(p[1], z);
      const y = tileY(p[0], z);
      for (let dx = -margin; dx <= margin; dx++)
        for (let dy = -margin; dy <= margin; dy++) out.set(`${z}/${x + dx}/${y + dy}`, { z, x: x + dx, y: y + dy });
    };
    for (let i = 0; i < track.length; i += step) {
      const p = track[i];
      if (prev) {
        // Fill long straight legs
        const n = Math.ceil(Math.max(Math.abs(tileX(p[1], z) - tileX(prev[1], z)), Math.abs(tileY(p[0], z) - tileY(prev[0], z))));
        for (let k = 1; k < n; k++) visit([prev[0] + ((p[0] - prev[0]) * k) / n, prev[1] + ((p[1] - prev[1]) * k) / n]);
      }
      visit(p);
      prev = p;
    }
    if (track.length) visit(track[track.length - 1]);
  }
  return [...out.values()];
}

/** Same URL Leaflet asks for that tile, so the cached copy is found again. */
export function tileUrl(template: string, t: { z: number; x: number; y: number }, subdomains = "abc") {
  const s = subdomains[Math.abs(t.x + t.y) % subdomains.length];
  return template
    .replace("{s}", s)
    .replace("{z}", String(t.z))
    .replace("{x}", String(t.x))
    .replace("{y}", String(t.y))
    .replace("{r}", devicePixelRatio > 1 ? "@2x" : "");
}

/** Asks the service worker to store these tiles; resolves with how many could not be fetched. */
export function cacheTiles(urls: string[], onProgress: (done: number, total: number) => void): Promise<{ failed: number }> {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return reject(new Error("Rechargez la page une fois pour activer la carte hors ligne."));
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      const { done, total, failed, finished } = e.data;
      onProgress(done, total);
      if (finished) resolve({ failed });
    };
    sw.postMessage({ type: "cache-tiles", urls }, [channel.port2]);
  });
}
