import { eleAt, type LatLng, type ProfilePoint } from "./geo";

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

async function openMeteoElevations(points: ProfilePoint[], signal?: AbortSignal): Promise<ProfilePoint[]> {
  // One request of at most 100 points, then linear interpolation in between.
  const step = Math.max(1, Math.ceil(points.length / 100));
  const picked = points.filter((_, i) => i % step === 0 || i === points.length - 1).slice(0, 100);
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

export interface Weather {
  hours: { time: string; temp: number; rain: number; wind: number; code: number }[];
  days: { date: string; sunrise: string; sunset: string }[];
}

const weatherCache = new Map<string, { at: number; data: Promise<Weather> }>();

/**
 * 16-day hourly forecast around a point, in the place's local time
 * ("YYYY-MM-DDTHH:mm"). Cached 30 minutes per ~1 km cell.
 */
export function fetchWeather(lat: number, lng: number): Promise<Weather> {
  const k = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = weatherCache.get(k);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code&daily=sunrise,sunset` +
    `&timezone=auto&forecast_days=16&past_days=1`;
  const data = (async () => {
    let res = await fetch(url);
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await fetch(url);
    }
    if (!res.ok) {
      const reason = await res
        .json()
        .then((j) => j.reason as string)
        .catch(() => "");
      throw new Error(res.status === 429 ? "Trop de requêtes, réessayez dans une minute" : reason || `Erreur ${res.status}`);
    }
    const j = await res.json();
    const h = j.hourly;
    return {
      hours: (h.time as string[]).map((time, i) => ({
        time,
        temp: h.temperature_2m[i],
        rain: h.precipitation_probability?.[i] ?? 0,
        wind: h.wind_speed_10m[i],
        code: h.weather_code[i],
      })),
      days: (j.daily.time as string[]).map((date, i) => ({ date, sunrise: j.daily.sunrise[i], sunset: j.daily.sunset[i] })),
    };
  })();
  data.catch(() => weatherCache.delete(k));
  weatherCache.set(k, { at: Date.now(), data });
  return data;
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
