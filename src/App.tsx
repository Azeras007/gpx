import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type L from "leaflet";
import {
  ArrowLeftRight,
  ArrowUpDown,
  CalendarClock,
  Compass,
  Clock,
  Download,
  Flame,
  Footprints,
  FolderOpen,
  Gauge,
  HelpCircle,
  ImageDown,
  Layers,
  Link2,
  LocateFixed,
  Maximize2,
  Mountain,
  PenLine,
  Play,
  Redo2,
  Repeat,
  Route,
  Ruler,
  Save,
  Search,
  Shuffle,
  Sparkles,
  Spline,
  Square,
  Trash2,
  TrendingDown,
  TrendingUp,
  Undo2,
  Upload,
  Waypoints,
  X,
} from "lucide-react";
import MapView, { BASE_LAYERS, OSM_KINDS } from "./components/MapView";
import ElevationChart from "./components/ElevationChart";
import Planner from "./components/Planner";
import {
  calories,
  computeSplits,
  computeStats,
  cumulative,
  destination,
  difficulty,
  estimateDuration,
  findOverlaps,
  formatDistance,
  formatDuration,
  formatPace,
  haversine,
  locateOnTrack,
  pointAt,
  POI_TYPES,
  resample,
  sampleEvery,
  simplify,
  slopeColor,
  uid,
  type Activity,
  type LatLng,
  type Poi,
  type PoiType,
  type ProfilePoint,
  type SegmentMode,
  type Waypoint,
} from "./lib/geo";
import { buildExport, downloadFile, EXPORT_FORMATS, parseGpx, slugify, type ExportFormat } from "./lib/gpx";
import { fetchElevations, fetchOsmPois, routeLeg, searchPlaces, type Nogo, type OsmPoi, type Place } from "./lib/services";
import { renderCard } from "./lib/shareImage";
import { decodeRoute, encodeRoute } from "./lib/share";
import {
  loadDraft,
  loadLibrary,
  loadPrefs,
  saveDraft,
  saveLibrary,
  savePrefs,
  useWaypointHistory,
  type Prefs,
  type SavedRoute,
} from "./lib/store";

const ACCENTS: Record<Activity, string> = { run: "#ff5a36", hike: "#10b981" };

