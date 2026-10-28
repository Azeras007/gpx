import { describe, expect, it } from "vitest";
import {
  computeSplits,
  computeStats,
  cumulative,
  decodePolyline,
  destination,
  difficulty,
  eleAt,
  encodePolyline,
  estimateDuration,
  findOverlaps,
  formatDistance,
  formatDuration,
  formatGrade,
  formatPace,
  haversine,
  locateOnTrack,
  pointAt,
  resample,
  simplify,
  smoothProfile,
  type LatLng,
  type ProfilePoint,
} from "../src/lib/geo";

/** A straight line heading north, `n` points `step` meters apart. */
function north(n: number, step = 100, from: LatLng = [45.9, 6.86]): LatLng[] {
  return Array.from({ length: n }, (_, i) => destination(from, i * step, 0));
}

/** Profile along `track` with an elevation given by `f(distance)`. */
function profileOf(track: LatLng[], f: (d: number) => number): ProfilePoint[] {
  return resample(track).map((p) => ({ ...p, ele: f(p.d) }));
}

describe("distances", () => {
  it("haversine matches a known distance (Paris → Lyon ≈ 392 km)", () => {
    expect(haversine([48.8566, 2.3522], [45.764, 4.8357]) / 1000).toBeCloseTo(392, -1);
  });
  it("destination and haversine agree", () => {
    const a: LatLng = [45.9, 6.86];
    for (const bearing of [0, 45, 133, 270]) expect(haversine(a, destination(a, 1234, bearing))).toBeCloseTo(1234, 3);
  });
  it("cumulative sums the legs", () => {
    const c = cumulative(north(11));
    expect(c[0]).toBe(0);
    expect(c[10]).toBeCloseTo(1000, 3);
  });
  it("pointAt interpolates and clamps", () => {
    const t = north(3);
    const cum = cumulative(t);
    expect(haversine(pointAt(t, cum, 150), t[0])).toBeCloseTo(150, 3);
    expect(pointAt(t, cum, -5)).toEqual(t[0]);
    expect(pointAt(t, cum, 1e9)).toEqual(t[2]);
    expect(pointAt([], [], 10)).toEqual([0, 0]);
  });
  it("locateOnTrack finds the closest point and its offset", () => {
    const t = north(11);
    const cum = cumulative(t);
    const p = destination(destination(t[0], 420, 0), 30, 90);
    const at = locateOnTrack(t, cum, p);
    expect(at.d).toBeCloseTo(420, 0);
    expect(at.off).toBeCloseTo(30, 0);
  });
});

describe("resample / elevations", () => {
  it("keeps both ends and a regular step", () => {
    const t = north(21);
    const r = resample(t, 50, 20);
    expect(r[0].d).toBe(0);
    expect(r.at(-1)!.d).toBeCloseTo(2000, 3);
    expect(r.length).toBeLessThanOrEqual(51);
  });
  it("handles degenerate tracks", () => {
    expect(resample([])).toEqual([]);
    expect(resample([[45, 6]]).length).toBe(1);
    expect(resample([[45, 6], [45, 6]]).length).toBe(1);
  });
  it("eleAt interpolates and tolerates gaps", () => {
    const p: ProfilePoint[] = [
      { lat: 0, lng: 0, d: 0, ele: 100 },
      { lat: 0, lng: 0, d: 100, ele: 200 },
      { lat: 0, lng: 0, d: 200, ele: null },
    ];
    expect(eleAt(p, 50)).toBe(150);
    expect(eleAt(p, 150)).toBe(200);
    expect(eleAt([], 3)).toBeNull();
  });
  it("smoothing removes spikes", () => {
    const t = north(21);
    const noisy = profileOf(t, (d) => 1000 + (Math.round(d / 20) % 2 ? 8 : -8));
    const s = smoothProfile(noisy, 60);
    const spread = Math.max(...s.map((p) => p.ele!)) - Math.min(...s.map((p) => p.ele!));
    expect(spread).toBeLessThan(6);
  });
});

describe("computeStats", () => {
  it("flat ground with noise has no climb", () => {
    const t = north(51);
    const st = computeStats(5000, profileOf(t, (d) => 500 + Math.sin(d / 7) * 2));
    expect(st.gain).toBeLessThan(10);
    expect(st.climbGrade).toBe(0);
  });
  it("a steady 10 % climb reads as 10 %", () => {
    const t = north(31);
    const st = computeStats(3000, profileOf(t, (d) => 1000 + d * 0.1));
    expect(st.gain).toBeGreaterThan(270);
    expect(st.gain).toBeLessThan(310);
    expect(st.climbGrade).toBeCloseTo(10, 0);
    expect(st.steepest.grade).toBeCloseTo(10, 0);
    expect(st.loss).toBeLessThan(5);
  });
  it("up then down counts both and finds the steepest descent", () => {
    const t = north(41);
    const st = computeStats(4000, profileOf(t, (d) => (d < 1000 ? 1000 + d * 0.05 : 1050 - (d - 1000) * 0.15)));
    // The smoothed summit loses a few meters
    expect(st.gain).toBeGreaterThan(40);
    expect(st.gain).toBeLessThan(55);
    expect(st.loss).toBeGreaterThan(250);
    expect(st.steepest.grade).toBeLessThan(-12);
  });
  it("works without any elevation", () => {
    const st = computeStats(1200, resample(north(13)));
    expect(st).toMatchObject({ gain: 0, loss: 0, minEle: null, maxEle: null, climbGrade: 0 });
  });
});

