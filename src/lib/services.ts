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
// ── Overpass (OpenStreetMap queries) ──────────────────────────────────────────
// The main public server is often busy: queries go to mirrors when it fails,
// and the last server that answered is tried first next time.

const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
let preferredServer = 0;

/** The query was too heavy for the server (it answers 200 with a "runtime error" remark). */
export class OverpassTooBig extends Error {}

/** A request to one server gives up after this long… */
const SERVER_TIMEOUT = 20000;
/** …and a whole query, all servers included, after this long. */
const QUERY_DEADLINE = 45000;

async function overpass<T>(query: string, signal?: AbortSignal): Promise<T> {
  let lastError: unknown = null;
  const started = Date.now();
  for (let i = 0; i < OVERPASS_SERVERS.length; i++) {
    const left = QUERY_DEADLINE - (Date.now() - started);
    if (left < 3000) break;
    const idx = (preferredServer + i) % OVERPASS_SERVERS.length;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(SERVER_TIMEOUT, left));
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(OVERPASS_SERVERS[idx], {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (typeof json.remark === "string" && /runtime error|timed out|out of memory/i.test(json.remark)) {
        throw new OverpassTooBig(json.remark);
      }
      preferredServer = idx;
      return json as T;
    } catch (e) {
      if (signal?.aborted) throw new DOMException("Recherche annulée", "AbortError");
      if (e instanceof OverpassTooBig) throw e;
      lastError = ctrl.signal.aborted ? new Error("délai dépassé") : e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(`Les serveurs OpenStreetMap ne répondent pas (${(lastError as Error)?.message ?? "réseau"}). Réessayez dans un instant.`);
}

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
  const json = await overpass<{ elements: { id: number; lat: number; lon: number; tags?: Record<string, string> }[] }>(q, signal);
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
  /** GR, GRP, PR or Trail, from the OSM network / route tags; Course or Marche for a trace someone shared. */
  kind: "GR" | "GRP" | "PR" | "Trail" | "Rando" | "Course" | "Marche";
  /** Distance announced by the route itself, in meters (not always present). */
  distance: number | null;
  loop: boolean;
  description: string;
  operator: string;
  /** Multi-day route (national or international network, or longer than 60 km): only its section in the area is used. */
  long: boolean;
  /** Shared by someone: who and when, shown under the name. */
  byline?: string;
  /** Page of the shared trace on openstreetmap.org. */
  link?: string;
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

type TrailElements = { elements: { id: number; tags?: Record<string, string> }[] };

export type BBox = [south: number, west: number, north: number, east: number];
const bboxString = (b: BBox) => b.map((v) => v.toFixed(4)).join(",");

/**
 * Waymarked walking routes crossing the box. Only their tags are asked for:
 * asking for their extent ("out bb") makes the server load the whole
 * geometry of every long-distance route passing by (a GR can be 2 000 km),
 * which is what made searches time out.
 */
export async function fetchTrails(box: BBox, signal?: AbortSignal): Promise<Trail[]> {
  const q = `[out:json][timeout:20];relation["type"="route"]["route"~"^(hiking|foot|running|fitness_trail)$"](${bboxString(box)});out tags 200;`;
  let json: TrailElements;
  try {
    json = await overpass<TrailElements>(q, signal);
  } catch (e) {
    if (e instanceof OverpassTooBig) throw new Error("Zone trop chargée : zoomez un peu plus puis relancez « Zone affichée ».");
    throw e;
  }
  return json.elements
    .filter((e) => e.tags && (e.tags.name || e.tags.ref))
    .map((e) => {
      const t = e.tags!;
      const net = t.network ?? "";
      const kind: Trail["kind"] =
        t.route === "running" || t.route === "fitness_trail"
          ? "Trail"
          : net === "iwn" || net === "nwn"
            ? "GR"
            : net === "rwn"
              ? "GRP"
              : net === "lwn"
                ? "PR"
                : "Rando";
      const distance = parseDistance(t.distance);
      return {
        id: e.id,
        name: t.name ?? t.ref ?? "",
        ref: t.ref ?? "",
        kind,
        distance,
        loop: t.roundtrip === "yes",
        description: t.description ?? t["description:fr"] ?? "",
        operator: t.operator ?? "",
        long: net === "iwn" || net === "nwn" || (distance ?? 0) > 60000,
      } satisfies Trail;
    });
}

type Members = { type: string; role: string; geometry?: ({ lat: number; lon: number } | null)[] }[];

/**
 * Stitches a route relation into a single line. Members come in route order
 * but each way may be drawn in either direction, and alternatives or short
 * gaps are common: ways are chained end to end (flipping when needed) and the
 * longest continuous chain is kept.
 */
function stitch(members: Members): LatLng[] | null {
  const skip = /alternative|excursion|approach|connection|link/;
  const ways = members
    .filter((m) => m.type === "way" && m.geometry && m.geometry.length > 1 && !skip.test(m.role))
    // A geometry clipped to an area may hold gaps (null points): split there
    .flatMap((m) => {
      const parts: LatLng[][] = [[]];
      for (const g of m.geometry!) {
        if (g && isFinite(g.lat)) parts[parts.length - 1].push([g.lat, g.lon]);
        else if (parts[parts.length - 1].length) parts.push([]);
      }
      return parts.filter((p) => p.length > 1);
    });
  if (!ways.length) return null;
  const chains: LatLng[][] = [];
  let cur: LatLng[] = [];
  let first = true;
  for (const w of ways) {
    if (!cur.length) {
      cur = w.slice();
      first = true;
      continue;
    }
    const end = cur[cur.length - 1];
    const start = cur[0];
    const options = [
      { d: haversine(end, w[0]), apply: () => cur.push(...w.slice(1)) },
      { d: haversine(end, w[w.length - 1]), apply: () => cur.push(...w.slice(0, -1).reverse()) },
      // The chain's very first way may itself be reversed
      ...(first
        ? [
            { d: haversine(start, w[0]), apply: () => (cur = [...cur.slice().reverse(), ...w.slice(1)]) },
            { d: haversine(start, w[w.length - 1]), apply: () => (cur = [...cur.slice().reverse(), ...w.slice(0, -1).reverse()]) },
          ]
        : []),
    ];
    const best = options.reduce((x, y) => (y.d < x.d ? y : x));
    if (best.d < 300) {
      best.apply();
      first = false;
    } else {
      chains.push(cur);
      cur = w.slice();
      first = true;
    }
  }
  chains.push(cur);
  const length = (c: LatLng[]) => c.reduce((acc, p, i) => (i ? acc + haversine(c[i - 1], p) : 0), 0);
  return chains.reduce((x, y) => (length(y) > length(x) ? y : x));
}

/** Geometry of one route, as a single line (only its part inside `clip` when given). */
export async function fetchTrailGeometry(id: number, clip?: BBox, signal?: AbortSignal): Promise<LatLng[]> {
  const lines = await fetchTrailGeometries([id], clip, signal);
  const line = lines.get(id);
  if (!line) throw new Error("Tracé introuvable pour cette randonnée");
  return line;
}

/**
 * Geometries of several routes in a single request. With `clip`, the server
 * only returns what lies inside that box, so a long-distance route costs no
 * more than its section around the user.
 */
export async function fetchTrailGeometries(ids: number[], clip?: BBox, signal?: AbortSignal): Promise<Map<number, LatLng[]>> {
  const out = new Map<number, LatLng[]>();
  if (!ids.length) return out;
  const q = `[out:json][timeout:25];relation(id:${ids.join(",")});out geom${clip ? `(${bboxString(clip)})` : ""};`;
  const json = await overpass<{ elements: { id: number; members?: Members }[] }>(q, signal);
  for (const el of json.elements) {
    const line = stitch(el.members ?? []);
    if (line && line.length > 1) out.set(el.id, line);
  }
  return out;
}

// ── Community traces (public GPS tracks uploaded to OpenStreetMap) ───────────

const OSM_API = "https://api.openstreetmap.org/api/0.6";
/** The API answers 5 000 points per page. */
const TRACE_PAGE = 5000;

interface TracePoint {
  p: LatLng;
  t: number;
}

interface RawTrace {
  /** Public trace id, for traces their author made identifiable. */
  traceId: number | null;
  author: string | null;
  title: string;
  points: TracePoint[];
}

/** A walk or a run someone recorded and shared, cut to the searched area. */
export interface CommunityTrace {
  id: number;
  name: string;
  author: string | null;
  traceId: number | null;
  /** Start of the outing (ms). */
  date: number;
  sport: "run" | "hike";
  /** Average moving speed, km/h. */
  speed: number;
  line: LatLng[];
  distance: number;
  loop: boolean;
  /** The recording goes on outside the area: only its part inside is kept. */
  partial: boolean;
}

function parseTracePage(xml: string): RawTrace[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: RawTrace[] = [];
  doc.querySelectorAll("trk").forEach((trk) => {
    const url = trk.querySelector(":scope > url")?.textContent ?? "";
    const m = url.match(/\/user\/([^/]+)\/traces\/(\d+)/);
    const points: TracePoint[] = [];
    trk.querySelectorAll("trkseg").forEach((seg) => {
      seg.querySelectorAll("trkpt").forEach((pt) => {
        const t = Date.parse(pt.querySelector("time")?.textContent ?? "");
        // Private traces come without time, points sorted by position: unusable
        if (!isFinite(t)) return;
        points.push({ p: [Number(pt.getAttribute("lat")), Number(pt.getAttribute("lon"))], t });
      });
      // A new segment means the track left the area: mark the jump
      if (points.length) points.push({ p: [NaN, NaN], t: NaN });
    });
    if (points.length < 2) return;
    out.push({
      traceId: m ? Number(m[2]) : null,
      author: m ? decodeURIComponent(m[1]) : null,
      title: cleanTitle(trk.querySelector(":scope > desc")?.textContent ?? "") || cleanTitle(trk.querySelector(":scope > name")?.textContent ?? ""),
      points,
    });
  });
  return out;
}

/** Splits a recording into continuous outings: breaks at area exits, long pauses and GPS jumps. */
function outings(points: TracePoint[]): TracePoint[][] {
  const parts: TracePoint[][] = [[]];
  let gapOpen = false;
  for (const q of points) {
    const cur = parts[parts.length - 1];
    if (isNaN(q.t)) {
      gapOpen = true;
      continue;
    }
    const prev = cur[cur.length - 1];
    if (prev) {
      const dt = (q.t - prev.t) / 1000;
      const d = haversine(prev.p, q.p);
      // Leaving the area and coming back close by is the same outing
      // A break (lunch, a summit) where the walker stayed put is the same outing too
      const tolerated = gapOpen ? d < 250 && dt < 1200 : (dt < 600 && d < 400) || (d < 150 && dt < 7200);
      if (!tolerated || dt < 0) parts.push([]);
    }
    parts[parts.length - 1].push(q);
    gapOpen = false;
  }
  return parts.filter((p) => p.length > 10);
}

/** Moving speed (km/h) and the speed the outing keeps over its fastest stretches. */
function paceOf(pts: TracePoint[]) {
  let dist = 0;
  let time = 0;
  const speeds: number[] = [];
  let a = 0;
  // Speeds over windows of at least 30 s, to smooth GPS noise
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[a].t) / 1000;
    if (dt < 30) continue;
    let d = 0;
    for (let k = a + 1; k <= i; k++) d += haversine(pts[k - 1].p, pts[k].p);
    const v = (d / dt) * 3.6;
    if (v > 1 && dt < 300) {
      dist += d;
      time += dt;
      speeds.push(v);
    }
    a = i;
  }
  speeds.sort((x, y) => x - y);
  return { moving: time ? (dist / time) * 3.6 : 0, fast: speeds[Math.floor(speeds.length * 0.9)] ?? 0 };
}

