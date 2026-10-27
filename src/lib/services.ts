import { eleAt, haversine, type LatLng, type ProfilePoint } from "./geo";
import { openMeteoBlockedUntil } from "./weather";

export type RoutingProfile = "trails" | "roads";

export interface Nogo {
  lat: number;
  lng: number;
  radius: number;
}

export interface LegResult {
  coords: LatLng[];
  /** Set when the preferred engine failed and another one was used. */
  degraded?: "no-avoid" | "fallback";
}

/**
 * Cost added when the route crosses one of the "nogo" circles. Being a cost
 * rather than a hard block, BRouter can still reuse a path when there is truly
 * no other way (dead-end valley, single bridge…).
 */
const NOGO_WEIGHT = 800;

async function brouter(a: LatLng, b: LatLng, nogos: Nogo[], signal?: AbortSignal): Promise<LatLng[]> {
  let url =
    `https://brouter.de/brouter?lonlats=${a[1].toFixed(6)},${a[0].toFixed(6)}|${b[1].toFixed(6)},${b[0].toFixed(6)}` +
    `&profile=hiking-mountain&alternativeidx=0&format=geojson`;
  if (nogos.length) {
    url += `&nogos=${nogos.map((n) => `${n.lng.toFixed(5)},${n.lat.toFixed(5)},${Math.round(n.radius)},${NOGO_WEIGHT}`).join("|")}`;
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`BRouter HTTP ${res.status}`);
  const json = await res.json();
  const coords = json.features?.[0]?.geometry?.coordinates as number[][] | undefined;
  if (!coords?.length) throw new Error("Aucun itinéraire");
  return [a, ...coords.map(([lng, lat]) => [lat, lng] as LatLng), b];
}

async function osrm(a: LatLng, b: LatLng, signal?: AbortSignal): Promise<LatLng[]> {
  const coords = `${a[1]},${a[0]};${b[1]},${b[0]}`;
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?overview=full&geometries=geojson`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Routing HTTP ${res.status}`);
  const json = await res.json();
  const route = json.routes?.[0];
  if (!route) throw new Error("Aucun itinéraire");
  const line: LatLng[] = route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]);
  // Glue the snapped line to the exact clicked points so legs connect cleanly.
  return [a, ...line, b];
}

/**
 * Routes a leg on foot. "trails" uses BRouter's hiking profile (prefers paths
 * and footways), "roads" uses OSRM foot. Avoiding already-used paths needs
 * BRouter's nogo areas. Each engine falls back on the other one.
 */
export async function routeLeg(
  a: LatLng,
  b: LatLng,
  opts: { profile: RoutingProfile; nogos: Nogo[] },
  signal?: AbortSignal,
): Promise<LegResult> {
  if (opts.nogos.length) {
    try {
      return { coords: await brouter(a, b, opts.nogos, signal) };
    } catch {
      /* fall through: route without avoidance */
    }
    const r = await routeLeg(a, b, { profile: opts.profile, nogos: [] }, signal);
    return { coords: r.coords, degraded: "no-avoid" };
  }
  const [first, second] =
    opts.profile === "trails" ? [() => brouter(a, b, [], signal), () => osrm(a, b, signal)] : [() => osrm(a, b, signal), () => brouter(a, b, [], signal)];
  try {
    return { coords: await first() };
  } catch {
    return { coords: await second(), degraded: "fallback" };
  }
}

// ── Elevation ───────────────────────────────────────────────────────────────
// Elevations are read from "Terrarium" terrain tiles (AWS open data, ~30 m
// SRTM/Copernicus mosaic): a handful of PNG tiles cover a whole route and there
// is no rate limit. Open-Meteo is only a fallback, with few points, because it
// counts every location as a separate API call.

const TERRARIUM = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const tileCache = new Map<string, Promise<Uint8ClampedArray>>();

function loadTile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
  const k = `${z}/${x}/${y}`;
  let p = tileCache.get(k);
  if (!p) {
    p = new Promise<Uint8ClampedArray>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256).data);
      };
      img.onerror = () => reject(new Error(`Tuile d'altitude ${k} indisponible`));
      img.src = TERRARIUM(z, x, y);
    });
    p.catch(() => tileCache.delete(k));
    tileCache.set(k, p);
  }
  return p;
}

const terrariumAt = (d: Uint8ClampedArray, px: number, py: number) => {
  const i = (Math.min(255, Math.max(0, py)) * 256 + Math.min(255, Math.max(0, px))) * 4;
  return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
};