describe("durations, difficulty, splits", () => {
  const flat = { distance: 10000, gain: 0, loss: 0, minEle: 0, maxEle: 0, climbGrade: 0, steepest: { grade: 0, over: 500 } };
  it("10 km flat at 6:00/km takes an hour", () => {
    expect(estimateDuration("run", flat, 6, 4.5)).toBeCloseTo(3600, 0);
  });
  it("climbing adds time for runners (km-effort)", () => {
    expect(estimateDuration("run", { ...flat, gain: 500 }, 6, 4.5)).toBeCloseTo(3600 * 1.5, 0);
  });
  it("hiking uses DIN 33466", () => {
    // 10 km at 5 km/h = 2 h, 300 m up = 1 h → 2 + 1/2 = 2.5 h
    expect(estimateDuration("hike", { ...flat, gain: 300 }, 6, 5) / 3600).toBeCloseTo(2.5, 3);
  });
  it("difficulty grows with effort", () => {
    expect(difficulty({ ...flat, distance: 5000 }).level).toBe(0);
    expect(difficulty({ ...flat, distance: 15000 }).level).toBe(1);
    expect(difficulty({ ...flat, distance: 20000, gain: 2000 }).level).toBe(3);
  });
  it("splits add up to the total duration and distance", () => {
    const t = north(48);
    const prof = profileOf(t, (d) => 800 + d * 0.03);
    const total = cumulative(t).at(-1)!;
    const splits = computeSplits("run", prof, total, 6, 4.5, 3000);
    expect(splits.reduce((a, s) => a + s.time, 0)).toBeCloseTo(3000, 3);
    expect(splits.reduce((a, s) => a + s.length, 0)).toBeCloseTo(total, 3);
    expect(splits.at(-1)!.elapsed).toBeCloseTo(3000, 3);
    // 4.7 km: the last 700 m stays a split, no tiny stub
    expect(splits.length).toBe(5);
  });
  it("no splits for a tiny route", () => {
    expect(computeSplits("run", [], 0, 6, 4.5, 0)).toEqual([]);
  });
});

describe("geometry helpers", () => {
  it("simplify keeps ends and drops collinear points", () => {
    const t = north(50, 10);
    const s = simplify(t, 3);
    expect(s.length).toBe(2);
    expect(s[0]).toEqual(t[0]);
    expect(s[1]).toEqual(t.at(-1));
  });
  it("simplify keeps a real corner", () => {
    const a: LatLng = [45.9, 6.86];
    const corner = destination(a, 500, 0);
    const line = [a, destination(a, 250, 0), corner, destination(corner, 250, 90), destination(corner, 500, 90)];
    expect(simplify(line, 5)).toHaveLength(3);
  });
  it("polyline round trip", () => {
    const pts: LatLng[] = [
      [45.92345, 6.86912],
      [-33.86882, 151.20929],
      [0, 0],
      [89.99999, -179.99999],
    ];
    const back = decodePolyline(encodePolyline(pts));
    back.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(pts[i][0], 5);
      expect(p[1]).toBeCloseTo(pts[i][1], 5);
    });
  });
  it("an out-and-back overlaps itself, a loop does not", () => {
    const out = north(21);
    const back = out.slice(0, -1).reverse();
    const ov = findOverlaps([...out, ...back]);
    expect(ov.length).toBeGreaterThan(1500);
    const a: LatLng = [45.9, 6.86];
    const square = [a, destination(a, 1000, 0), destination(destination(a, 1000, 0), 1000, 90), destination(a, 1000, 90), a];
    expect(findOverlaps(square).length).toBe(0);
  });
});

describe("formatting (French)", () => {
  it("distances", () => {
    expect(formatDistance(850)).toBe("850 m");
    expect(formatDistance(2430)).toBe("2,43 km");
    expect(formatDistance(42195)).toBe("42,2 km");
  });
  it("durations", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(NaN)).toBe("0 min");
    expect(formatDuration(45 * 60)).toBe("45 min");
    expect(formatDuration(3600 + 5 * 60)).toBe("1 h 05");
    expect(formatDuration(2 * 3600 - 1)).toBe("2 h 00");
    expect(formatDuration(3600 - 1)).toBe("1 h 00");
  });
  it("paces never show 60 seconds", () => {
    expect(formatPace(6)).toBe("6:00");
    expect(formatPace(5.5)).toBe("5:30");
    expect(formatPace(5.999)).toBe("6:00");
  });
  it("grades", () => {
    expect(formatGrade(8)).toBe("8 %");
    expect(formatGrade(-4.25)).toBe("4,3 %");
    expect(formatGrade(12.6)).toBe("13 %");
  });
});
