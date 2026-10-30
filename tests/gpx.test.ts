import { describe, expect, it } from "vitest";
import { buildExport, parseGpx, slugify } from "../src/lib/gpx";
import { destination, type LatLng, type ProfilePoint } from "../src/lib/geo";

const track: LatLng[] = Array.from({ length: 5 }, (_, i) => destination([45.9, 6.86], i * 250, 30));
const profile: ProfilePoint[] = track.map((p, i) => ({ lat: p[0], lng: p[1], d: i * 250, ele: 1000 + i * 10 }));
const base = { name: "Tour du lac <d'Annecy> & co", activity: "hike" as const, track, profile, pois: [] };

describe("GPX export", () => {
  it("writes a valid track that reads back identically", () => {
    const xml = buildExport("gpx", {
      ...base,
      pois: [{ id: "a", lat: 45.91, lng: 6.87, type: "water", name: "Source \"froide\"" }],
    });
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(xml).toContain("<type>hiking</type>");
    expect(xml).toContain("<ele>1020.0</ele>");
    const back = parseGpx(xml);
    expect(back.name).toBe("Tour du lac <d'Annecy> & co");
    expect(back.points).toHaveLength(5);
    back.points.forEach((p, i) => expect(p[0]).toBeCloseTo(track[i][0], 6));
    expect(back.pois).toEqual([{ lat: 45.91, lng: 6.87, name: 'Source "froide"' }]);
  });
  it("adds increasing timestamps for the virtual partner", () => {
    const start = Date.UTC(2026, 5, 1, 8, 0);
    const xml = buildExport("gpx", { ...base, duration: 3600, start });
    const times = [...xml.matchAll(/<time>([^<]+)<\/time>/g)].map((m) => Date.parse(m[1])).slice(1);
    expect(times[0]).toBe(start);
    expect(times.at(-1)).toBe(start + 3600_000);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });
  it("route format uses rtept and no times", () => {
    const xml = buildExport("gpx-route", { ...base, duration: 3600 });
    expect(xml).toContain("<rtept");
    expect(xml).not.toContain("<trkpt");
    expect(xml.match(/<time>/g)).toHaveLength(1); // metadata only
    expect(parseGpx(xml).points).toHaveLength(5);
  });
});

