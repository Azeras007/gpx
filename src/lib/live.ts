import { eleAt, haversine, type LatLng, type ProfilePoint } from "./geo";

/** Closest point of the track between distances `from` and `to` (meters along it). */
function closestBetween(track: LatLng[], cum: number[], p: LatLng, from: number, to: number) {
  let best = { d: 0, off: Infinity };
  const kx = Math.cos((p[0] * Math.PI) / 180);
  for (let i = 0; i < track.length - 1; i++) {
    if (cum[i + 1] < from || cum[i] > to) continue;
    const ax = track[i][1] * kx, ay = track[i][0];
    const bx = track[i + 1][1] * kx, by = track[i + 1][0];
    const px = p[1] * kx, py = p[0];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const off = haversine([ay + t * dy, (ax + t * dx) / kx], p);
    if (off < best.off) best = { d: cum[i] + t * (cum[i + 1] - cum[i]), off };
  }
  return best;
}

/**
 * Where the walker is along the route. The search starts just around the last
 * known position, so a loop's start and finish (or a path used twice) are
 * not mistaken for each other; the whole route is searched only when that fails.
 */
export function progressOn(track: LatLng[], cum: number[], p: LatLng, lastD: number | null): { d: number; off: number } {
  if (track.length < 2) return { d: 0, off: track.length ? haversine(track[0], p) : Infinity };
  if (lastD != null) {
    const near = closestBetween(track, cum, p, lastD - 150, lastD + 1500);
    if (near.off < 60) return near;
  }
  // From scratch: on a loop the start wins over the finish
  const all = closestBetween(track, cum, p, -Infinity, Infinity);
  if (lastD == null) {
    const start = closestBetween(track, cum, p, -Infinity, Math.min(cum[cum.length - 1] / 2, 1500));
    if (start.off < all.off + 15) return start;
  }
  return all;
}

/** Climbing left between `d` and the end, on the elevation profile. */
export function gainLeft(profile: ProfilePoint[], d: number): number {
  let gain = 0;
  let prev: number | null = eleAt(profile, d);
  for (const p of profile) {
    if (p.d <= d || p.ele == null) continue;
    if (prev != null && p.ele > prev) gain += p.ele - prev;
    prev = p.ele;
  }
  return gain;
}

/** Off the route beyond what GPS accuracy explains. */
export const isOffRoute = (off: number, accuracy: number) => off > Math.max(45, Math.min(accuracy, 100) * 1.5);