const GENERIC_TITLE =
  /^(strava|garmin|suunto|coros|polar|komoot|wikiloc|track|trace|activity|activit[ée]|untitled|sans titre|run|ride|walk|hike|gpx|export|record|recording|osmand|osmtracker|geotracker|gpslib|script|my ?tracks|tracks?|morning|afternoon|evening|lunch|current)\b/i;

const BY_WHEEL = /v[ée]lo|bike|biking|ride|cycl|vtt|mtb|trott?inette|scooter|roller|skate|voiture|drive|driving|\bcar\b|\bbus\b|train|moto|kayak|canoe|bateau|boat|ski\b/i;

/** Readable name from what the author typed, or none when it is only a file or device name. */
function cleanTitle(s: string) {
  const t = s
    .replace(/\.(gpx|fit|tcx|kml)$/i, "")
    .replace(/_+/g, " ")
    .replace(/^(\d[\d\-:.T]*\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 6 || t.length > 70 || GENERIC_TITLE.test(t) || !/[a-zà-ÿ]{3}/i.test(t)) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function lineLength(line: LatLng[]) {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]);
  return d;
}

// Searches already made are kept a few days: the same area comes back at once
const TRACE_CACHE = "gpx-studio:community";
const TRACE_TTL = 3 * 86400000;
type CachedArea = { box: BBox; at: number; traces: (Omit<CommunityTrace, "line"> & { line: number[] })[] };

