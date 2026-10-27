import { useCallback, useReducer } from "react";
import type { Activity, Poi, Waypoint } from "./geo";
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

export const loadLibrary = () => read<SavedRoute[]>(LIB_KEY, []);
export const saveLibrary = (routes: SavedRoute[]) => write(LIB_KEY, routes);

export interface Draft {
  id: string | null;
  name: string;
  activity: Activity;
  waypoints: Waypoint[];
  pois: Poi[];
}
export const loadDraft = () => read<Draft | null>(DRAFT_KEY, null);
export const saveDraft = (d: Draft) => write(DRAFT_KEY, d);

export interface Prefs {
  baseLayer: string;
  trails: boolean;
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
export const loadPrefs = (): Prefs => ({ ...defaultPrefs, ...read<Partial<Prefs>>(PREFS_KEY, {}) });
export const savePrefs = (p: Prefs) => write(PREFS_KEY, p);
