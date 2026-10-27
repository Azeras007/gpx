export type LatLng = [number, number];

export type Activity = "run" | "hike";
export type SegmentMode = "snap" | "line";

export interface Waypoint {
  id: string;
  lat: number;
  lng: number;
  /** How this point is reached from the previous one. */
  mode: SegmentMode;
  /** Route this leg away from the paths already used earlier in the route. */
  avoid?: boolean;
}

export type PoiType = "water" | "food" | "summit" | "view" | "danger" | "parking" | "note";

export interface Poi {
  id: string;
  lat: number;
  lng: number;
  type: PoiType;
  name: string;
}

export const POI_TYPES: Record<PoiType, { label: string; emoji: string; sym: string }> = {
  water: { label: "Point d'eau", emoji: "💧", sym: "Drinking Water" },
  food: { label: "Ravitaillement", emoji: "🍎", sym: "Restaurant" },
  summit: { label: "Sommet", emoji: "⛰️", sym: "Summit" },
  view: { label: "Point de vue", emoji: "📷", sym: "Scenic Area" },
  danger: { label: "Danger", emoji: "⚠️", sym: "Danger Area" },
  parking: { label: "Parking", emoji: "🅿️", sym: "Parking Area" },
  note: { label: "Note", emoji: "📍", sym: "Flag, Blue" },
};

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

/** Point at `dist` meters from `p` towards `bearing` (degrees, 0 = north). */
export function destination(p: LatLng, dist: number, bearing: number): LatLng {
  const d = dist / R;
  const b = rad(bearing);
  const la1 = rad(p[0]);
  const lo1 = rad(p[1]);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}

/** Points every `step` meters along the track, with their cumulative distance. */
export function sampleEvery(track: LatLng[], step: number): { p: LatLng; d: number }[] {
  if (track.length < 2) return track.map((p) => ({ p, d: 0 }));
  const cum = cumulative(track);
  const total = cum[cum.length - 1];
  const out: { p: LatLng; d: number }[] = [];
  let j = 0;
  for (let d = 0; d <= total; d += step) {
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const t = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push({
      p: [track[j][0] + (track[j + 1][0] - track[j][0]) * t, track[j][1] + (track[j + 1][1] - track[j][1]) * t],
      d,
    });
  }
  return out;
}

export interface Overlaps {
  /** Total length (meters) of the parts that pass where the route already went. */
  length: number;
  /** Repeated sections, ready to draw on the map. */
  lines: LatLng[][];
  /** Distance ranges [from, to] of the repeated sections. */
  ranges: [number, number][];
}

/**
 * Finds the parts of the route that run over a section already used earlier
 * (within `tol` meters), ignoring the last `gap` meters so a tight bend does
 * not count as a repeat.
 */
export function findOverlaps(track: LatLng[], tol = 14, gap = 150): Overlaps {
  const step = 10;
  const pts = sampleEvery(track, step);
  if (pts.length < 3) return { length: 0, lines: [], ranges: [] };
  const lat0 = rad(pts[0].p[0]);
  const kx = R * Math.cos(lat0) * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  const grid = new Map<string, number[]>();
  const cell = (x: number, y: number) => `${Math.floor(x / tol)},${Math.floor(y / tol)}`;
  const xy = pts.map(({ p }) => [p[1] * kx, p[0] * ky] as const);
  const flags = new Uint8Array(pts.length);
  // Points become searchable only once they are `gap` meters behind the current one.
  let inserted = 0;
  const lag = Math.ceil(gap / step);
  for (let i = 0; i < pts.length; i++) {
    while (inserted < i - lag) {
      const [x, y] = xy[inserted];
      const k = cell(x, y);
      const list = grid.get(k);
      if (list) list.push(inserted);
      else grid.set(k, [inserted]);
      inserted++;
    }
    const [x, y] = xy[i];
    const cx = Math.floor(x / tol);
    const cy = Math.floor(y / tol);
    search: for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const [jx, jy] = xy[j];
          if ((jx - x) ** 2 + (jy - y) ** 2 <= tol * tol) {
            flags[i] = 1;
            break search;
          }
        }
      }
  }
  // Fill tiny holes, then collect runs longer than 40 m.
  for (let i = 1; i < flags.length - 1; i++) if (!flags[i] && flags[i - 1] && flags[i + 1]) flags[i] = 1;
  const lines: LatLng[][] = [];
  const ranges: [number, number][] = [];
  let length = 0;
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = pts[i - 1].d - pts[start].d;
      if (len >= 40) {
        lines.push(pts.slice(start, i).map((x) => x.p));
        ranges.push([pts[start].d, pts[i - 1].d]);
        length += len;
      }
      start = -1;
    }
  }
  return { length, lines, ranges };
}