function readTraceCache(): CachedArea[] {
  try {
    return JSON.parse(localStorage.getItem(TRACE_CACHE) ?? "[]");
  } catch {
    return [];
  }
}

/** Results of an earlier search of about the same area. */
function recall(box: BBox): CommunityTrace[] | null {
  const size = box[2] - box[0];
  const hit = readTraceCache().find(
    (c) =>
      Date.now() - c.at < TRACE_TTL &&
      Math.abs(c.box[2] - c.box[0] - size) < size * 0.15 &&
      Math.abs(c.box[0] + c.box[2] - box[0] - box[2]) / 2 < size * 0.15 &&
      Math.abs(c.box[1] + c.box[3] - box[1] - box[3]) / 2 < size * 0.2,
  );
  if (!hit) return null;
  return hit.traces.map((t) => {
    const line: LatLng[] = [];
    for (let i = 0; i < t.line.length; i += 2) line.push([t.line[i], t.line[i + 1]]);
    return { ...t, line };
  });
}

function store(box: BBox, traces: CommunityTrace[]) {
  const entry: CachedArea = {
    box,
    at: Date.now(),
    traces: traces.map((t) => ({ ...t, line: t.line.flatMap(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]) })),
  };
  // Latest areas first, a few at most: lines are heavy
  let list = [entry, ...readTraceCache().filter((c) => Date.now() - c.at < TRACE_TTL)].slice(0, 4);
  while (list.length) {
    try {
      localStorage.setItem(TRACE_CACHE, JSON.stringify(list));
      return;
    } catch {
      list = list.slice(0, -1);
    }
  }
}

