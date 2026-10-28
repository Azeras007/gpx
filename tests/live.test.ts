import { describe, expect, it } from "vitest";
import { cumulative, destination, type LatLng } from "../src/lib/geo";
import { gainLeft, isOffRoute, progressOn } from "../src/lib/live";

const a: LatLng = [45.9, 6.86];
// A square loop of 4 km back to its start
const corners = [a, destination(a, 1000, 0), destination(destination(a, 1000, 0), 1000, 90), destination(a, 1000, 90), a];
const loop: LatLng[] = [];
for (let i = 1; i < corners.length; i++) for (let k = 0; k < 20; k++) loop.push([corners[i - 1][0] + ((corners[i][0] - corners[i - 1][0]) * k) / 20, corners[i - 1][1] + ((corners[i][1] - corners[i - 1][1]) * k) / 20]);
loop.push(a);
const cum = cumulative(loop);

describe("live progress", () => {
  it("at the start of a loop, reads 0 km, not the finish", () => {
    expect(progressOn(loop, cum, destination(a, 5, 45), null).d).toBeLessThan(50);
  });
  it("near the finish after walking the loop, reads the finish", () => {
    const p = destination(a, 20, 90);
    const r = progressOn(loop, cum, p, 3900);
    expect(r.d).toBeGreaterThan(3950);
  });
  it("follows along and reports how far off the walker is", () => {
    const p = destination(destination(a, 1000, 0), 400, 90);
    const r = progressOn(loop, cum, destination(p, 30, 180), 1350);
    expect(r.d).toBeCloseTo(1400, -1);
    expect(r.off).toBeCloseTo(30, 0);
  });
  it("finds the route again after a long detour", () => {
    const p = destination(a, 500, 90); // on the last side
    const r = progressOn(loop, cum, p, 200);
    expect(r.d).toBeGreaterThan(3400);
  });
  it("climb left", () => {
    const prof = [0, 100, 200, 300].map((d, i) => ({ lat: 0, lng: 0, d, ele: [100, 150, 120, 200][i] }));
    expect(gainLeft(prof, 0)).toBe(130);
    expect(gainLeft(prof, 150)).toBe(80);
    expect(gainLeft(prof, 300)).toBe(0);
  });
  it("off route depends on accuracy", () => {
    expect(isOffRoute(30, 10)).toBe(false);
    expect(isOffRoute(60, 10)).toBe(true);
    expect(isOffRoute(60, 50)).toBe(false);
  });
});