/** Distance along the track of its closest point to `p`, and how far `p` is from it. */
export function locateOnTrack(track: LatLng[], cum: number[], p: LatLng): { d: number; off: number } {
  let best = { d: 0, off: Infinity };
  const kx = Math.cos(rad(p[0]));
  for (let i = 0; i < track.length - 1; i++) {
    const ax = track[i][1] * kx, ay = track[i][0];
    const bx = track[i + 1][1] * kx, by = track[i + 1][0];
    const px = p[1] * kx, py = p[0];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const q: LatLng = [ay + t * dy, (ax + t * dx) / kx];
    const off = haversine(q, p);
    if (off < best.off) best = { d: cum[i] + t * (cum[i + 1] - cum[i]), off };
  }
  return best;
}

export interface Split {
  km: number;
  length: number;
  gain: number;
  loss: number;
  time: number;
  /** Cumulative time at the end of this split, in seconds. */
  elapsed: number;
}

/** Per-kilometer breakdown, scaled so the total matches the overall estimate. */
export function computeSplits(
  activity: Activity,
  profile: ProfilePoint[],
  total: number,
  runPace: number,
  hikeSpeed: number,
  duration: number,
): Split[] {
  if (profile.length < 2 || total < 50) return [];
  const splits: Split[] = [];
  for (let km = 0; km * 1000 < total; km++) {
    const from = km * 1000;
    const to = Math.min(total, from + 1000);
    const sub = profile.filter((p) => p.d >= from && p.d <= to);
    const st = computeStats(to - from, sub);
    splits.push({
      km: km + 1,
      length: to - from,
      gain: st.gain,
      loss: st.loss,
      time: estimateDuration(activity, st, runPace, hikeSpeed),
      elapsed: 0,
    });
  }
  const sum = splits.reduce((a, s) => a + s.time, 0) || 1;
  let acc = 0;
  for (const s of splits) {
    s.time *= duration / sum;
    acc += s.time;
    s.elapsed = acc;
  }
  return splits;
}

/** "Kilomètre-effort": distance plus 1 km per 100 m of climbing. */
export const effortKm = (s: RouteStats) => s.distance / 1000 + s.gain / 100;

export function difficulty(s: RouteStats): { label: string; level: 0 | 1 | 2 | 3 } {
  const e = effortKm(s);
  if (e < 10) return { label: "Facile", level: 0 };
  if (e < 22) return { label: "Modéré", level: 1 };
  if (e < 38) return { label: "Difficile", level: 2 };
  return { label: "Expert", level: 3 };
}

/** Rough energy estimate in kcal. */
export function calories(activity: Activity, s: RouteStats, weightKg: number): number {
  return effortKm(s) * weightKg * (activity === "run" ? 1.0 : 0.8);
}

/** Google encoded polyline (precision 1e5). */
export function encodePolyline(points: LatLng[]): string {
  let out = "";
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [la, ln] of points) {
    const a = Math.round(la * 1e5);
    const b = Math.round(ln * 1e5);
    enc(a - pLat);
    enc(b - pLng);
    pLat = a;
    pLng = b;
  }
  return out;
}

export function decodePolyline(str: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const dec = () => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += dec();
    lng += dec();
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
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
