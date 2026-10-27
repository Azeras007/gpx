import { cumulative, eleAt, POI_TYPES, type Activity, type LatLng, type Poi, type ProfilePoint } from "./geo";

const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export type ExportFormat = "gpx" | "gpx-route";

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; ext: string; mime: string; hint: string }> = {
  gpx: { label: "Trace", ext: "gpx", mime: "application/gpx+xml", hint: "Pour les montres : Garmin, Coros, Suunto, Polar, Strava" },
  "gpx-route": { label: "Itinéraire", ext: "gpx", mime: "application/gpx+xml", hint: "Pour les GPS de randonnée qui suivent un itinéraire (rte)" },
};

export interface ExportOptions {
  name: string;
  activity: Activity;
  track: LatLng[];
  profile: ProfilePoint[];
  pois: Poi[];
  /** Total estimated duration in seconds; when set, timestamps are written. */
  duration?: number;
  /** Start time (ms since epoch) used for the timestamps. */
  start?: number;
}

function points(o: ExportOptions) {
  const cum = cumulative(o.track);
  const total = cum[cum.length - 1] || 1;
  const start = o.start ?? Date.now();
  return o.track.map(([lat, lng], i) => ({
    lat,
    lng,
    ele: eleAt(o.profile, cum[i]),
    time: o.duration ? new Date(start + (cum[i] / total) * o.duration * 1000).toISOString() : null,
  }));
}

export function buildExport(format: ExportFormat, o: ExportOptions): string {
  return buildGpx(o, format === "gpx-route");
}

function buildGpx(o: ExportOptions, asRoute: boolean): string {
  const tag = asRoute ? "rtept" : "trkpt";
  const pts = points(o)
    .map(
      (p) =>
        `      <${tag} lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">` +
        (p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : "") +
        (p.time && !asRoute ? `<time>${p.time}</time>` : "") +
        `</${tag}>`,
    )
    .join("\n");
  const wpts = o.pois
    .map(
      (w) =>
        `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lng.toFixed(6)}">\n    <name>${esc(w.name)}</name>\n` +
        `    <sym>${POI_TYPES[w.type].sym}</sym>\n    <type>${esc(POI_TYPES[w.type].label)}</type>\n  </wpt>`,
    )
    .join("\n");
  const type = o.activity === "run" ? "running" : "hiking";
  const body = asRoute
    ? `  <rte>\n    <name>${esc(o.name)}</name>\n    <type>${type}</type>\n${pts.replace(/^ {2}/gm, "")}\n  </rte>`
    : `  <trk>\n    <name>${esc(o.name)}</name>\n    <type>${type}</type>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Studio" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(o.name)}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
${wpts ? wpts + "\n" : ""}${body}
</gpx>
`;
}

export function downloadFile(filename: string, content: string, mime = "application/gpx+xml") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "trace";

export interface ParsedGpx {
  name: string | null;
  points: LatLng[];
  /** Named waypoints that come alongside a track or route. */
  pois: { lat: number; lng: number; name: string }[];
}

/** Reads track points, then route points, then waypoints from a GPX file. */
export function parseGpx(xml: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Fichier GPX invalide");
  const read = (tag: string) =>
    Array.from(doc.getElementsByTagName(tag))
      .map((el) => [parseFloat(el.getAttribute("lat") ?? ""), parseFloat(el.getAttribute("lon") ?? "")] as LatLng)
      .filter(([a, b]) => isFinite(a) && isFinite(b));
  let points = read("trkpt");
  if (points.length < 2) points = read("rtept");
  const wpts = Array.from(doc.getElementsByTagName("wpt"));
  const pois =
    points.length >= 2
      ? wpts
          .map((el) => ({
            lat: parseFloat(el.getAttribute("lat") ?? ""),
            lng: parseFloat(el.getAttribute("lon") ?? ""),
            name: el.getElementsByTagName("name")[0]?.textContent?.trim() || "Repère",
          }))
          .filter((w) => isFinite(w.lat) && isFinite(w.lng))
      : [];
  if (points.length < 2) points = read("wpt");
  if (points.length < 2) throw new Error("Aucune trace trouvée dans ce fichier");
  const name =
    doc.querySelector("trk > name")?.textContent ??
    doc.querySelector("metadata > name")?.textContent ??
    doc.querySelector("rte > name")?.textContent ??
    null;
  return { name: name?.trim() || null, points, pois };
}
