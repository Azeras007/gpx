// What the route runs on, from the OpenStreetMap tags BRouter returns with
// each stretch of a leg: road (paved), track (unpaved, wide) or trail.

export type Surface = "paved" | "track" | "trail" | "unknown";

export const SURFACES: Record<Surface, { label: string; color: string; hint: string }> = {
  paved: { label: "Bitume", color: "#57534a", hint: "routes, rues et trottoirs revêtus" },
  track: { label: "Chemin", color: "#c9a23a", hint: "pistes et chemins de terre ou de gravier" },
  trail: { label: "Sentier", color: "#2e5a45", hint: "sentiers et passages étroits" },
  unknown: { label: "Inconnu", color: "#cbc1ad", hint: "segments en ligne droite ou sans information" },
};

export type SurfaceMix = Record<Surface, number>;

export const emptyMix = (): SurfaceMix => ({ paved: 0, track: 0, trail: 0, unknown: 0 });

const PAVED = /^(paved|asphalt|concrete(:.*)?|paving_stones|sett|cobblestone|unhewn_cobblestone|metal|wood|chipseal|bricks?|tartan|artificial_turf|rubber)$/;
const UNPAVED = /^(unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|grass|grass_paver|mud|sand|rock|rocks|pebblestone|stone|woodchips|snow|ice|salt)$/;
const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|pedestrian|road|cycleway|busway)(_link)?$/;
const TRAILS = /^(path|bridleway|steps|via_ferrata|scramble)$/;

/** Kind of ground for one stretch, from its tags ("highway=path surface=dirt …"). */
export function classify(wayTags: string): Surface {
  const tags = new Map(
    wayTags
      .split(" ")
      .map((kv) => kv.split("="))
      .filter((p) => p.length === 2) as [string, string][],
  );
  const highway = tags.get("highway") ?? "";
  const surface = tags.get("surface") ?? "";
  const narrow = TRAILS.test(highway) || (highway === "footway" && UNPAVED.test(surface));
  if (PAVED.test(surface)) return "paved";
  if (UNPAVED.test(surface)) return narrow ? "trail" : "track";
  // No surface given: the kind of way says it
  if (ROADS.test(highway) || highway === "footway") return "paved";
  if (highway === "track") {
    const grade = tags.get("tracktype");
    return grade === "grade1" ? "paved" : "track";
  }
  if (TRAILS.test(highway)) return "trail";
  return "unknown";
}

/** Meters of each kind of ground in a BRouter answer (its "messages" table). */
export function mixFromBrouter(messages: unknown): SurfaceMix | null {
  if (!Array.isArray(messages) || messages.length < 2 || !Array.isArray(messages[0])) return null;
  const head = messages[0] as string[];
  const di = head.indexOf("Distance");
  const ti = head.indexOf("WayTags");
  if (di < 0 || ti < 0) return null;
  const mix = emptyMix();
  for (const row of messages.slice(1) as string[][]) {
    const d = Number(row[di]);
    if (isFinite(d) && d > 0) mix[classify(String(row[ti] ?? ""))] += d;
  }
  return mix;
}

export function addMix(a: SurfaceMix, b: SurfaceMix): SurfaceMix {
  return { paved: a.paved + b.paved, track: a.track + b.track, trail: a.trail + b.trail, unknown: a.unknown + b.unknown };
}

/**
 * Shares of the route, scaled to its real length: what the router could not
 * describe (straight lines, other engine) counts as unknown.
 */
export function shares(mix: SurfaceMix, total: number): { kind: Surface; meters: number; pct: number }[] {
  const known = mix.paved + mix.track + mix.trail;
  const scale = known + mix.unknown > total && total > 0 ? total / (known + mix.unknown) : 1;
  const out = (["paved", "track", "trail"] as const).map((kind) => ({ kind, meters: mix[kind] * scale }));
  const rest = Math.max(0, total - out.reduce((a, s) => a + s.meters, 0));
  const all = [...out, { kind: "unknown" as const, meters: rest }];
  return all.map((s) => ({ ...s, pct: total > 0 ? (s.meters / total) * 100 : 0 }));
}
