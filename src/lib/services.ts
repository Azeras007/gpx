import type { LatLng, ProfilePoint } from "./geo";

/** Snaps a leg to paths & trails using the public OSRM "foot" profile. */
export async function routeFoot(a: LatLng, b: LatLng, signal?: AbortSignal): Promise<LatLng[]> {
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
