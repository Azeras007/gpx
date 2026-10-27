import { cumulative, eleAt, type Activity, type LatLng, type ProfilePoint } from "./geo";

const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export interface ExportOptions {
  name: string;
  activity: Activity;
  track: LatLng[];
  profile: ProfilePoint[];
  /** Total estimated duration in seconds; when set, timestamps are written. */
  duration?: number;
}

export function buildGpx({ name, activity, track, profile, duration }: ExportOptions): string {
  const cum = cumulative(track);
  const total = cum[cum.length - 1] || 1;
  const start = Date.now();
  const pts = track
    .map(([lat, lng], i) => {
      const ele = eleAt(profile, cum[i]);
      const time = duration ? new Date(start + (cum[i] / total) * duration * 1000).toISOString() : null;
      return (
        `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">` +
        (ele != null ? `<ele>${ele.toFixed(1)}</ele>` : "") +
        (time ? `<time>${time}</time>` : "") +
        `</trkpt>`
      );
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Studio" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(name)}</name>
    <time>${new Date(start).toISOString()}</time>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>${activity === "run" ? "running" : "hiking"}</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
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
  if (points.length < 2) points = read("wpt");
  if (points.length < 2) throw new Error("Aucune trace trouvée dans ce fichier");
  const name =
    doc.querySelector("trk > name")?.textContent ??
    doc.querySelector("metadata > name")?.textContent ??
    doc.querySelector("rte > name")?.textContent ??
    null;
  return { name: name?.trim() || null, points };
}
