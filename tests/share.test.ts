import { describe, expect, it } from "vitest";
import { decodeRoute, encodeRoute } from "../src/lib/share";

describe("share links", () => {
  it("round trips a route with modes, pois and accents", () => {
    const route = {
      name: "Boucle du Salève 🌄 — été",
      activity: "hike" as const,
      waypoints: [
        { id: "1", lat: 46.1, lng: 6.2, mode: "snap" as const, avoid: false },
        { id: "2", lat: 46.11, lng: 6.21, mode: "line" as const, avoid: false },
        { id: "3", lat: 46.12, lng: 6.22, mode: "snap" as const, avoid: true },
      ],
      pois: [{ id: "p", lat: 46.105, lng: 6.205, type: "summit" as const, name: "Grand Piton" }],
    };
    const code = encodeRoute(route);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = decodeRoute(code)!;
    expect(back.name).toBe(route.name);
    expect(back.activity).toBe("hike");
    expect(back.waypoints.map((w) => [w.mode, !!w.avoid])).toEqual([
      ["snap", false],
      ["line", false],
      ["snap", true],
    ]);
    expect(back.waypoints[2].lat).toBeCloseTo(46.12, 5);
    expect(back.pois[0]).toMatchObject({ type: "summit", name: "Grand Piton" });
  });
  it("returns null for garbage instead of crashing", () => {
    expect(decodeRoute("%%%")).toBeNull();
    expect(decodeRoute("")).toBeNull();
    expect(decodeRoute(btoa("{\"w\": 3}"))).toBeNull();
  });
});

describe("share links from the outside", () => {
  it("drops unknown point types instead of crashing the map", () => {
    const good = encodeRoute({ name: "x", activity: "run", waypoints: [{ id: "1", lat: 45, lng: 6, mode: "snap" }], pois: [] });
    const j = JSON.parse(atob(good.replace(/-/g, "+").replace(/_/g, "/")));
    j.p = [[45, 6, "virus", "x"], "junk", [45, 6, "water", "Fontaine"]];
    const back = decodeRoute(btoa(JSON.stringify(j)))!;
    expect(back.pois).toHaveLength(1);
    expect(back.pois[0].type).toBe("water");
  });
});
