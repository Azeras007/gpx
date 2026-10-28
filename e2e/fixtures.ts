import { test as base, expect, type Page, type Route } from "@playwright/test";
import { deflateSync } from "node:zlib";

// ── Tiny PNG encoder, for fake map and terrain tiles ────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size: number, pixel: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const BLANK = png(1, () => [235, 230, 215]);
/** Terrain tile: 1000 m rising by 0.5 m per pixel eastwards, so routes going east climb. */
const TERRAIN = png(256, (x) => {
  const v = 32768 + 1000 + Math.round(x * 0.5);
  return [Math.floor(v / 256), v % 256, 0];
});

/** Straight line between the two points with a small bend, like a routed path. */
function fakePath(a: [number, number], b: [number, number]) {
  const steps = 12;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [a[1] + (b[1] - a[1]) * t + Math.sin(t * Math.PI) * 0.0004, a[0] + (b[0] - a[0]) * t] as [number, number];
  });
}

export interface Fakes {
  /** Requests to /api/report, as sent by the app. */
  reports: Record<string, unknown>[];
  /** Answer of /api/report. */
  reportStatus: number;
  routingCalls: string[];
  /** Make the routing services fail. */
  routingDown: boolean;
  /** Console errors and page crashes seen during the test. */
  errors: string[];
}

async function install(page: Page, f: Fakes) {
  const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(/tile\.opentopomap|basemaps\.cartocdn|arcgisonline|data\.geopf\.fr|waymarkedtrails/, (r) =>
    r.fulfill({ contentType: "image/png", body: BLANK }),
  );
  await page.route(/elevation-tiles-prod\/terrarium/, (r) => r.fulfill({ contentType: "image/png", body: TERRAIN, headers: { "access-control-allow-origin": "*" } }));
  await page.route(/brouter\.de/, (r) => {
    f.routingCalls.push(r.request().url());
    if (f.routingDown) return r.fulfill({ status: 503, body: "down" });
    const m = r.request().url().match(/lonlats=([\d.-]+),([\d.-]+)\|([\d.-]+),([\d.-]+)/)!;
    const coords = fakePath([+m[2], +m[1]], [+m[4], +m[3]]);
    const messages = [
      ["Longitude", "Latitude", "Elevation", "Distance", "CostPerKm", "WayTags"],
      ["0", "0", "0", "300", "1000", "highway=residential surface=asphalt"],
      ["0", "0", "0", "500", "1000", "highway=path"],
      ["0", "0", "0", "200", "1000", "highway=track tracktype=grade3"],
    ];
    return json(r, { type: "FeatureCollection", features: [{ type: "Feature", properties: { messages }, geometry: { type: "LineString", coordinates: coords } }] });
  });
  await page.route(/routing\.openstreetmap\.de/, (r) => {
    f.routingCalls.push(r.request().url());
    if (f.routingDown) return r.fulfill({ status: 503, body: "down" });
    const m = r.request().url().match(/foot\/([\d.-]+),([\d.-]+);([\d.-]+),([\d.-]+)/)!;
    return json(r, { routes: [{ geometry: { coordinates: fakePath([+m[2], +m[1]], [+m[4], +m[3]]) } }] });
  });
  await page.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    const time: string[] = [];
    for (let i = -24; i < 24 * 7; i++) {
      const d = new Date(start.getTime() + i * 3600e3);
      const p = (n: number) => String(n).padStart(2, "0");
      time.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`);
    }
    return json(r, {
      hourly: {
        time,
        temperature_2m: time.map((_, i) => 12 + (i % 24) / 2),
        precipitation_probability: time.map((_, i) => (i % 5) * 10),
        wind_speed_10m: time.map(() => 9),
        weather_code: time.map((_, i) => [0, 2, 3, 61][i % 4]),
      },
    });
  });
  await page.route(/api\.open-meteo\.com\/v1\/elevation/, (r) => json(r, { elevation: Array(30).fill(1000) }));
  await page.route(/api\.met\.no/, (r) => r.fulfill({ status: 503 }));
  await page.route(/nominatim\.openstreetmap\.org/, (r) =>
    json(r, [
      { display_name: "Annecy, Haute-Savoie, Auvergne-Rhône-Alpes, France", name: "Annecy", lat: "45.8992", lon: "6.1294" },
      { display_name: "Lac d'Annecy, Haute-Savoie, France", name: "Lac d'Annecy", lat: "45.85", lon: "6.17" },
    ]),
  );
  await page.route(/overpass|maps\.mail\.ru/, async (r) => {
    const q = new URLSearchParams(r.request().postData() ?? "").get("data") ?? "";
    if (q.includes("drinking_water")) {
      const bb = q.match(/\(([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\)/)!.slice(1).map(Number);
      const lat = (bb[0] + bb[2]) / 2;
      const lng = (bb[1] + bb[3]) / 2;
      return json(r, {
        elements: [
          { id: 1, lat, lon: lng, tags: { amenity: "drinking_water", name: "Fontaine du test" } },
          { id: 2, lat: lat + 0.0005, lon: lng, tags: { natural: "peak", name: "Pointe du test", ele: "1234" } },
          { id: 3, lat: lat + 0.5, lon: lng, tags: { amenity: "shelter" } },
        ],
      });
    }
    if (q.includes("out tags")) {
      return json(r, { elements: [{ id: 501, tags: { name: "Sentier des Tests", ref: "PR 7", network: "lwn", roundtrip: "yes" } }] });
    }
    const bb = q.match(/out geom\(([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\)/)?.slice(1).map(Number) ?? [45.9, 6.85, 45.95, 6.9];
    const c = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    const ring = Array.from({ length: 30 }, (_, i) => ({ lat: c[0] + 0.01 * Math.sin((i / 29) * 2 * Math.PI), lon: c[1] + 0.014 * Math.cos((i / 29) * 2 * Math.PI) }));
    return json(r, { elements: [{ id: 501, members: [{ type: "way", role: "", geometry: ring }] }] });
  });
  await page.route(/api\.openstreetmap\.org\/api\/0\.6\/trackpoints/, (r) => {
    const url = new URL(r.request().url());
    const [w, s, e, n] = url.searchParams.get("bbox")!.split(",").map(Number);
    if (url.searchParams.get("page") !== "0") return r.fulfill({ contentType: "application/xml", body: `<gpx></gpx>` });
    const c = [(s + n) / 2, (w + e) / 2];
    // A 6 km running loop, one point every 5 s at ~10 km/h
    const pts: string[] = [];
    const t0 = Date.UTC(2026, 4, 3, 7, 0, 0);
    for (let i = 0; i <= 430; i++) {
      const a = (i / 430) * 2 * Math.PI;
      pts.push(`<trkpt lat="${(c[0] + 0.0085 * Math.sin(a)).toFixed(6)}" lon="${(c[1] + 0.012 * Math.cos(a)).toFixed(6)}"><time>${new Date(t0 + i * 5000).toISOString()}</time></trkpt>`);
    }
    return r.fulfill({
      contentType: "application/xml",
      body: `<?xml version="1.0"?><gpx><trk><name>Boucle matinale du lac</name><url>https://www.openstreetmap.org/user/Coureuse/traces/123</url><trkseg>${pts.join("")}</trkseg></trk></gpx>`,
    });
  });
  await page.route(/\/api\/report/, (r) => {
    f.reports.push(JSON.parse(r.request().postData() ?? "{}"));
    return json(r, { ok: f.reportStatus === 200 }, f.reportStatus);
  });
  page.on("pageerror", (e) => f.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) f.errors.push(`console: ${m.text()}`);
  });
}

