export type LatLng = [number, number];

export type Activity = "run" | "hike";
export type SegmentMode = "snap" | "line";

export interface Waypoint {
  id: string;
  lat: number;
  lng: number;
  /** How this point is reached from the previous one. */
  mode: SegmentMode;
}

export interface ProfilePoint {
  lat: number;
  lng: number;
  /** Cumulative distance in meters. */
  d: number;
  ele: number | null;
}

export interface RouteStats {
  distance: number;
  gain: number;
  loss: number;
  minEle: number | null;
  maxEle: number | null;
  maxSlope: number;
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function cumulative(track: LatLng[]): number[] {
  const out = new Array<number>(track.length);
  let acc = 0;
  for (let i = 0; i < track.length; i++) {
    if (i > 0) acc += haversine(track[i - 1], track[i]);
    out[i] = acc;
  }
  return out;
}

/** Samples the track at a regular interval, always keeping both ends. */
export function resample(track: LatLng[], maxPoints = 400, minStep = 20): ProfilePoint[] {
  if (track.length === 0) return [];
  const cum = cumulative(track);
  const total = cum[cum.length - 1];
  if (total === 0) return [{ lat: track[0][0], lng: track[0][1], d: 0, ele: null }];
  const step = Math.max(minStep, total / (maxPoints - 1));
  const out: ProfilePoint[] = [];
  let j = 0;
  for (let d = 0; d < total; d += step) {
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const t = (d - cum[j]) / span;
    out.push({
      lat: track[j][0] + (track[j + 1][0] - track[j][0]) * t,
      lng: track[j][1] + (track[j + 1][1] - track[j][1]) * t,
      d,
      ele: null,
    });
  }
  const last = track[track.length - 1];
  out.push({ lat: last[0], lng: last[1], d: total, ele: null });
  return out;
}

/** Linear interpolation of elevation at a given distance along the profile. */
export function eleAt(profile: ProfilePoint[], d: number): number | null {
  if (profile.length === 0) return null;
  let lo = 0;
  let hi = profile.length - 1;
  if (d <= profile[0].d) return profile[0].ele;
  if (d >= profile[hi].d) return profile[hi].ele;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid].d <= d) lo = mid;
    else hi = mid;
  }
  const a = profile[lo];
  const b = profile[hi];
  if (a.ele == null || b.ele == null) return a.ele ?? b.ele;
  const t = (d - a.d) / (b.d - a.d || 1);
  return a.ele + (b.ele - a.ele) * t;
}

export function computeStats(distance: number, profile: ProfilePoint[]): RouteStats {
  const eles = profile.map((p) => p.ele).filter((e): e is number => e != null);
  let gain = 0;
  let loss = 0;
  let maxSlope = 0;
  if (eles.length > 1) {
    // Hysteresis filter: only count elevation changes larger than the threshold,
    // which removes DEM noise that would otherwise inflate D+/D-.
    const threshold = 4;
    let ref = eles[0];
    for (const e of eles) {
      const diff = e - ref;
      if (diff >= threshold) {
        gain += diff;
        ref = e;
      } else if (diff <= -threshold) {
        loss -= diff;
        ref = e;
      }
    }
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1];
      const b = profile[i];
      if (a.ele == null || b.ele == null) continue;
      const dd = b.d - a.d;
      if (dd < 15) continue;
      maxSlope = Math.max(maxSlope, Math.abs((b.ele - a.ele) / dd) * 100);
    }
  }
  return {
    distance,
    gain,
    loss,
    minEle: eles.length ? Math.min(...eles) : null,
    maxEle: eles.length ? Math.max(...eles) : null,
    maxSlope,
  };
}

/** Estimated duration in seconds. */
export function estimateDuration(
  activity: Activity,
  stats: RouteStats,
  runPace: number,
  hikeSpeed: number,
): number {
  const km = stats.distance / 1000;
  if (activity === "run") {
    // "Kilomètre-effort": every 100 m of climbing counts as one extra flat km.
    const effortKm = km + stats.gain / 100 + stats.loss / 400;
    return effortKm * runPace * 60;
  }
  // DIN 33466 hiking time: horizontal and vertical times are combined.
  const th = km / hikeSpeed;
  const tv = stats.gain / 300 + stats.loss / 500;
  return (Math.max(th, tv) + Math.min(th, tv) / 2) * 3600;
}

/** Douglas–Peucker simplification (tolerance in meters, approximate projection). */
export function simplify(points: LatLng[], tolerance: number): LatLng[] {
  if (points.length < 3) return points.slice();
  const lat0 = rad(points[0][0]);
  const kx = R * Math.cos(lat0) * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  const xy = points.map(([la, ln]) => [ln * kx, la * ky] as const);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = xy[s];
    const [bx, by] = xy[e];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const qx = ax + t * dx - px;
      const qy = ay + t * dy - py;
      const d2 = qx * qx + qy * qy;
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function formatDuration(s: number): string {
  if (!isFinite(s) || s <= 0) return "0 min";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

export function formatPace(minPerKm: number): string {
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
