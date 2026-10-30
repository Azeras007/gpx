import { cumulative, eleAt, haversine, locateOnTrack, POI_TYPES, type Activity, type LatLng, type Poi, type PoiType, type ProfilePoint } from "./geo";

const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export type ExportFormat = "gpx" | "tcx" | "gpx-route";

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; ext: string; mime: string; hint: string }> = {
  gpx: { label: "Trace", ext: "gpx", mime: "application/gpx+xml", hint: "Pour les montres : Coros, Suunto, Polar, Strava, Garmin" },
  tcx: {
    label: "Garmin",
    ext: "tcx",
    mime: "application/vnd.garmin.tcx+xml",
    hint: "Format de parcours de Garmin : distance exacte, s'importe et s'enregistre dans Garmin Connect",
  },
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
  /** Estimated duration (s), for formats that need times on every point (TCX). */
  plannedDuration?: number;
}

/**
 * The track without repeated points: zero-length steps confuse some watches
 * and Garmin Connect (distance and gradient computed over nothing).
 */
export function cleanTrack(track: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of track) if (!out.length || haversine(out[out.length - 1], p) >= 0.5) out.push(p);
  if (out.length === 1 && track.length > 1) out.push(track[track.length - 1]);
  return out;
}

/** Waypoints worth sending to a watch: those along the route (far ones can make Garmin refuse the course). */
export function poisAlong(track: LatLng[], pois: Poi[], maxOff = 300): (Poi & { d: number })[] {
  if (track.length < 2) return [];
  const cum = cumulative(track);
  return pois
    .map((p) => ({ ...p, ...locateOnTrack(track, cum, [p.lat, p.lng]) }))
    .filter((p) => p.off <= maxOff)
    .sort((a, b) => a.d - b.d)
    .map(({ off: _off, ...p }) => p);
}

function points(o: ExportOptions) {
  const track = cleanTrack(o.track);
  const cum = cumulative(track);
  const total = cum[cum.length - 1] || 1;
  const start = o.start ?? Date.now();
  return track.map(([lat, lng], i) => ({
    lat,
    lng,
    ele: eleAt(o.profile, cum[i]),
    time: o.duration ? new Date(start + (cum[i] / total) * o.duration * 1000).toISOString() : null,
  }));
}

export function buildExport(format: ExportFormat, o: ExportOptions): string {
  if (format === "tcx") return buildTcx(o);
  return buildGpx(o, format === "gpx-route");
}

/** At most `max` characters, cut at a word when possible ("Boucle du Salève" → "Boucle du"). */
export function shortName(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim() || "Parcours";
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  // At a word, unless that loses too much of the room
  const byWord = space >= max * 0.6 ? cut.slice(0, space) : clean.slice(0, max);
  return byWord.replace(/[\s,.;:&'’–—-]+$/, "") || clean.slice(0, max);
}

/** Short default names for waypoints left with their type's name. */
const SHORT_POI: Record<PoiType, string> = {
  water: "Eau",
  food: "Ravito",
  hut: "Refuge",
  summit: "Sommet",
  view: "Vue",
  danger: "Danger",
  parking: "Parking",
  note: "Note",
};

const TCX_POINT: Record<PoiType, string> = {
  water: "Water",
  food: "Food",
  hut: "Generic",
  summit: "Summit",
  view: "Generic",
  danger: "Danger",
  parking: "Generic",
  note: "Generic",
};

/**
 * Garmin's own course format. Every point carries its distance along the
 * route and a time (the estimated pace, used by the Virtual Partner), so
 * Garmin Connect shows the right distance and saves the course as is.
 */
function buildTcx(o: ExportOptions): string {
  const track = cleanTrack(o.track);
  const cum = cumulative(track);
  const total = cum[cum.length - 1] || 0;
  // Without an estimate, a steady 10 km/h keeps the times plausible
  const duration = o.duration ?? o.plannedDuration ?? total / 2.78;
  const start = o.start ?? Date.UTC(2026, 0, 1, 8, 0, 0);
  const at = (d: number) => new Date(start + (total ? (d / total) * duration * 1000 : 0)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const pos = (p: LatLng) => `<Position><LatitudeDegrees>${p[0].toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${p[1].toFixed(6)}</LongitudeDegrees></Position>`;
  const ele = (d: number) => {
    const e = eleAt(o.profile, d);
    return e != null ? `<AltitudeMeters>${e.toFixed(1)}</AltitudeMeters>` : "";
  };
  const name = esc(shortName(o.name, 15));
  const trackpoints = track
    .map((p, i) => `        <Trackpoint><Time>${at(cum[i])}</Time>${pos(p)}${ele(cum[i])}<DistanceMeters>${cum[i].toFixed(1)}</DistanceMeters></Trackpoint>`)
    .join("\n");
  const coursePoints = poisAlong(track, o.pois)
    .map((p) => {
      const label = !p.name.trim() || p.name === POI_TYPES[p.type].label ? SHORT_POI[p.type] : shortName(p.name, 10);
      return (
        `    <CoursePoint><Name>${esc(label)}</Name><Time>${at(p.d)}</Time>${pos([p.lat, p.lng])}${ele(p.d)}` +
        `<PointType>${TCX_POINT[p.type]}</PointType>${label !== p.name ? `<Notes>${esc(p.name)}</Notes>` : ""}</CoursePoint>`
      );
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Courses>
    <Course>
      <Name>${name}</Name>
      <Lap>
        <TotalTimeSeconds>${duration.toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${total.toFixed(1)}</DistanceMeters>
        <BeginPosition><LatitudeDegrees>${track[0][0].toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${track[0][1].toFixed(6)}</LongitudeDegrees></BeginPosition>
        <EndPosition><LatitudeDegrees>${track[track.length - 1][0].toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${track[track.length - 1][1].toFixed(6)}</LongitudeDegrees></EndPosition>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
${trackpoints}
      </Track>
${o.name.trim().length > 15 ? `      <Notes>${esc(o.name.trim())}</Notes>\n` : ""}${coursePoints ? coursePoints.replace(/^ {4}/gm, "      ") + "\n" : ""}    </Course>
  </Courses>
</TrainingCenterDatabase>
`;
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
  // A hiking GPS may want a parking or a hut a little off the way: 1 km
  const wpts = poisAlong(o.track, o.pois, 1000)
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
