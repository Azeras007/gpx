import { beforeEach, describe, expect, it } from "vitest";
import { cleanWaypoints, loadDraft, loadLibrary, loadPrefs, defaultPrefs } from "../src/lib/store";

beforeEach(() => localStorage.clear());

describe("stored data survives corruption", () => {
  it("broken JSON gives defaults", () => {
    localStorage.setItem("gpx-studio:prefs", "{oops");
    localStorage.setItem("gpx-studio:draft", "[[[");
    localStorage.setItem("gpx-studio:library", "42");
    expect(loadPrefs()).toEqual(defaultPrefs);
    expect(loadDraft()).toBeNull();
    expect(loadLibrary()).toEqual([]);
  });
  it("bad waypoints are dropped, good ones kept", () => {
    const w = cleanWaypoints([{ id: "a", lat: 45, lng: 6, mode: "line" }, { lat: "x", lng: 6 }, null, { lat: 95, lng: 6 }, { lat: 45.1, lng: 6.1 }]);
    expect(w).toHaveLength(2);
    expect(w[0]).toEqual({ id: "a", lat: 45, lng: 6, mode: "line", avoid: false });
    expect(w[1].mode).toBe("snap");
    expect(w[1].id).toMatch(/\w+/);
  });
  it("draft with junk is repaired", () => {
    localStorage.setItem("gpx-studio:draft", JSON.stringify({ name: 3, activity: "ski", waypoints: "no", pois: [{ lat: 1, lng: 2, type: "bomb" }] }));
    expect(loadDraft()).toEqual({ id: null, name: "Nouveau parcours", activity: "run", waypoints: [], pois: [] });
  });
  it("prefs out of range fall back", () => {
    localStorage.setItem("gpx-studio:prefs", JSON.stringify({ runPace: 0, hikeSpeed: "fast", weight: 70, view: { lat: "x" }, exportFormat: "kml" }));
    const p = loadPrefs();
    expect(p.runPace).toBe(defaultPrefs.runPace);
    expect(p.hikeSpeed).toBe(defaultPrefs.hikeSpeed);
    expect(p.weight).toBe(70);
    expect(p.view).toBeNull();
    expect(p.exportFormat).toBe("gpx");
  });
  it("library keeps valid routes only", () => {
    localStorage.setItem(
      "gpx-studio:library",
      JSON.stringify([{ id: "ok", name: "A", activity: "hike", waypoints: [{ lat: 45, lng: 6 }], distance: 1000, gain: 10, updatedAt: 1 }, { id: "empty", waypoints: [] }, "junk"]),
    );
    const lib = loadLibrary();
    expect(lib.map((r) => r.id)).toEqual(["ok"]);
    expect(lib[0].activity).toBe("hike");
  });
});