/**
 * Walks and runs people recorded and shared publicly on OpenStreetMap,
 * around the box. Bike and car tracks are left out from their speed.
 */
export async function fetchCommunityTraces(
  box: BBox,
  opts: {
    signal?: AbortSignal;
    maxPages?: number;
    /** First results while the next pages still load. */
    onTraces?: (traces: CommunityTrace[]) => void;
  } = {},
): Promise<CommunityTrace[]> {
  const [s, w, n, e] = box;
  const raw: RawTrace[] = [];
  const maxPages = opts.maxPages ?? 6;
  const cached = recall(box);
  if (cached) return cached;
  const remember = (traces: CommunityTrace[]) => (store(box, traces), traces);
  const stop = new AbortController();
  const fetchPage = async (page: number): Promise<string | null> => {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", abort);
    stop.signal.addEventListener("abort", abort);
    const timer = setTimeout(abort, 25000);
    try {
      const res = await fetch(`${OSM_API}/trackpoints?bbox=${[w, s, e, n].map((v) => v.toFixed(5)).join(",")}&page=${page}`, {
        signal: ctrl.signal,
      });
      if (!res.ok)
        throw new Error(
          res.status === 509 || res.status === 429
            ? "Le serveur OpenStreetMap est saturé, réessayez dans une minute."
            : "Traces GPS indisponibles pour le moment.",
        );
      return await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // The first page is needed; later ones are a bonus
      if (page === 0) throw (err as Error).name === "AbortError" ? new Error("Le serveur OpenStreetMap ne répond pas, réessayez plus tard.") : err;
      return null;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      stop.signal.removeEventListener("abort", abort);
    }
  };

  const edge = (p: LatLng) => {
    const m = 0.0025;
    return p[0] - s < m || n - p[0] < m || p[1] - w < m * 1.4 || e - p[1] < m * 1.4;
  };

  // Outings of one recording, cached: only the last recording can still grow
  const cache = new Map<number, { size: number; out: CommunityTrace[] }>();
  const outingsOf = (r: RawTrace, index: number): CommunityTrace[] => {
    const hit = cache.get(index);
    if (hit && hit.size === r.points.length) return hit.out;
    const out: CommunityTrace[] = [];
    outings(r.points).forEach((pts, k) => {
      const { moving, fast } = paceOf(pts);
      // Bikes, cars, ski lifts… and GPS left on a table
      if (fast > 19 || moving > 15 || moving < 1.5) return;
      // Said to be a ride: only its walking parts are kept
      if (BY_WHEEL.test(r.title) && moving > 6.5) return;
      const line: LatLng[] = [];
      for (const q of pts) if (!line.length || haversine(line[line.length - 1], q.p) > 8) line.push(q.p);
      const distance = lineLength(line);
      if (distance < 1500 || line.length < 10) return;
      out.push({
        // Stable while pages come in, and negative: never mistaken for a waymarked route
        id: -(index * 100 + k + 1),
        name: r.title,
        author: r.author,
        traceId: r.traceId,
        date: pts[0].t,
        sport: moving >= 7.5 ? "run" : "hike",
        speed: moving,
        line,
        distance,
        loop: haversine(line[0], line[line.length - 1]) < 300,
        partial: edge(line[0]) || edge(line[line.length - 1]),
      });
    });
    cache.set(index, { size: r.points.length, out });
    return out;
  };

  /** Every outing so far, the same route recorded twice kept once (the latest). */
  const build = () => {
    const all = raw.flatMap(outingsOf).sort((a, z) => z.date - a.date);
    const kept: CommunityTrace[] = [];
    for (const t of all) {
      const same = kept.some(
        (k) =>
          Math.abs(k.distance - t.distance) < 0.03 * t.distance &&
          haversine(k.line[0], t.line[0]) < 150 &&
          haversine(k.line[k.line.length - 1], t.line[t.line.length - 1]) < 150,
      );
      if (!same) kept.push(t);
    }
    return kept;
  };
  /** Adds a page to the recordings; false when it was the last one. */
  const read = (xml: string) => {
    // Pages cut through recordings: glue a piece to the one it continues
    for (const t of parseTracePage(xml)) {
      const last = raw[raw.length - 1];
      const a = last?.points.filter((q) => !isNaN(q.t)).at(-1);
      const b = t.points[0];
      if (last && a && last.traceId === t.traceId && b.t >= a.t && b.t - a.t < 600000 && haversine(a.p, b.p) < 1000) {
        last.points.push(...t.points);
      } else raw.push(t);
    }
    return (xml.match(/<trkpt/g)?.length ?? 0) >= TRACE_PAGE;
  };

  // Each page costs the server 2 to 4 s whatever its size: the first one is
  // shown on its own, then all the others are asked at once and read in order
  const first = await fetchPage(0);
  if (first == null || !read(first)) return remember(build());
  opts.onTraces?.(build());
  const rest = Array.from({ length: maxPages - 1 }, (_, k) => fetchPage(k + 1));
  rest.forEach((r) => r.catch(() => {}));
  try {
    for (const r of rest) {
      const xml = await r;
      if (xml == null || !read(xml)) break;
      opts.onTraces?.(build());
    }
  } finally {
    // Pages past the last one are not needed
    stop.abort();
  }
  return remember(build());
}
