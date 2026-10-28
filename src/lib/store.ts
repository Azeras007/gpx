import { useCallback, useReducer } from "react";
import { POI_TYPES, type Activity, type Poi, type Waypoint } from "./geo";
import type { RoutingProfile } from "./services";
import type { ExportFormat } from "./gpx";

interface History {
  past: Waypoint[][];
  present: Waypoint[];
  future: Waypoint[][];
}

type Action =
  | { type: "set"; waypoints: Waypoint[] }
  | { type: "undo" }
  | { type: "redo" };

function reducer(s: History, a: Action): History {
  switch (a.type) {
    case "set":
      if (a.waypoints === s.present) return s;
      return { past: [...s.past, s.present].slice(-200), present: a.waypoints, future: [] };
    case "undo":
      if (!s.past.length) return s;
      return { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] };
    case "redo":
      if (!s.future.length) return s;
      return { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) };
  }
}

export function useWaypointHistory(initial: Waypoint[]) {
  const [state, dispatch] = useReducer(reducer, { past: [], present: initial, future: [] });
  const set = useCallback((waypoints: Waypoint[]) => dispatch({ type: "set", waypoints }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  return {
    waypoints: state.present,
    set,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}

export interface SavedRoute {
  id: string;
  name: string;
  activity: Activity;
  waypoints: Waypoint[];
  pois?: Poi[];
  distance: number;
  gain: number;
  updatedAt: number;
}

const LIB_KEY = "gpx-studio:library";
const DRAFT_KEY = "gpx-studio:draft";
const PREFS_KEY = "gpx-studio:prefs";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && isFinite(v);

/** Keeps only well-formed points: one broken entry in storage must not crash the map. */
export function cleanWaypoints(list: unknown): Waypoint[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => w && finite(w.lat) && finite(w.lng) && Math.abs(w.lat) <= 90 && Math.abs(w.lng) <= 180)
    .map((w) => ({
      id: typeof w.id === "string" && w.id ? w.id : Math.random().toString(36).slice(2, 10),
      lat: w.lat,
      lng: w.lng,
      mode: w.mode === "line" ? "line" : "snap",
      avoid: !!w.avoid,
    }));
}

export function cleanPois(list: unknown): Poi[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && finite(p.lat) && finite(p.lng) && typeof p.type === "string" && p.type in POI_TYPES)
    .map((p) => ({ id: typeof p.id === "string" ? p.id : Math.random().toString(36).slice(2, 10), lat: p.lat, lng: p.lng, type: p.type, name: String(p.name ?? "") }));
}

export const loadLibrary = (): SavedRoute[] => {
  const raw = read<unknown>(LIB_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.id === "string")
    .map((r) => ({
      id: r.id,
      name: String(r.name ?? "Parcours"),
      activity: (r.activity === "hike" ? "hike" : "run") as Activity,
      waypoints: cleanWaypoints(r.waypoints),
      pois: cleanPois(r.pois),
      distance: finite(r.distance) ? r.distance : 0,
      gain: finite(r.gain) ? r.gain : 0,
      updatedAt: finite(r.updatedAt) ? r.updatedAt : Date.now(),
    }))
    .filter((r) => r.waypoints.length > 0);
};
export const saveLibrary = (routes: SavedRoute[]) => write(LIB_KEY, routes);

export interface Draft {
  id: string | null;
  name: string;
  activity: Activity;
  waypoints: Waypoint[];
  pois: Poi[];
}
export const loadDraft = (): Draft | null => {
  const d = read<Partial<Draft> | null>(DRAFT_KEY, null);
  if (!d || typeof d !== "object") return null;
  return {
    id: typeof d.id === "string" ? d.id : null,
    name: typeof d.name === "string" ? d.name : "Nouveau parcours",
    activity: d.activity === "hike" ? "hike" : "run",
    waypoints: cleanWaypoints(d.waypoints),
    pois: cleanPois(d.pois),
  };
};
export const saveDraft = (d: Draft) => write(DRAFT_KEY, d);

export interface Prefs {
  baseLayer: string;
  trails: boolean;
  hillshade: boolean;
  slopeColors: boolean;
  runPace: number;
  hikeSpeed: number;
  mode: "snap" | "line";
  profile: RoutingProfile;
  avoid: boolean;
  weight: number;
  /** Planned start, "YYYY-MM-DDTHH:mm" local time; empty = not planned. */
  start: string;
  exportFormat: ExportFormat;
  view: { lat: number; lng: number; zoom: number } | null;
}
export const defaultPrefs: Prefs = {
  baseLayer: "topo",
  trails: false,
  hillshade: false,
  slopeColors: false,
  runPace: 6,
  hikeSpeed: 4.5,
  mode: "snap",
  profile: "trails",
  avoid: false,
  weight: 70,
  start: "",
  exportFormat: "gpx",
  view: null,
};
export const loadPrefs = (): Prefs => {
  const stored = read<Partial<Prefs>>(PREFS_KEY, {});
  const p = { ...defaultPrefs, ...(stored && typeof stored === "object" ? stored : {}) };
  // Out-of-range numbers (older versions, hand edits) fall back to the defaults
  const within = (v: unknown, lo: number, hi: number, d: number) => (finite(v) && v >= lo && v <= hi ? v : d);
  p.runPace = within(p.runPace, 2.5, 15, defaultPrefs.runPace);
  p.hikeSpeed = within(p.hikeSpeed, 1, 9, defaultPrefs.hikeSpeed);
  p.weight = within(p.weight, 25, 250, defaultPrefs.weight);
  if (p.mode !== "snap" && p.mode !== "line") p.mode = "snap";
  if (p.profile !== "trails" && p.profile !== "roads") p.profile = "trails";
  if (typeof p.start !== "string") p.start = "";
  const v = p.view;
  if (v && !(finite(v.lat) && finite(v.lng) && finite(v.zoom) && Math.abs(v.lat) <= 85)) p.view = null;
  // KML and GeoJSON exports were removed: fall back to GPX for older saved prefs.
  if (p.exportFormat !== "gpx" && p.exportFormat !== "gpx-route") p.exportFormat = "gpx";
  return p;
};
export const savePrefs = (p: Prefs) => write(PREFS_KEY, p);