export const START: [number, number] = [45.92, 6.86];

/** Opens the app with a route already drawn (straight legs: no routing needed). */
export async function openWithRoute(page: Page, pts: [number, number][] = [START, [45.925, 6.87], [45.93, 6.875], [45.928, 6.885]], extra: Record<string, unknown> = {}) {
  await page.addInitScript(
    ([pts, extra]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const waypoints = (pts as [number, number][]).map((p, i) => ({ id: `w${i}`, lat: p[0], lng: p[1], mode: "line", avoid: false }));
      localStorage.setItem("gpx-studio:draft", JSON.stringify({ id: null, name: "Parcours test", activity: "run", waypoints, pois: [] }));
      localStorage.setItem("gpx-studio:prefs", JSON.stringify({ view: { lat: 45.925, lng: 6.872, zoom: 15 }, ...(extra as object) }));
    },
    [pts, extra] as const,
  );
  await page.goto("/app.html");
  await expect(page.locator(".leaflet-container")).toBeVisible();
}

/** Opens the app empty, centered on Chamonix. */
export async function openEmpty(page: Page, prefs: Record<string, unknown> = {}) {
  await page.addInitScript((prefs) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("gpx-studio:prefs", JSON.stringify({ view: { lat: 45.925, lng: 6.872, zoom: 15 }, ...prefs }));
  }, prefs);
  await page.goto("/app.html");
  await expect(page.locator(".leaflet-container")).toBeVisible();
}

export const draft = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("gpx-studio:draft") ?? "null"));

/** Big number shown as the route distance in the sidebar, in meters. */
export async function shownDistance(page: Page) {
  const t = (await page.locator(".hero .big").innerText()).replace(/\s+/g, " ");
  const n = parseFloat(t.replace(",", "."));
  return t.includes("km") ? n * 1000 : n;
}

export const test = base.extend<{ fakes: Fakes }>({
  fakes: [
    async ({ page }, use) => {
      const f: Fakes = { reports: [], reportStatus: 200, routingCalls: [], routingDown: false, errors: [] };
      await install(page, f);
      await use(f);
    },
    { auto: true },
  ],
});
export { expect };