async function tileElevations(points: ProfilePoint[], signal?: AbortSignal): Promise<ProfilePoint[]> {
  const total = points.length ? points[points.length - 1].d : 0;
  const z = total > 80000 ? 11 : 12;
  const n = 2 ** z;
  const pos = points.map((p) => {
    const x = ((p.lng + 180) / 360) * n;
    const s = Math.sin((p.lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    return { x, y };
  });
  const needed = new Set(pos.map(({ x, y }) => `${Math.floor(x)}/${Math.floor(y)}`));
  if (needed.size > 60) throw new Error("Parcours trop étendu pour les tuiles");
  const tiles = new Map<string, Uint8ClampedArray>();
  await Promise.all(
    [...needed].map(async (k) => {
      const [x, y] = k.split("/").map(Number);
      tiles.set(k, await loadTile(z, x, y));
    }),
  );
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const out = points.map((p, i) => {
    const { x, y } = pos[i];
    const tile = tiles.get(`${Math.floor(x)}/${Math.floor(y)}`)!;
    // Bilinear interpolation inside the tile
    const fx = (x - Math.floor(x)) * 256 - 0.5;
    const fy = (y - Math.floor(y)) * 256 - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const e =
      terrariumAt(tile, x0, y0) * (1 - tx) * (1 - ty) +
      terrariumAt(tile, x0 + 1, y0) * tx * (1 - ty) +
      terrariumAt(tile, x0, y0 + 1) * (1 - tx) * ty +
      terrariumAt(tile, x0 + 1, y0 + 1) * tx * ty;
    return { ...p, ele: Math.round(e * 10) / 10 };
  });
  // A broken or placeholder tile decodes to nonsense heights: let the caller fall back.
  if (out.some((p) => p.ele! < -450 || p.ele! > 8900)) throw new Error("Tuile d'altitude invalide");
  return out;
}

let lastOpenMeteoElevation = 0;

async function openMeteoElevations(points: ProfilePoint[], signal?: AbortSignal): Promise<ProfilePoint[]> {
  // Open-Meteo counts every location as one API call and shares that quota with
  // the weather forecast: only 25 points, at most once a minute, never while
  // the forecast is rate-limited.
  if (Date.now() < openMeteoBlockedUntil() || Date.now() - lastOpenMeteoElevation < 60_000) {
    throw new Error("Altitudes indisponibles");
  }
  lastOpenMeteoElevation = Date.now();
  const step = Math.max(1, Math.ceil(points.length / 25));
  const picked = points.filter((_, i) => i % step === 0 || i === points.length - 1).slice(0, 26);
  const lat = picked.map((p) => p.lat.toFixed(5)).join(",");
  const lng = picked.map((p) => p.lng.toFixed(5)).join(",");
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, { signal });
  if (!res.ok) throw new Error(`Altitudes HTTP ${res.status}`);
  const eles = (await res.json()).elevation as number[];
  const known = picked.map((p, i) => ({ ...p, ele: eles[i] }));
  return points.map((p) => ({ ...p, ele: eleAt(known, p.d) }));
}

export async function fetchElevations(points: ProfilePoint[], signal?: AbortSignal): Promise<ProfilePoint[]> {
  try {
    return await tileElevations(points, signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return openMeteoElevations(points, signal);
  }
}

export interface Place {
  name: string;
  detail: string;
  lat: number;
  lng: number;
}

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=fr&q=${encodeURIComponent(q)}`,
    { signal },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { display_name: string; name: string; lat: string; lon: string }[];
  return json.map((r) => {
    const parts = r.display_name.split(", ");
    return {
      name: r.name || parts[0],
      detail: parts.slice(1, 4).join(", "),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    };
  });
}

export interface OsmPoi {
  id: number;
  lat: number;
  lng: number;
  kind: "water" | "hut" | "shelter" | "peak" | "view" | "toilets";
  name: string;
  ele?: number;
}

/** Useful hiking/running amenities from OpenStreetMap inside a bounding box. */
export async function fetchOsmPois(south: number, west: number, north: number, east: number, signal?: AbortSignal): Promise<OsmPoi[]> {
  const bb = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
  const q = `[out:json][timeout:25];(
node["amenity"="drinking_water"](${bb});
node["natural"="spring"]["drinking_water"="yes"](${bb});
node["tourism"~"^(alpine_hut|wilderness_hut)$"](${bb});
node["amenity"="shelter"](${bb});
node["natural"="peak"]["name"](${bb});
node["tourism"="viewpoint"](${bb});
node["amenity"="toilets"](${bb});
);out body 400;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: new URLSearchParams({ data: q }),
    signal,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = (await res.json()) as { elements: { id: number; lat: number; lon: number; tags?: Record<string, string> }[] };
  return json.elements.map((e) => {
    const t = e.tags ?? {};
    const kind: OsmPoi["kind"] =
      t.amenity === "drinking_water" || t.natural === "spring"
        ? "water"
        : t.tourism === "alpine_hut" || t.tourism === "wilderness_hut"
          ? "hut"
          : t.amenity === "shelter"
            ? "shelter"
            : t.natural === "peak"
              ? "peak"
              : t.tourism === "viewpoint"
                ? "view"
                : "toilets";
    const ele = t.ele ? parseFloat(t.ele) : undefined;
    return { id: e.id, lat: e.lat, lng: e.lon, kind, name: t.name ?? "", ele: ele && isFinite(ele) ? ele : undefined };
  });
}

// ── Waymarked trails (OpenStreetMap hiking relations) ────────────────────────

export interface Trail {
  id: number;
  name: string;
  ref: string;
  /** GR, GRP, PR or Trail, from the OSM network / route tags. */
  kind: "GR" | "GRP" | "PR" | "Trail" | "Rando";
  /** Distance announced by the route itself, in meters (not always present). */
  distance: number | null;
  loop: boolean;
  description: string;
  operator: string;
  /** Bounding box diagonal, in meters: very large ones are multi-day routes. */
  span: number;
  center: LatLng;
}

function parseDistance(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.replace(",", ".").match(/([\d.]+)\s*(km|m|mi)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "km").toLowerCase();
  return unit === "m" ? n : unit === "mi" ? n * 1609.34 : n * 1000;
}

/** Waymarked walking routes whose extent intersects the box. */
export async function fetchTrails(south: number, west: number, north: number, east: number, signal?: AbortSignal): Promise<Trail[]> {
  const bb = `${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`;
  const q = `[out:json][timeout:25];relation["type"="route"]["route"~"^(hiking|foot|running)$"](${bb});out tags bb 150;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }), signal });
  if (!res.ok) throw new Error(res.status === 429 ? "Serveur de randonnées saturé, réessayez dans une minute" : `Erreur ${res.status}`);
  const json = (await res.json()) as {
    elements: { id: number; tags?: Record<string, string>; bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number } }[];
  };
  return json.elements
    .filter((e) => e.tags && (e.tags.name || e.tags.ref))
    .map((e) => {
      const t = e.tags!;
      const b = e.bounds;
      const net = t.network ?? "";
      const kind: Trail["kind"] =
        t.route === "running" ? "Trail" : net === "iwn" || net === "nwn" ? "GR" : net === "rwn" ? "GRP" : net === "lwn" ? "PR" : "Rando";
      const span = b ? haversine([b.minlat, b.minlon], [b.maxlat, b.maxlon]) : 0;
      return {
        id: e.id,
        name: t.name ?? t.ref ?? "",
        ref: t.ref ?? "",
        kind,
        distance: parseDistance(t.distance),
        loop: t.roundtrip === "yes",
        description: t.description ?? t["description:fr"] ?? "",
        operator: t.operator ?? "",
        span,
        center: b ? [(b.minlat + b.maxlat) / 2, (b.minlon + b.maxlon) / 2] : [0, 0],
      } satisfies Trail;
    });
}

/**
 * Geometry of one route, stitched into a single line. Relation members come in
 * route order but each way may be drawn in either direction, and alternatives
 * or short gaps are common: ways are chained end to end (flipping when
 * needed) and the longest continuous chain is kept.
 */
export async function fetchTrailGeometry(id: number, signal?: AbortSignal): Promise<LatLng[]> {
  const q = `[out:json][timeout:60];relation(${id});out geom;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }), signal });
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  const json = (await res.json()) as {
    elements: { members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[] }[];
  };
  const skip = /alternative|excursion|approach|connection|link/;
  const ways = (json.elements[0]?.members ?? [])
    .filter((m) => m.type === "way" && m.geometry && m.geometry.length > 1 && !skip.test(m.role))
    .map((m) => m.geometry!.map((g) => [g.lat, g.lon] as LatLng));
  if (!ways.length) throw new Error("Tracé introuvable pour cette randonnée");
  const chains: LatLng[][] = [];
  let cur: LatLng[] = [];
  for (const w of ways) {
    if (!cur.length) {
      cur = w.slice();
      continue;
    }
    const end = cur[cur.length - 1];
    const start = cur[0];
    const options = [
      { d: haversine(end, w[0]), apply: () => cur.push(...w.slice(1)) },
      { d: haversine(end, w[w.length - 1]), apply: () => cur.push(...w.slice(0, -1).reverse()) },
      // The very first way may itself be reversed
      ...(cur.length === ways[0].length
        ? [
            { d: haversine(start, w[0]), apply: () => (cur = [...cur.slice().reverse(), ...w.slice(1)]) },
            { d: haversine(start, w[w.length - 1]), apply: () => (cur = [...cur.slice().reverse(), ...w.slice(0, -1).reverse()]) },
          ]
        : []),
    ];
    const best = options.reduce((a, b) => (b.d < a.d ? b : a));
    if (best.d < 300) best.apply();
    else {
      chains.push(cur);
      cur = w.slice();
    }
  }
  chains.push(cur);
  const length = (c: LatLng[]) => c.reduce((s, p, i) => (i ? s + haversine(c[i - 1], p) : 0), 0);
  return chains.reduce((a, b) => (length(b) > length(a) ? b : a));
}
