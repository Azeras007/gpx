import { decodePolyline, encodePolyline, uid, type Activity, type Poi, type PoiType, type Waypoint } from "./geo";

export interface SharedRoute {
  name: string;
  activity: Activity;
  waypoints: Waypoint[];
  pois: Poi[];
}

const toB64 = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64 = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** Compact, URL-safe encoding: waypoints as an encoded polyline plus one flag letter per point. */
export function encodeRoute(r: SharedRoute): string {
  const payload = {
    n: r.name,
    a: r.activity,
    w: encodePolyline(r.waypoints.map((w) => [w.lat, w.lng])),
    m: r.waypoints.map((w) => (w.mode === "line" ? "l" : w.avoid ? "a" : "s")).join(""),
    p: r.pois.map((p) => [+p.lat.toFixed(5), +p.lng.toFixed(5), p.type, p.name]),
  };
  return toB64(JSON.stringify(payload));
}

export function decodeRoute(code: string): SharedRoute | null {
  try {
    const j = JSON.parse(fromB64(code));
    const pts = decodePolyline(j.w);
    return {
      name: String(j.n || "Parcours partagé"),
      activity: j.a === "hike" ? "hike" : "run",
      waypoints: pts.map(([lat, lng], i) => ({
        id: uid(),
        lat,
        lng,
        mode: j.m?.[i] === "l" ? "line" : "snap",
        avoid: j.m?.[i] === "a",
      })),
      pois: (j.p ?? []).map(([lat, lng, type, name]: [number, number, PoiType, string]) => ({ id: uid(), lat, lng, type, name })),
    };
  } catch {
    return null;
  }
}
