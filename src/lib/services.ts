import type { LatLng, ProfilePoint } from "./geo";

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

const eleCache = new Map<string, number>();
const key = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

/** Fills elevations using the Open-Meteo DEM API (Copernicus 90 m), 100 points per call. */
export async function fetchElevations(points: ProfilePoint[], signal?: AbortSignal): Promise<ProfilePoint[]> {
  const missing = points.filter((p) => !eleCache.has(key(p.lat, p.lng)));
  const unique = [...new Map(missing.map((p) => [key(p.lat, p.lng), p])).values()];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const lat = chunk.map((p) => p.lat.toFixed(5)).join(",");
    const lng = chunk.map((p) => p.lng.toFixed(5)).join(",");
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, { signal });
    if (!res.ok) throw new Error(`Elevation HTTP ${res.status}`);
    const json = await res.json();
    (json.elevation as number[]).forEach((e, j) => eleCache.set(key(chunk[j].lat, chunk[j].lng), e));
  }
  return points.map((p) => ({ ...p, ele: eleCache.get(key(p.lat, p.lng)) ?? null }));
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
  sunrise: string;
  sunset: string;
}

/** Hourly forecast for the day(s) covering [start, end] (local time strings "YYYY-MM-DDTHH:mm"). */
export async function fetchWeather(lat: number, lng: number, startDate: string, endDate: string, signal?: AbortSignal): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code&daily=sunrise,sunset` +
    `&timezone=auto&start_date=${startDate}&end_date=${endDate}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
  const j = await res.json();
  return {
    hours: (j.hourly.time as string[]).map((time, i) => ({
      time,
      temp: j.hourly.temperature_2m[i],
      rain: j.hourly.precipitation_probability[i] ?? 0,
      wind: j.hourly.wind_speed_10m[i],
      code: j.hourly.weather_code[i],
    })),
    sunrise: j.daily.sunrise[0],
    sunset: j.daily.sunset[j.daily.sunset.length - 1],
  };
}