const coordKey = (w: { lat: number; lng: number }) => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`;

/** Small string hash, enough to tell route prefixes apart in cache keys. */
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Circles placed along the part of the route already drawn. They are handed to
 * the router as costly areas so the next leg looks for other paths. Circles
 * near the leg's own ends are skipped, otherwise the leg could not start.
 */
function buildNogos(prev: LatLng[], a: LatLng, b: LatLng): Nogo[] {
  const length = cumulative(prev).at(-1) ?? 0;
  if (length < 50) return [];
  const step = Math.max(40, length / 140);
  const radius = Math.max(25, step * 0.65);
  const clear = radius + 60;
  return sampleEvery(prev, step)
    .filter(({ p }) => haversine(p, a) > clear && haversine(p, b) > clear)
    .map(({ p }) => ({ lat: p[0], lng: p[1], radius }));
}

type LegState = LatLng[] | "pending" | "error";
type Tab = "trace" | "plan" | "library";

interface Toast {
  id: string;
  text: string;
  tone: "info" | "error" | "success";
}

interface LoopRequest {
  target: number;
  bearing: number;
  /** Ratio between the circle drawn and the target, tuned after each try. */
  k: number;
  attempts: number;
}

function initialRoute() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (m) {
    const shared = decodeRoute(m[1]);
    history.replaceState(null, "", location.pathname + location.search);
    if (shared) return { id: null, ...shared, fromLink: true };
  }
  const d = loadDraft();
  return { id: d?.id ?? null, name: d?.name, activity: d?.activity, waypoints: d?.waypoints ?? [], pois: d?.pois ?? [], fromLink: false };
}

export default function App() {
  const init = useMemo(initialRoute, []);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [name, setName] = useState(init.name ?? "Nouveau parcours");
  const [activity, setActivity] = useState<Activity>(init.activity ?? "run");
  const [currentId, setCurrentId] = useState<string | null>(init.id);
  const { waypoints, set, undo, redo, canUndo, canRedo } = useWaypointHistory(init.waypoints);
  const [pois, setPois] = useState<Poi[]>(init.pois);
  const [placing, setPlacing] = useState<PoiType | null>(null);
  const [library, setLibrary] = useState<SavedRoute[]>(loadLibrary);
  const [legCache, setLegCache] = useState<Map<string, LegState>>(() => new Map());
  const [profile, setProfile] = useState<ProfilePoint[]>([]);
  const [eleLoading, setEleLoading] = useState(false);
  const [hover, setHover] = useState<LatLng | null>(null);
  /** Distance along the route under the mouse on the map (drives the profile cursor). */
  const [routeHoverD, setRouteHoverD] = useState<number | null>(null);
  const [osmPois, setOsmPois] = useState<OsmPoi[]>([]);
  const [osmLoading, setOsmLoading] = useState(false);
  const [replay, setReplay] = useState<{ d: number; playing: boolean } | null>(null);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [dragOver, setDragOver] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [withTimes, setWithTimes] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("trace");
  const [loopKm, setLoopKm] = useState(10);
  const [loop, setLoop] = useState<LoopRequest | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const accent = ACCENTS[activity];

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = uid();
    setToasts((t) => [...t.filter((x) => x.text !== text), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  useEffect(() => {
    if (init.fromLink) toast("Parcours partagé chargé", "success");
  }, [init.fromLink, toast]);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  useEffect(() => savePrefs(prefs), [prefs]);
  useEffect(() => saveDraft({ id: currentId, name, activity, waypoints, pois }), [currentId, name, activity, waypoints, pois]);

  /** Every manual edit cancels an automatic loop still being tuned. */
  const edit = useCallback(
    (wps: Waypoint[]) => {
      setLoop(null);
      set(wps);
    },
    [set],
  );

  // ── Routing ────────────────────────────────────────────────────────────────
  // A leg that avoids earlier paths depends on everything drawn before it, so
  // its cache key includes a hash of the previous waypoints.
  const legKeys = useMemo(() => {
    const keys: string[] = [];
    let prefix = "";
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      prefix += `${coordKey(a)}${a.mode[0]}${a.avoid ? 1 : 0};`;
      const base = `${coordKey(a)}|${coordKey(b)}|${prefs.profile}`;
      keys.push(b.avoid ? `${base}|av:${hash(prefix)}` : base);
    }
    return keys;
  }, [waypoints, prefs.profile]);

  const { legs, pendingLegs } = useMemo(() => {
    const legs: LatLng[][] = [];
    const pendingLegs: boolean[] = [];
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      const st = b.mode === "snap" ? legCache.get(legKeys[i - 1]) : undefined;
      legs.push(
        Array.isArray(st)
          ? st
          : [
              [a.lat, a.lng],
              [b.lat, b.lng],
            ],
      );
      pendingLegs.push(b.mode === "snap" && (st === undefined || st === "pending"));
    }
    return { legs, pendingLegs };
  }, [waypoints, legCache, legKeys]);

  const inflight = useRef(new Set<string>());
  useEffect(() => {
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      if (b.mode !== "snap") continue;
      const k = legKeys[i - 1];
      if (legCache.has(k) || inflight.current.has(k)) continue;
      let nogos: Nogo[] = [];
      if (b.avoid) {
        // Wait until every earlier leg is known: they are what we avoid.
        if (pendingLegs.slice(0, i - 1).some(Boolean)) continue;
        nogos = buildNogos(legs.slice(0, i - 1).flat(), [a.lat, a.lng], [b.lat, b.lng]);
      }
      inflight.current.add(k);
      setLegCache((c) => new Map(c).set(k, "pending"));
      routeLeg([a.lat, a.lng], [b.lat, b.lng], { profile: prefs.profile, nogos })
        .then((r) => {
          setLegCache((c) => new Map(c).set(k, r.coords));
          if (r.degraded === "no-avoid") toast("Impossible d'éviter les passages déjà faits sur un segment.", "error");
        })
        .catch(() => {
          setLegCache((c) => new Map(c).set(k, "error"));
          toast("Aucun chemin trouvé pour ce segment — tracé en ligne droite.", "error");
        })
        .finally(() => inflight.current.delete(k));
    }
  }, [waypoints, legKeys, legCache, legs, pendingLegs, prefs.profile, toast]);

  const track = useMemo<LatLng[]>(() => {
    if (waypoints.length === 1) return [[waypoints[0].lat, waypoints[0].lng]];
    const out: LatLng[] = [];
    legs.forEach((leg, i) => out.push(...(i === 0 ? leg : leg.slice(1))));
    return out;
  }, [legs, waypoints]);

  const cum = useMemo(() => cumulative(track), [track]);
  const distance = cum.length ? cum[cum.length - 1] : 0;
  const routing = pendingLegs.some(Boolean);
  const baseProfile = useMemo(() => resample(track), [track]);
  const overlaps = useMemo(() => (routing ? { length: 0, lines: [], ranges: [] } : findOverlaps(track)), [track, routing]);

  // ── Elevation profile (debounced, waits for routing to settle) ─────────────
  useEffect(() => {
    if (track.length < 2 || distance < 1) {
      setProfile([]);
      return;
    }
    if (routing) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setEleLoading(true);
      fetchElevations(baseProfile, ctrl.signal)
        .then(setProfile)
        .catch((e) => {
          if (e.name !== "AbortError") toast("Altitudes indisponibles pour le moment.", "error");
        })
        .finally(() => !ctrl.signal.aborted && setEleLoading(false));
    }, 450);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [track, baseProfile, distance, routing, toast]);

  // Elevations arrive a bit after the route changes (or not at all when the
  // service is down): until then, distances still come from the route itself
  // so splits and times never go blank.
  const liveProfile = useMemo(
    () => (profile.length > 1 && Math.abs(profile[profile.length - 1].d - distance) < 1 ? profile : baseProfile),
    [profile, baseProfile, distance],
  );
  const stats = useMemo(() => computeStats(distance, liveProfile), [distance, liveProfile]);
  const duration = estimateDuration(activity, stats, prefs.runPace, prefs.hikeSpeed);
  const level = difficulty(stats);
  const kcal = calories(activity, stats, prefs.weight);
  const splits = useMemo(
    () => computeSplits(activity, liveProfile, distance, prefs.runPace, prefs.hikeSpeed, duration),
    [activity, liveProfile, distance, prefs.runPace, prefs.hikeSpeed, duration],
  );

  const kmMarks = useMemo(() => {
    const step = distance < 25000 ? 1000 : distance < 60000 ? 2000 : 5000;
    const marks: { pos: LatLng; km: number }[] = [];
    let next = step;
    for (let i = 1; i < track.length && next < distance; i++) {
      while (cum[i] >= next && next < distance) {
        const t = (next - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        marks.push({
          pos: [track[i - 1][0] + (track[i][0] - track[i - 1][0]) * t, track[i - 1][1] + (track[i][1] - track[i - 1][1]) * t],
          km: next / 1000,
        });
        next += step;
      }
    }
    return marks;
  }, [track, cum, distance]);

  const poisOnRoute = useMemo(
    () =>
      pois.map((p) => {
        if (track.length < 2) return { ...p, d: null };
        const at = locateOnTrack(track, cum, [p.lat, p.lng]);
        return { ...p, d: at.off < 200 ? at.d : null };
      }),
    [pois, track, cum],
  );

  // Route drawn in slope colors (needs elevations)
  const slopeLines = useMemo(() => {
    if (!prefs.slopeColors || profile.length < 2 || profile.some((p) => p.ele == null)) return null;
    const runs: { color: string; coords: LatLng[] }[] = [];
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1];
      const b = profile[i];
      const color = slopeColor(((b.ele! - a.ele!) / (b.d - a.d || 1)) * 100);
      // Real path between the two samples, not a straight shortcut
      const seg: LatLng[] = [[a.lat, a.lng]];
      for (let j = 0; j < track.length; j++) if (cum[j] > a.d && cum[j] < b.d) seg.push(track[j]);
      seg.push([b.lat, b.lng]);
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.coords.push(...seg.slice(1));
      else runs.push({ color, coords: seg });
    }
    return runs;
  }, [prefs.slopeColors, profile, track, cum]);

  // ── Replay animation ───────────────────────────────────────────────────────
  const replayRef = useRef(replay);
  replayRef.current = replay;
  useEffect(() => {
    if (!replay?.playing) return;
    const total = distance;
    // Whole route in ~25 s at 1×, whatever its length
    const speed = (total / 25) * replaySpeed;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const cur = replayRef.current;
      if (!cur?.playing) return;
      const d = Math.min(total, cur.d + ((now - last) / 1000) * speed);
      last = now;
      setReplay({ d, playing: d < total });
      const m = mapRef.current;
      if (m) m.panTo(pointAt(track, cum, d), { animate: false });
      if (d < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.playing, replaySpeed, track]);

  const startReplay = () => {
    if (track.length < 2) return;
    setSheetOpen(false);
    const m = mapRef.current;
    if (m && m.getZoom() < 14) m.setView(track[0], 15, { animate: false });
    setReplay({ d: replay && replay.d < distance ? replay.d : 0, playing: true });
  };
  const replayPos = replay ? pointAt(track, cum, replay.d) : null;
  const replayTrail = useMemo(() => {
    if (!replay) return null;
    const out: LatLng[] = [];
    for (let i = 0; i < track.length && cum[i] < replay.d; i++) out.push(track[i]);
    out.push(pointAt(track, cum, replay.d));
    return out;
  }, [replay, track, cum]);
  const replayEle = replay ? liveProfile.find((p) => p.d >= replay.d)?.ele ?? null : null;

  // ── OpenStreetMap amenities around the route ───────────────────────────────
  const findOsmPois = async () => {
    if (track.length < 2) return toast("Tracez un parcours d'abord.", "error");
    const lats = track.map((p) => p[0]);
    const lngs = track.map((p) => p[1]);
    const pad = 0.004;
    setOsmLoading(true);
    try {
      const found = await fetchOsmPois(Math.min(...lats) - pad, Math.min(...lngs) - pad, Math.max(...lats) + pad, Math.max(...lngs) + pad);
      const near = found.filter((p) => locateOnTrack(track, cum, [p.lat, p.lng]).off < 300);
      setOsmPois(near);
      const count = (k: OsmPoi["kind"]) => near.filter((p) => p.kind === k).length;
      toast(
        near.length
          ? `${count("water")} point(s) d'eau, ${count("hut") + count("shelter")} refuge(s)/abri(s), ${count("peak")} sommet(s) à moins de 300 m`
          : "Aucun point utile trouvé près du parcours",
        near.length ? "success" : "info",
      );
    } catch {
      toast("Recherche OpenStreetMap indisponible, réessayez plus tard.", "error");
    } finally {
      setOsmLoading(false);
    }
  };

  const addOsmPoi = (o: OsmPoi) => {
    const type: PoiType = o.kind === "water" ? "water" : o.kind === "peak" ? "summit" : o.kind === "view" ? "view" : o.kind === "hut" || o.kind === "shelter" ? "hut" : "note";
    if (pois.some((p) => Math.abs(p.lat - o.lat) < 1e-6 && Math.abs(p.lng - o.lng) < 1e-6)) return;
    setPois((l) => [...l, { id: uid(), lat: o.lat, lng: o.lng, type, name: o.name || OSM_KINDS[o.kind].label }]);
    toast(`« ${o.name || OSM_KINDS[o.kind].label} » ajouté aux repères`, "success");
  };

  // ── Editing actions ────────────────────────────────────────────────────────
  const mk = (p: LatLng, mode: SegmentMode = prefs.mode, avoid = prefs.avoid && mode === "snap"): Waypoint => ({
    id: uid(),
    lat: p[0],
    lng: p[1],
    mode,
    avoid,
  });
  const addPoint = (p: LatLng) => {
    if (placing) {
      setPois((list) => [...list, { id: uid(), lat: p[0], lng: p[1], type: placing, name: POI_TYPES[placing].label }]);
      setPlacing(null);
      return;
    }
    edit([...waypoints, mk(p)]);
  };
  const insertPoint = (index: number, p: LatLng) => {
    const next = waypoints.slice();
    const ref = waypoints[index];
    next.splice(index, 0, mk(p, ref?.mode ?? prefs.mode, ref?.avoid ?? prefs.avoid));
    edit(next);
  };
  const movePoint = (id: string, p: LatLng) => edit(waypoints.map((w) => (w.id === id ? { ...w, lat: p[0], lng: p[1] } : w)));
  const removePoint = (id: string) => edit(waypoints.filter((w) => w.id !== id));
  const closeLoop = () => {
    if (waypoints.length < 2) return toast("Ajoutez au moins deux points pour boucler.");
    const s = waypoints[0];
    edit([...waypoints, mk([s.lat, s.lng])]);
    toast(prefs.avoid ? "Retour au départ par un autre chemin" : "Parcours bouclé vers le départ", "success");
  };
  const outAndBack = () => {
    if (waypoints.length < 2) return toast("Ajoutez au moins deux points.");
    // The way back retraces the way out on purpose, so it never avoids it.
    const back = waypoints
      .slice(0, -1)
      .reverse()
      .map((w, i, arr) => ({ ...w, id: uid(), avoid: false, mode: (i === 0 ? waypoints[waypoints.length - 1] : arr[i - 1]).mode }));
    edit([...waypoints, ...back]);
    toast("Aller-retour ajouté", "success");
  };
  const reverse = () => {
    if (waypoints.length < 2) return;
    const r = waypoints.slice().reverse();
    edit(r.map((w, i) => ({ ...w, mode: i === 0 ? w.mode : r[i - 1].mode, avoid: i === 0 ? false : r[i - 1].avoid })));
  };
  const clear = () => {
    if (!waypoints.length && !pois.length) return;
    edit([]);
    setPois([]);
    toast("Tracé effacé — Ctrl+Z pour annuler");
  };
  const newRoute = () => {
    edit([]);
    setPois([]);
    setCurrentId(null);
    setName("Nouveau parcours");
  };

  const toggleAvoid = () => {
    const avoid = !prefs.avoid;
    updatePrefs({ avoid, ...(avoid ? { mode: "snap" as const } : {}) });
    if (waypoints.length > 1) {
      edit(waypoints.map((w, i) => ({ ...w, avoid: avoid && i > 0 && w.mode === "snap" })));
      // Straight lines have no path to reroute: only legs that follow paths can avoid.
      const routed = waypoints.slice(1).some((w) => w.mode === "snap");
      if (avoid && routed) toast("Recalcul du parcours sans repasser par les mêmes chemins…");
      else if (avoid) toast("Les segments en ligne droite ne peuvent pas être recalculés — les prochains points suivront les chemins.");
    }
  };

  // ── Loop generator ─────────────────────────────────────────────────────────
  const generateLoop = useCallback(
    (req: LoopRequest) => {
      const m = mapRef.current;
      const s: LatLng = waypoints[0] ? [waypoints[0].lat, waypoints[0].lng] : m ? [m.getCenter().lat, m.getCenter().lng] : [45.92, 6.87];
      // Waypoints sit on a circle that goes through the start; paths are never
      // straight, so the circle is smaller than the target distance.
      const radius = (req.target * req.k) / (2 * Math.PI);
      const center = destination(s, radius, req.bearing);
      const back = (req.bearing + 180) % 360;
      const ring = [90, 180, 270].map((off) => destination(center, radius, back + off));
      const wps = [s, ...ring, s].map((p, i) => ({ id: uid(), lat: p[0], lng: p[1], mode: "snap" as const, avoid: i > 0 }));
      setLoop(req);
      set(wps);
      updatePrefs({ avoid: true, mode: "snap" });
    },
    [waypoints, set, updatePrefs],
  );

  useEffect(() => {
    if (!loop || routing || distance === 0 || waypoints.length < 2) return;
    const ratio = loop.target / distance;
    if (Math.abs(ratio - 1) > 0.12 && loop.attempts < 2) {
      generateLoop({ ...loop, k: Math.min(1.6, Math.max(0.3, loop.k * ratio)), attempts: loop.attempts + 1 });
    } else {
      setLoop(null);
      toast(`Boucle de ${formatDistance(distance)} générée`, "success");
      fitTo(waypoints);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop, routing, distance]);

  const fitTo = useCallback((pts: { lat: number; lng: number }[]) => {
    const m = mapRef.current;
    if (!m || !pts.length) return;
    const mobile = window.innerWidth < 860;
    const b = pts.reduce(
      (acc, p) => [
        [Math.min(acc[0][0], p.lat), Math.min(acc[0][1], p.lng)],
        [Math.max(acc[1][0], p.lat), Math.max(acc[1][1], p.lng)],
      ],
      [
        [90, 180],
        [-90, -180],
      ],
    ) as [LatLng, LatLng];
    m.fitBounds(b, {
      paddingTopLeft: mobile ? [30, 90] : [440, 90],
      paddingBottomRight: mobile ? [30, 260] : [90, 260],
      maxZoom: 16,
    });
  }, []);

  // ── Import / export / library / share ──────────────────────────────────────
  const exportRoute = () => {
    if (track.length < 2) return toast("Tracez un parcours avant d'exporter.", "error");
    const fmt = EXPORT_FORMATS[prefs.exportFormat];
    const content = buildExport(prefs.exportFormat, {
      name,
      activity,
      track,
      profile,
      pois,
      duration: withTimes ? duration : undefined,
      start: prefs.start ? new Date(prefs.start).getTime() : undefined,
    });
    downloadFile(`${slugify(name)}.${fmt.ext}`, content, fmt.mime);
    toast(`Fichier ${fmt.label} téléchargé`, "success");
  };

  const importGpx = async (file: File) => {
    try {
      const parsed = parseGpx(await file.text());
      let tol = 3;
      let pts = simplify(parsed.points, tol);
      while (pts.length > 350) pts = simplify(parsed.points, (tol *= 1.6));
      const wps = pts.map((p) => mk(p, "line", false));
      edit(wps);
      setPois(parsed.pois.map((w) => ({ id: uid(), lat: w.lat, lng: w.lng, name: w.name, type: "note" })));
      setCurrentId(null);
      setName(parsed.name ?? file.name.replace(/\.gpx$/i, ""));
      fitTo(wps);
      toast(`Trace importée (${wps.length} points${parsed.pois.length ? `, ${parsed.pois.length} repères` : ""})`, "success");
      setTab("trace");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const importRef = useRef(importGpx);
  importRef.current = importGpx;

  const saveToLibrary = () => {
    if (waypoints.length < 2) return toast("Rien à enregistrer pour l'instant.", "error");
    const id = currentId ?? uid();
    const entry: SavedRoute = { id, name, activity, waypoints, pois, distance, gain: stats.gain, updatedAt: Date.now() };
    const next = [entry, ...library.filter((r) => r.id !== id)];
    setLibrary(next);
    saveLibrary(next);
    setCurrentId(id);
    toast("Parcours enregistré", "success");
  };

  const openRoute = (r: SavedRoute) => {
    edit(r.waypoints);
    setPois(r.pois ?? []);
    setName(r.name);
    setActivity(r.activity);
    setCurrentId(r.id);
    fitTo(r.waypoints);
    setSheetOpen(false);
    setTab("trace");
  };

  const deleteRoute = (id: string) => {
    const next = library.filter((r) => r.id !== id);
    setLibrary(next);
    saveLibrary(next);
    if (id === currentId) setCurrentId(null);
  };

  const shareImage = async () => {
    if (track.length < 2) return toast("Tracez un parcours d'abord.", "error");
    try {
      const blob = await renderCard({
        name,
        activity,
        accent,
        track,
        profile,
        stats: [
          { label: "Distance", value: formatDistance(distance) },
          { label: "D+", value: `${Math.round(stats.gain)} m` },
          { label: "Durée", value: formatDuration(duration) },
          { label: "Niveau", value: level.label },
        ],
      });
      const file = new File([blob], `${slugify(name)}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: name }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast("Image téléchargée — parfaite pour Instagram ou WhatsApp", "success");
      }
    } catch {
      toast("Impossible de créer l'image", "error");
    }
  };

  // Drop a GPX file anywhere on the page to import it
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragOver(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      const f = e.dataTransfer!.files[0];
      if (f) importRef.current(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const share = async () => {
    if (waypoints.length < 2) return toast("Tracez un parcours avant de le partager.", "error");
    const url = `${location.origin}${location.pathname}#r=${encodeRoute({ name, activity, waypoints, pois })}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Lien copié — envoyez-le à qui vous voulez", "success");
    } catch {
      window.prompt("Copiez ce lien :", url);
    }
  };

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (mod && key === "s") {
        e.preventDefault();
        saveToLibrary();
      } else if (mod && key === "e") {
        e.preventDefault();
        exportRoute();
      } else if (e.key === "Escape") {
        setPlacing(null);
        setHelpOpen(false);
        setReplay(null);
        setLayersOpen(false);
      } else if (mod) {
        return;
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (waypoints.length) edit(waypoints.slice(0, -1));
      } else if (e.key === "?") {
        setHelpOpen((o) => !o);
      } else if (key === "b") {
        closeLoop();
      } else if (key === "r") {
        toggleAvoid();
      } else if (key === "f") {
        fitTo(waypoints);
      } else if (e.key === " " && track.length > 1) {
        e.preventDefault();
        if (replay?.playing) setReplay({ ...replay, playing: false });
        else startReplay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const locate = () => {
    if (!navigator.geolocation) return toast("Géolocalisation indisponible", "error");
    navigator.geolocation.getCurrentPosition(
      (p) => mapRef.current?.flyTo([p.coords.latitude, p.coords.longitude], 15, { duration: 1.2 }),
      () => toast("Impossible de vous localiser", "error"),
    );
  };

  const paceLabel =
    activity === "run" ? `${formatPace(distance ? duration / 60 / (distance / 1000) : prefs.runPace)} /km` : null;
  const chartMarks = poisOnRoute
    .filter((p) => p.d != null)
    .map((p) => ({ d: p.d!, emoji: POI_TYPES[p.type].emoji, name: p.name }));

  return (
    <div className="app" style={{ "--accent": accent } as React.CSSProperties} data-activity={activity}>
      <MapView
        waypoints={waypoints}
        legs={legs}
        pendingLegs={pendingLegs}
        accent={accent}
        baseLayer={prefs.baseLayer}
        trails={prefs.trails}
        hillshade={prefs.hillshade}
        slopeLines={slopeLines}
        osmPois={osmPois}
        replayTrail={replayTrail}
        hover={replayPos ?? hover}
        kmMarks={kmMarks}
        overlaps={overlaps.lines}
        pois={pois}
        placing={placing != null}
        initialView={init.fromLink ? null : prefs.view}
        onReady={(m) => {
          mapRef.current = m;
          if ((init.fromLink || !prefs.view) && waypoints.length) fitTo(waypoints);
        }}
        onAdd={addPoint}
        onInsert={insertPoint}
        onMove={movePoint}
        onRemove={removePoint}
        onStartClick={closeLoop}
        onMovePoi={(id, p) => setPois((l) => l.map((x) => (x.id === id ? { ...x, lat: p[0], lng: p[1] } : x)))}
        onRemovePoi={(id) => setPois((l) => l.filter((x) => x.id !== id))}
        onAddOsmPoi={addOsmPoi}
        onRouteHover={(p) => {
          if (!p || track.length < 2) return setRouteHoverD(null);
          setRouteHoverD(locateOnTrack(track, cum, p).d);
        }}
        onViewChange={(view) => updatePrefs({ view })}
      />

      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      <aside className={`panel sidebar ${sheetOpen ? "open" : ""}`}>
        <button className="sheet-handle" onClick={() => setSheetOpen((o) => !o)} aria-label="Afficher le panneau">
          <span />
        </button>
        <header className="brand">
          <div className="logo">
            <svg viewBox="0 0 64 64">
              <path d="M10 46 L23 25 L32 36 L41 17 L54 46" />
            </svg>
          </div>
          <div>
            <h1>GPX Studio</h1>
            <p>Traceur de parcours</p>
          </div>
          <div className="brand-actions">
            <button className="icon-btn ghost" title="Raccourcis & astuces (?)" onClick={() => setHelpOpen(true)}>
              <HelpCircle size={18} />
            </button>
            <button className="icon-btn ghost" title="Nouveau parcours" onClick={newRoute}>
              <Spline size={18} />
            </button>
          </div>
        </header>

        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />

        <div className="segmented">
          <button className={activity === "run" ? "active" : ""} onClick={() => setActivity("run")}>
            <Footprints size={16} /> Course
          </button>
          <button className={activity === "hike" ? "active" : ""} onClick={() => setActivity("hike")}>
            <Mountain size={16} /> Randonnée
          </button>
        </div>

        <section className="hero">
          <div className="hero-main">
            <span className="label">Distance</span>
            <div className="big">
              {distance >= 1000 ? (distance / 1000).toFixed(2) : Math.round(distance)}
              <small>{distance >= 1000 ? "km" : "m"}</small>
            </div>
            {distance > 0 && <span className={`level level-${level.level}`}>{level.label}</span>}
          </div>
          <div className="hero-side">
            <span className="label">
              <Clock size={12} /> Durée estimée
            </span>
            <div className="mid">{formatDuration(duration)}</div>
            {paceLabel && distance > 0 && <span className="sub">allure moy. {paceLabel}</span>}
          </div>
        </section>

        <nav className="tabs">
          <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>
            <PenLine size={15} /> Tracer
          </button>
          <button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>
            <CalendarClock size={15} /> Planifier
          </button>
          <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>
            <FolderOpen size={15} /> Parcours
            {library.length > 0 && <i>{library.length}</i>}
          </button>
        </nav>

        {tab === "trace" && (
          <>
            <div className="stats">
              <Stat icon={<TrendingUp size={14} />} label="D+" value={`${Math.round(stats.gain)} m`} tone="up" loading={eleLoading} />
              <Stat icon={<TrendingDown size={14} />} label="D-" value={`${Math.round(stats.loss)} m`} tone="down" loading={eleLoading} />
              <Stat icon={<Mountain size={14} />} label="Alt. max" value={stats.maxEle != null ? `${Math.round(stats.maxEle)} m` : "—"} />
              <Stat icon={<Gauge size={14} />} label="Pente max" value={`${stats.maxSlope.toFixed(0)} %`} />
              <Stat
                icon={<Repeat size={14} />}
                label="Repassage"
                value={overlaps.length ? formatDistance(overlaps.length) : "Aucun"}
                tone={overlaps.length ? "warn" : undefined}
              />
              <Stat icon={<Flame size={14} />} label="Calories" value={`≈ ${Math.round(kcal)} kcal`} />
            </div>

            <div className="block">
              <div className="block-head">
                <span>{activity === "run" ? "Allure sur le plat" : "Vitesse de marche"}</span>
                <b>{activity === "run" ? `${formatPace(prefs.runPace)} /km` : `${prefs.hikeSpeed.toFixed(1)} km/h`}</b>
              </div>
              {activity === "run" ? (
                <input type="range" min={3} max={10} step={1 / 12} value={prefs.runPace} onChange={(e) => updatePrefs({ runPace: +e.target.value })} />
              ) : (
                <input type="range" min={2} max={7} step={0.1} value={prefs.hikeSpeed} onChange={(e) => updatePrefs({ hikeSpeed: +e.target.value })} />
              )}
            </div>

            <div className="block">
              <div className="block-head">
                <span>Mode de tracé</span>
                {routing && (
                  <span className="routing">
                    <span className="spinner" /> calcul…
                  </span>
                )}
              </div>
              <div className="segmented small">
                <button className={prefs.mode === "snap" ? "active" : ""} onClick={() => updatePrefs({ mode: "snap" })}>
                  <Route size={15} /> Suivre les chemins
                </button>
                <button className={prefs.mode === "line" ? "active" : ""} onClick={() => updatePrefs({ mode: "line" })}>
                  <Ruler size={15} /> Ligne droite
                </button>
              </div>
              {prefs.mode === "snap" && (
                <div className="chips">
                  <span>Préférer</span>
                  <button className={prefs.profile === "trails" ? "active" : ""} onClick={() => updatePrefs({ profile: "trails" })}>
                    🌲 Sentiers
                  </button>
                  <button className={prefs.profile === "roads" ? "active" : ""} onClick={() => updatePrefs({ profile: "roads" })}>
                    🏙️ Routes & chemins
                  </button>
                </div>
              )}

              <button className={`switch-card ${prefs.avoid ? "on" : ""}`} onClick={toggleAvoid} role="switch" aria-checked={prefs.avoid}>
                <span className="switch-icon">
                  <Waypoints size={18} />
                </span>
                <span className="switch-text">
                  <b>Ne jamais repasser au même endroit</b>
                  <small>Chaque nouveau segment évite les chemins déjà empruntés</small>
                </span>
                <span className="switch">
                  <span />
                </span>
              </button>
              {overlaps.length > 0 && !routing && (
                <div className="alert warn">
                  <Repeat size={15} />
                  <span>
                    {formatDistance(overlaps.length)} parcourus deux fois (en jaune sur la carte).
                    {!prefs.avoid && (
                      <button className="link" onClick={toggleAvoid}>
                        Éviter
                      </button>
                    )}
                  </span>
                </div>
              )}

              <div className="toolbar">
                <Tool icon={<Undo2 size={17} />} label="Annuler" onClick={undo} disabled={!canUndo} />
                <Tool icon={<Redo2 size={17} />} label="Rétablir" onClick={redo} disabled={!canRedo} />
                <Tool icon={<Repeat size={17} />} label="Boucler" onClick={closeLoop} disabled={waypoints.length < 2} />
                <Tool icon={<ArrowLeftRight size={17} />} label="Aller-retour" onClick={outAndBack} disabled={waypoints.length < 2} />
                <Tool icon={<ArrowUpDown size={17} />} label="Inverser" onClick={reverse} disabled={waypoints.length < 2} />
                <Tool icon={<Trash2 size={17} />} label="Effacer" onClick={clear} disabled={!waypoints.length && !pois.length} danger />
              </div>
            </div>

            <div className="block">
              <div className="block-head">
                <span>Ajouter un repère</span>
                {placing && (
                  <button className="link" onClick={() => setPlacing(null)}>
                    Annuler
                  </button>
                )}
              </div>
              <div className="poi-picker">
                {(Object.keys(POI_TYPES) as PoiType[]).map((t) => (
                  <button
                    key={t}
                    className={placing === t ? "active" : ""}
                    title={POI_TYPES[t].label}
                    onClick={() => setPlacing((cur) => (cur === t ? null : t))}
                  >
                    {POI_TYPES[t].emoji}
                  </button>
                ))}
              </div>
              <button className="secondary osm-btn" onClick={findOsmPois} disabled={osmLoading || track.length < 2}>
                {osmLoading ? <span className="spinner" /> : <Compass size={16} />}
                Trouver eau, refuges & sommets sur le parcours
              </button>
              {osmPois.length > 0 && (
                <p className="muted small">
                  {osmPois.length} points OpenStreetMap affichés — cliquez dessus pour les ajouter à vos repères.{" "}
                  <button className="link" onClick={() => setOsmPois([])}>
                    Masquer
                  </button>
                </p>
              )}
            </div>

            <div className="block loop-card">
              <div className="block-head">
                <span>
                  <Sparkles size={14} /> Générer une boucle
                </span>
                <b>{loopKm} km</b>
              </div>
              <input type="range" min={2} max={activity === "run" ? 42 : 35} step={1} value={loopKm} onChange={(e) => setLoopKm(+e.target.value)} />
              <div className="row">
                <button
                  className="secondary"
                  disabled={loop != null}
                  onClick={() => generateLoop({ target: loopKm * 1000, bearing: Math.random() * 360, k: 0.8, attempts: 0 })}
                >
                  {loop ? <span className="spinner" /> : <Sparkles size={16} />} Générer
                </button>
                <button
                  className="secondary"
                  disabled={loop != null || waypoints.length < 2}
                  onClick={() => generateLoop({ target: loopKm * 1000, bearing: Math.random() * 360, k: 0.8, attempts: 0 })}
                  title="Une autre direction depuis le même départ"
                >
                  <Shuffle size={16} /> Autre idée
                </button>
              </div>
              <p className="muted small">Depuis votre point de départ (ou le centre de la carte), sans repasser par les mêmes chemins.</p>
            </div>

            <div className="block">
              <div className="chips formats">
                {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
                  <button
                    key={f}
                    className={prefs.exportFormat === f ? "active" : ""}
                    title={EXPORT_FORMATS[f].hint}
                    onClick={() => updatePrefs({ exportFormat: f })}
                  >
                    {EXPORT_FORMATS[f].label}
                  </button>
                ))}
              </div>
              <button className="primary" onClick={exportRoute} disabled={track.length < 2}>
                <Download size={18} /> Exporter en {EXPORT_FORMATS[prefs.exportFormat].label}
              </button>
              <label className="check">
                <input type="checkbox" checked={withTimes} onChange={(e) => setWithTimes(e.target.checked)} />
                <span>Inclure les horaires estimés (partenaire virtuel montre)</span>
              </label>
              <div className="row three">
                <button className="secondary" onClick={saveToLibrary}>
                  <Save size={16} /> Enregistrer
                </button>
                <button className="secondary" onClick={share} title="Copier un lien vers ce parcours">
                  <Link2 size={16} /> Lien
                </button>
                <button className="secondary" onClick={shareImage} title="Image à partager (story)">
                  <ImageDown size={16} /> Image
                </button>
              </div>
            </div>
          </>
        )}

        {tab === "plan" && (
          <Planner
            activity={activity}
            start={prefs.start}
            onStartChange={(start) => updatePrefs({ start })}
            duration={duration}
            runPace={prefs.runPace}
            hikeSpeed={prefs.hikeSpeed}
            onApplyPace={(runPace) => {
              updatePrefs({ runPace });
              toast(`Allure réglée sur ${formatPace(runPace)} /km`, "success");
            }}
            onApplySpeed={(hikeSpeed) => {
              updatePrefs({ hikeSpeed });
              toast(`Vitesse réglée sur ${hikeSpeed.toFixed(1)} km/h`, "success");
            }}
            startPoint={waypoints[0] ?? null}
            splits={splits}
            pois={poisOnRoute}
            onRenamePoi={(id, n) => setPois((l) => l.map((x) => (x.id === id ? { ...x, name: n } : x)))}
            onRemovePoi={(id) => setPois((l) => l.filter((x) => x.id !== id))}
            onFocusPoi={(p) => mapRef.current?.flyTo([p.lat, p.lng], Math.max(15, mapRef.current.getZoom()))}
            weight={prefs.weight}
            onWeightChange={(weight) => updatePrefs({ weight })}
            kcal={kcal}
          />
        )}

        {tab === "library" && (
          <div className="block library">
            <div className="row">
              <button className="secondary" onClick={() => fileInput.current?.click()}>
                <Upload size={16} /> Importer GPX
              </button>
              <button className="secondary" onClick={saveToLibrary}>
                <Save size={16} /> Enregistrer
              </button>
            </div>
            {library.length === 0 ? (
              <p className="muted">Vos parcours enregistrés apparaîtront ici.</p>
            ) : (
              <ul>
                {library.map((r) => (
                  <li key={r.id} className={r.id === currentId ? "current" : ""} onClick={() => openRoute(r)}>
                    <span className={`badge ${r.activity}`}>
                      {r.activity === "run" ? <Footprints size={14} /> : <Mountain size={14} />}
                    </span>
                    <div>
                      <b>{r.name}</b>
                      <span>
                        {formatDistance(r.distance)} · {Math.round(r.gain)} m D+ ·{" "}
                        {new Date(r.updatedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}
                      </span>
                    </div>
                    <button
                      className="icon-btn ghost"
                      title="Supprimer"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRoute(r.id);
                      }}
                    >
                      <X size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".gpx,application/gpx+xml"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importGpx(f);
            e.target.value = "";
          }}
        />
      </aside>

      {/* ── Search & map tools ────────────────────────────────────────────── */}
      <SearchBox onPick={(p) => mapRef.current?.flyTo([p.lat, p.lng], 14, { duration: 1.4 })} />

      <div className="map-tools">
        <div className="layers-wrap">
          <button className={`icon-btn panel ${layersOpen ? "on" : ""}`} title="Fonds de carte" onClick={() => setLayersOpen((o) => !o)}>
            <Layers size={18} />
          </button>
          {layersOpen && (
            <div className="panel layers-menu">
              {Object.entries(BASE_LAYERS).map(([k, l]) => (
                <button key={k} className={`layer-opt ${prefs.baseLayer === k ? "active" : ""}`} onClick={() => updatePrefs({ baseLayer: k })}>
                  <span className={`thumb thumb-${k}`} />
                  {l.label}
                </button>
              ))}
              <label className="check">
                <input type="checkbox" checked={prefs.trails} onChange={(e) => updatePrefs({ trails: e.target.checked })} />
                <span>Sentiers balisés</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={prefs.hillshade} onChange={(e) => updatePrefs({ hillshade: e.target.checked })} />
                <span>Relief ombré</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={prefs.slopeColors} onChange={(e) => updatePrefs({ slopeColors: e.target.checked })} />
                <span>Colorer le tracé selon la pente</span>
              </label>
            </div>
          )}
        </div>
        <button className="icon-btn panel" title="Me localiser" onClick={locate}>
          <LocateFixed size={18} />
        </button>
        <button className="icon-btn panel" title="Recentrer sur le parcours (F)" onClick={() => fitTo(waypoints)} disabled={!waypoints.length}>
          <Maximize2 size={18} />
        </button>
      </div>

      {/* ── Elevation profile ─────────────────────────────────────────────── */}
      <section className="panel profile">
        <div className="profile-head">
          <div className="profile-title">
            <h2>Profil altimétrique</h2>
            <div className="replay-ctrl">
              {replay?.playing ? (
                <button className="icon-btn ghost" title="Pause" onClick={() => setReplay({ ...replay, playing: false })}>
                  <span className="pause-icon" />
                </button>
              ) : (
                <button className="replay-btn" onClick={startReplay} disabled={track.length < 2} title="Survoler le parcours">
                  <Play size={13} /> {replay ? "Reprendre" : "Survol"}
                </button>
              )}
              {replay && (
                <>
                  <button className="speed" onClick={() => setReplaySpeed((v) => (v >= 4 ? 1 : v * 2))} title="Vitesse">
                    {replaySpeed}×
                  </button>
                  <button className="icon-btn ghost" title="Arrêter" onClick={() => setReplay(null)}>
                    <Square size={13} />
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="legend">
            <i style={{ background: "#34d399" }} />
            &lt;3%
            <i style={{ background: "#facc15" }} />
            &lt;7%
            <i style={{ background: "#fb923c" }} />
            &lt;12%
            <i style={{ background: "#f43f5e" }} />
            &lt;20%
            <i style={{ background: "#a855f7" }} />
            20%+
          </div>
        </div>
        <ElevationChart
          profile={profile}
          accent={accent}
          loading={eleLoading}
          marks={chartMarks}
          overlaps={overlaps.ranges}
          cursorD={replay?.d ?? routeHoverD}
          onHover={(p) => setHover(p ? [p.lat, p.lng] : null)}
          onPick={(p) => mapRef.current?.panTo([p.lat, p.lng])}
        />
      </section>

      {placing ? (
        <div className="hint panel">
          <span className="hint-emoji">{POI_TYPES[placing].emoji}</span>
          Cliquez sur la carte pour placer « {POI_TYPES[placing].label} » · Échap pour annuler
        </div>
      ) : (
        waypoints.length === 0 && (
          <div className="hint panel">
            <span className="pulse" />
            Cliquez sur la carte pour placer votre départ — ou générez une boucle
          </div>
        )
      )}

      {replay && (
        <div className="replay-hud panel">
          <div>
            <span className="label">Distance</span>
            <b>{(replay.d / 1000).toFixed(2)} km</b>
          </div>
          <div>
            <span className="label">Altitude</span>
            <b>{replayEle != null ? `${Math.round(replayEle)} m` : "—"}</b>
          </div>
          <div>
            <span className="label">Temps</span>
            <b>{formatDuration(distance ? (duration * replay.d) / distance : 0)}</b>
          </div>
          <div className="replay-progress">
            <span style={{ width: `${distance ? (replay.d / distance) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {dragOver && (
        <div className="drop-zone">
          <div>
            <Upload size={34} />
            <b>Déposez votre fichier GPX</b>
            <span>Il sera ouvert comme nouveau parcours</span>
          </div>
        </div>
      )}

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat(props: { icon: React.ReactNode; label: string; value: string; tone?: "up" | "down" | "warn"; loading?: boolean }) {
  return (
    <div className={`stat ${props.tone ?? ""}`}>
      <span className="label">
        {props.icon} {props.label}
      </span>
      <b className={props.loading ? "shimmer" : ""}>{props.value}</b>
    </div>
  );
}

function Tool(props: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={`tool ${props.danger ? "danger" : ""}`} onClick={props.onClick} disabled={props.disabled} title={props.label}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Clic sur la carte", "Ajouter un point"],
  ["Clic sur le tracé", "Insérer un point"],
  ["Glisser un point", "Le déplacer"],
  ["Double-clic / clic droit", "Supprimer un point ou un repère"],
  ["Clic sur le départ", "Boucler le parcours"],
  ["Ctrl + Z / Ctrl + Y", "Annuler / rétablir"],
  ["Suppr", "Retirer le dernier point"],
  ["B", "Boucler vers le départ"],
  ["R", "Activer / couper « ne pas repasser »"],
  ["F", "Recentrer sur le parcours"],
  ["Espace", "Lancer / mettre en pause le survol"],
  ["Glisser un fichier GPX", "L'importer"],
  ["Ctrl + S", "Enregistrer"],
  ["Ctrl + E", "Exporter"],
  ["Échap", "Annuler le placement d'un repère"],
];

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Raccourcis & astuces</h2>
          <button className="icon-btn ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <ul>
          {SHORTCUTS.map(([k, v]) => (
            <li key={k}>
              <kbd>{k}</kbd>
              <span>{v}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">
          Le profil altimétrique est cliquable : il centre la carte sur le point survolé. Les sections parcourues deux fois sont
          surlignées en jaune sur la carte et sur le profil.
        </p>
      </div>
    </div>
  );
}

function SearchBox({ onPick }: { onPick: (p: Place) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(q, ctrl.signal)
        .then((r) => {
          setResults(r);
          setOpen(true);
        })
        .catch(() => {});
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="search panel">
      <Search size={17} />
      <input
        placeholder="Rechercher un lieu, un sommet…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) {
            onPick(results[0]);
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {q && (
        <button className="icon-btn ghost" onClick={() => setQ("")}>
          <X size={15} />
        </button>
      )}
      {open && results.length > 0 && (
        <ul className="results">
          {results.map((r, i) => (
            <li
              key={i}
              onMouseDown={() => {
                onPick(r);
                setQ(r.name);
                setOpen(false);
              }}
            >
              <b>{r.name}</b>
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