describe("GPX import", () => {
  const wrap = (body: string) => `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;
  it("reads tracks split in several segments", () => {
    const g = parseGpx(
      wrap(`<trk><name>Deux segments</name><trkseg><trkpt lat="45" lon="6"/><trkpt lat="45.01" lon="6"/></trkseg>
      <trkseg><trkpt lat="45.02" lon="6"/></trkseg></trk>`),
    );
    expect(g.points).toHaveLength(3);
    expect(g.name).toBe("Deux segments");
  });
  it("falls back on route points, then waypoints", () => {
    expect(parseGpx(wrap(`<rte><rtept lat="1" lon="2"/><rtept lat="1.1" lon="2"/></rte>`)).points).toHaveLength(2);
    const w = parseGpx(wrap(`<wpt lat="1" lon="2"/><wpt lat="1.1" lon="2"/>`));
    expect(w.points).toHaveLength(2);
    expect(w.pois).toEqual([]);
  });
  it("skips points with broken coordinates", () => {
    const g = parseGpx(wrap(`<trk><trkseg><trkpt lat="45" lon="6"/><trkpt lat="abc" lon="6"/><trkpt lat="45.1" lon="6"/></trkseg></trk>`));
    expect(g.points).toHaveLength(2);
  });
  it("reads GPX 1.0 and files without namespace", () => {
    const g = parseGpx(`<gpx version="1.0"><trk><trkseg><trkpt lat="45" lon="6"></trkpt><trkpt lat="45.1" lon="6.1"></trkpt></trkseg></trk></gpx>`);
    expect(g.points).toHaveLength(2);
  });
  it("rejects files that are not GPX or hold no route", () => {
    expect(() => parseGpx("not xml at all <<<")).toThrow();
    expect(() => parseGpx(wrap(""))).toThrow("Aucune trace");
  });
});

describe("slugify", () => {
  it("makes safe file names", () => {
    expect(slugify("Tour du Mont-Blanc — étape 3 !")).toBe("tour-du-mont-blanc-etape-3");
    expect(slugify("???")).toBe("trace");
  });
});

describe("Garmin course (TCX)", () => {
  const long = Array.from({ length: 30 }, (_, i) => destination([45.9, 6.86], i * 100, 70));
  const dup: LatLng[] = [long[0], long[0], ...long.slice(1), long.at(-1)!];
  const prof = long.map((p, i) => ({ lat: p[0], lng: p[1], d: i * 100, ele: 900 + i * 5 }));
  const xml = buildExport("tcx", {
    name: "Tour du lac d'Annecy & co",
    activity: "run",
    track: dup,
    profile: prof,
    plannedDuration: 1800,
    pois: [
      { id: "a", lat: long[10][0], lng: long[10][1], type: "water", name: "Point d'eau" },
      { id: "b", lat: long[20][0], lng: long[20][1], type: "summit", name: "Pointe de la Tournette" },
      { id: "c", lat: 46.5, lng: 7.2, type: "view", name: "Très loin" },
    ],
  });
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const all = (sel: string) => Array.from(doc.getElementsByTagName(sel));
  it("is well formed with Garmin's limits on names", () => {
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(all("Name")[0].textContent).toBe("Tour du lac");
    expect(all("Notes")[0].textContent).toBe("Tour du lac d'Annecy & co");
    for (const n of all("CoursePoint")) expect(n.getElementsByTagName("Name")[0].textContent!.length).toBeLessThanOrEqual(10);
  });
  it("has one point per place, increasing distances and times", () => {
    const tp = all("Trackpoint");
    expect(tp).toHaveLength(30);
    const d = tp.map((t) => Number(t.getElementsByTagName("DistanceMeters")[0].textContent));
    const t = tp.map((x) => Date.parse(x.getElementsByTagName("Time")[0].textContent!));
    for (let i = 1; i < tp.length; i++) {
      expect(d[i]).toBeGreaterThan(d[i - 1]);
      expect(t[i]).toBeGreaterThan(t[i - 1]);
    }
    expect(t.at(-1)! - t[0]).toBe(1800_000);
    expect(Number(all("DistanceMeters")[0].textContent)).toBeCloseTo(2900, 0);
  });
  it("keeps the waypoints along the route, with Garmin types", () => {
    const cp = all("CoursePoint").map((c) => [c.getElementsByTagName("Name")[0].textContent, c.getElementsByTagName("PointType")[0].textContent]);
    expect(cp).toEqual([
      ["Eau", "Water"],
      ["Pointe de", "Summit"],
    ]);
  });
  it("the GPX drops repeated points and far waypoints too", () => {
    const g = buildExport("gpx", { name: "x", activity: "run", track: dup, profile: prof, pois: [{ id: "c", lat: 46.5, lng: 7.2, type: "view", name: "Loin" }] });
    expect(g.match(/<trkpt/g)).toHaveLength(30);
    expect(g).not.toContain("<wpt");
  });
});

describe("shortName", () => {
  it("cuts at a word when it can", async () => {
    const { shortName } = await import("../src/lib/gpx");
    expect(shortName("Boucle d'été & co du Ventoux", 15)).toBe("Boucle d'été");
    expect(shortName("Court", 15)).toBe("Court");
    expect(shortName("Anticonstitutionnellement", 10)).toBe("Anticonsti");
    expect(shortName("   ", 10)).toBe("Parcours");
  });
});

describe("Garmin app GPX", () => {
  const track: LatLng[] = Array.from({ length: 5 }, (_, i) => destination([45.9, 6.86], i * 100, 0));
  it("is a plain track without waypoints", () => {
    const xml = buildExport("garmin", { name: "x", activity: "run", track, profile: [], pois: [{ id: "a", lat: track[2][0], lng: track[2][1], type: "water", name: "Eau" }] });
    expect(xml).not.toContain("<wpt");
    expect(parseGpx(xml).points).toHaveLength(5);
  });
  it("always has a time on every point, like the files the app saves", () => {
    const start = Date.UTC(2026, 9, 28, 14, 0);
    const xml = buildExport("garmin", { name: "x", activity: "run", track, profile: [], pois: [], plannedDuration: 600, start });
    const times = [...xml.matchAll(/<trkpt[^>]*>.*?<time>([^<]+)<\/time><\/trkpt>/g)].map((m) => Date.parse(m[1]));
    expect(times).toHaveLength(5);
    expect(times[0]).toBe(start);
    expect(times[4]).toBe(start + 600_000);
    // Even without any estimate
    const bare = buildExport("garmin", { name: "x", activity: "run", track, profile: [], pois: [] });
    expect(bare.match(/<trkpt/g)).toHaveLength(5);
    expect(bare.match(/<time>/g)).toHaveLength(6); // metadata + 5 points
  });
});
