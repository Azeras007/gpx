import { describe, expect, it } from "vitest";
import { classify, mixFromBrouter, shares } from "../src/lib/surface";

describe("surface", () => {
  it("classifies OSM tags", () => {
    expect(classify("highway=pedestrian surface=asphalt")).toBe("paved");
    expect(classify("highway=residential")).toBe("paved");
    expect(classify("highway=footway route_hiking_lwn=yes")).toBe("paved");
    expect(classify("highway=footway surface=dirt")).toBe("trail");
    expect(classify("highway=track tracktype=grade3")).toBe("track");
    expect(classify("highway=track tracktype=grade1")).toBe("paved");
    expect(classify("highway=track surface=asphalt")).toBe("paved");
    expect(classify("highway=path")).toBe("trail");
    expect(classify("highway=path surface=gravel")).toBe("trail");
    expect(classify("highway=unclassified surface=gravel")).toBe("track");
    expect(classify("highway=steps")).toBe("trail");
    expect(classify("")).toBe("unknown");
    expect(classify("route=ferry")).toBe("unknown");
  });
  it("sums a BRouter messages table", () => {
    const mix = mixFromBrouter([
      ["Longitude", "Latitude", "Elevation", "Distance", "WayTags"],
      ["0", "0", "0", "30", "highway=pedestrian surface=asphalt"],
      ["0", "0", "0", "100", "highway=path"],
      ["0", "0", "0", "70", "highway=track"],
      ["0", "0", "0", "x", "highway=path"],
    ])!;
    expect(mix).toEqual({ paved: 30, track: 70, trail: 100, unknown: 0 });
    expect(mixFromBrouter(undefined)).toBeNull();
    expect(mixFromBrouter([["a"], ["b"]])).toBeNull();
  });
  it("scales to the route and fills the rest as unknown", () => {
    const s = shares({ paved: 500, track: 0, trail: 500, unknown: 0 }, 2000);
    expect(s.find((x) => x.kind === "paved")!.pct).toBe(25);
    expect(s.find((x) => x.kind === "unknown")!.meters).toBe(1000);
    const over = shares({ paved: 1100, track: 0, trail: 1100, unknown: 0 }, 2000);
    expect(over.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100, 6);
  });
});
