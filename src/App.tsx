import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type L from "leaflet";
import {
  ArrowLeftRight,
  ArrowUpDown,
  CalendarClock,
  Compass,
  Clock,
  Download,
  MoveHorizontal,
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
  Sparkles,
  Spline,
  Square,
  Trash2,
  TrendingDown,
  TrendingUp,
  Undo2,
  Upload,
  UserRound,
  Waypoints,
  X,
} from "lucide-react";
import MapView, { BASE_LAYERS, OSM_KINDS } from "./components/MapView";
import ElevationChart from "./components/ElevationChart";
import Planner from "./components/Planner";
import Explorer, { KIND_HINT, type Tour } from "./components/Explorer";
import { useMedia, useViewportHeight } from "./lib/useMedia";
import UpgradeModal from "./components/UpgradeModal";
import AccountModal from "./components/AccountModal";
import { PoiIcon } from "./components/icons";
import { useAccount } from "./lib/account";
import { deleteRoute as deleteCloudRoute, listRoutes, RouteLimitError, saveRoute } from "./lib/cloud";
import { FREE_ROUTE_LIMIT, PERSONAL, PRO_FEATURES, usePlan, type ProFeature } from "./lib/plan";
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
  smoothProfile,
  gradeAt,
  formatGrade,
  formatDegrees,
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

const ACCENTS: Record<Activity, string> = { run: "#b4472e", hike: "#2e5a45" };

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
type Tab = "trace" | "explore" | "plan" | "library";

/** Map options that belong to the Pro plan. */
const PRO_LAYERS = ["ignplan", "ignortho"];

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
  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = uid();
    setToasts((t) => [...t.filter((x) => x.text !== text), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  const account = useAccount();
  const [localLibrary, setLocalLibrary] = useState<SavedRoute[]>(loadLibrary);
  const [cloudLibrary, setCloudLibrary] = useState<SavedRoute[] | null>(null);
  /** Signed in: routes live in the account; otherwise in this browser. */
  const cloud = !!account.user;
  const library = cloud ? (cloudLibrary ?? []) : localLibrary;
  const [accountOpen, setAccountOpen] = useState<{ reason: string | null } | null>(null);
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
  const plan = usePlan(account.user);
  const wasPaid = useRef(plan.paid);
  useEffect(() => {
    if (plan.paid && !wasPaid.current) toast("Bienvenue dans GPX Studio Pro, merci !", "success");
    wasPaid.current = plan.paid;
  }, [plan.paid, toast]);

  useEffect(() => {
    if (!account.user) {
      setCloudLibrary(null);
      return;
    }
    let alive = true;
    listRoutes()
      .then((r) => alive && setCloudLibrary(r))
      .catch(() => alive && toast("Impossible de charger vos parcours en ligne.", "error"));
    return () => {
      alive = false;
    };
  }, [account.user, toast]);
  const [upgrade, setUpgrade] = useState<{ feature: ProFeature | null } | null>(null);
  const [preview, setPreview] = useState<Tour | null>(null);
  const [tours, setTours] = useState<Tour[]>([]);
  /** Opens the Pro offer when a free user reaches for a Pro feature; true = blocked. */
  const needPro = (f: ProFeature) => {
    if (plan.isPro) return false;
    setUpgrade({ feature: f });
    return true;
  };
  const baseLayer = plan.isPro || !PRO_LAYERS.includes(prefs.baseLayer) ? prefs.baseLayer : "topo";
  const hillshade = plan.isPro && prefs.hillshade;
  const slopeColorsOn = plan.isPro && prefs.slopeColors;
  // ── Phone layout: the panel is a bottom sheet with three heights ────────
  const isMobile = useMedia("(max-width: 860px)");
  const vh = useViewportHeight();
  const [sheet, setSheet] = useState<"peek" | "half" | "full">("peek");
  const sheetHeights = { peek: 104, half: Math.round(vh * 0.56), full: vh - 68 };
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; t: number; moved: boolean } | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  // A collapsed sheet always shows its top (the summary).
  useEffect(() => {
    if (sheet === "peek" && sidebarRef.current) sidebarRef.current.scrollTop = 0;
  }, [sheet]);
  const sheetDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: sheetHeights[sheet], t: performance.now(), moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const sheetMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (Math.abs(dy) > 6) d.moved = true;
    if (d.moved) setDragH(Math.max(sheetHeights.peek - 30, Math.min(sheetHeights.full, d.h - dy)));
  };
  const sheetUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragH(null);
    if (!d) return;
    if (!d.moved) return setSheet((s) => (s === "peek" ? "half" : "peek"));
    const h = d.h - (e.clientY - d.y);
    const speed = (d.y - e.clientY) / Math.max(1, performance.now() - d.t); // px/ms, up > 0
    const order = (["peek", "half", "full"] as const).map((k) => ({ k, h: sheetHeights[k] }));
    let target = order.reduce((a, b) => (Math.abs(b.h - h) < Math.abs(a.h - h) ? b : a)).k;
    // A quick flick carries on to the next height in that direction
    if (speed > 0.5) target = order.find((o) => o.h > Math.max(h, d.h + 10))?.k ?? "full";
    if (speed < -0.5) target = [...order].reverse().find((o) => o.h < Math.min(h, d.h - 10))?.k ?? "peek";
    setSheet(target);
  };
  const [layersOpen, setLayersOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("trace");
  const [loopKm, setLoopKm] = useState(10);
  const [loop, setLoop] = useState<LoopRequest | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const accent = ACCENTS[activity];


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
    if (!slopeColorsOn || profile.length < 2 || profile.some((p) => p.ele == null)) return null;
    const smooth = smoothProfile(profile, 80);
    const runs: { color: string; coords: LatLng[] }[] = [];
    for (let i = 1; i < smooth.length; i++) {
      const a = smooth[i - 1];
      const b = smooth[i];
      const color = slopeColor(gradeAt(smooth, (a.d + b.d) / 2));
      // Real path between the two samples, not a straight shortcut
      const seg: LatLng[] = [[a.lat, a.lng]];
      for (let j = 0; j < track.length; j++) if (cum[j] > a.d && cum[j] < b.d) seg.push(track[j]);
      seg.push([b.lat, b.lng]);
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.coords.push(...seg.slice(1));
      else runs.push({ color, coords: seg });
    }
    return runs;
  }, [slopeColorsOn, profile, track, cum]);

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
    setSheet("peek");
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
    if (needPro("amenities")) return;
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
    // On a phone, the first tap on the map just brings the map back
    if (isMobile && sheet !== "peek") return setSheet("peek");
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
    if (!prefs.avoid && needPro("avoid")) return;
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
      paddingTopLeft: mobile ? [24, 80] : [440, 90],
      paddingBottomRight: mobile ? [24, 190] : [90, 260],
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
      duration: withTimes && plan.isPro ? duration : undefined,
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

  const loadTrail = ({ trail: t, line }: Tour) => {
    let tol = 3;
    let pts = simplify(line, tol);
    while (pts.length > 350) pts = simplify(line, (tol *= 1.6));
    const wps = pts.map((p) => mk(p, "line", false));
    edit(wps);
    setPois([]);
    setCurrentId(null);
    setName(t.ref && !t.name.includes(t.ref) ? `${t.ref} — ${t.name}` : t.name);
    if (t.kind === "Trail") setActivity("run");
    setPreview(null);
    setTab("trace");
    fitTo(wps);
    toast("Randonnée chargée : modifiez-la ou exportez-la vers votre montre", "success");
  };

  const importRef = useRef(importGpx);
  importRef.current = importGpx;

  const saveToLibrary = async () => {
    if (waypoints.length < 2) return toast("Rien à enregistrer pour l'instant.", "error");
    if (cloud) {
      const existing = cloudLibrary?.some((r) => r.id === currentId) ? currentId : null;
      try {
        const saved = await saveRoute({ id: existing, name, activity, waypoints, pois, distance, gain: stats.gain });
        setCloudLibrary((l) => [saved, ...(l ?? []).filter((r) => r.id !== saved.id)]);
        setCurrentId(saved.id);
        toast("Parcours enregistré dans votre compte", "success");
      } catch (e) {
        if (e instanceof RouteLimitError) setUpgrade({ feature: "library" });
        else toast("Enregistrement impossible, réessayez.", "error");
      }
      return;
    }
    const isNew = !localLibrary.some((r) => r.id === currentId);
    if (isNew && localLibrary.length >= FREE_ROUTE_LIMIT && needPro("library")) return;
    const id = currentId ?? uid();
    const entry: SavedRoute = { id, name, activity, waypoints, pois, distance, gain: stats.gain, updatedAt: Date.now() };
    const next = [entry, ...localLibrary.filter((r) => r.id !== id)];
    setLocalLibrary(next);
    saveLibrary(next);
    setCurrentId(id);
    toast(account.enabled ? "Enregistré sur cet appareil — connectez-vous pour le retrouver partout" : "Parcours enregistré", "success");
  };

  /** Moves the routes saved in this browser to the account. */
  const importLocalRoutes = async () => {
    let moved = 0;
    const left = [...localLibrary];
    for (const r of localLibrary) {
      try {
        const saved = await saveRoute({ ...r, id: null });
        setCloudLibrary((l) => [saved, ...(l ?? [])]);
        left.splice(left.indexOf(r), 1);
        moved++;
      } catch (e) {
        if (e instanceof RouteLimitError) setUpgrade({ feature: "library" });
        else toast("Une partie des parcours n'a pas pu être importée.", "error");
        break;
      }
    }
    setLocalLibrary(left);
    saveLibrary(left);
    if (moved) toast(`${moved} parcours ajouté${moved > 1 ? "s" : ""} à votre compte`, "success");
  };

  const openRoute = (r: SavedRoute) => {
    edit(r.waypoints);
    setPois(r.pois ?? []);
    setName(r.name);
    setActivity(r.activity);
    setCurrentId(r.id);
    fitTo(r.waypoints);
    setSheet("peek");
    setTab("trace");
  };

  const deleteRoute = async (id: string) => {
    if (cloud) {
      try {
        await deleteCloudRoute(id);
        setCloudLibrary((l) => (l ?? []).filter((r) => r.id !== id));
      } catch {
        return toast("Suppression impossible, réessayez.", "error");
      }
    } else {
      const next = localLibrary.filter((r) => r.id !== id);
      setLocalLibrary(next);
      saveLibrary(next);
    }
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

  const switchTab = (t: Tab) => {
    setTab(t);
    if (t !== "explore") setPreview(null);
  };

  const chartMarks = poisOnRoute
    .filter((p) => p.d != null)
    .map((p) => ({ d: p.d!, type: p.type, name: p.name }));

  const profileBody = (
    <>
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
            {[1, 5, 10, 15, 25].map((v, i) => (
              <span key={v} className="legend-item">
                <i style={{ background: slopeColor(v) }} />
                {["< 3 %", "< 7 %", "< 12 %", "< 20 %", "20 % +"].at(i)}
              </span>
            ))}
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
          </>
  );
  const profilePanel = <section className="panel profile">{profileBody}</section>;

  const paceLabel =
    activity === "run" ? `${formatPace(distance ? duration / 60 / (distance / 1000) : prefs.runPace)} /km` : null;

  return (
    <div className="app" style={{ "--accent": accent, "--peek": `${sheetHeights.peek}px` } as React.CSSProperties} data-activity={activity}>
      <MapView
        waypoints={waypoints}
        legs={legs}
        pendingLegs={pendingLegs}
        accent={accent}
        baseLayer={baseLayer}
        trails={prefs.trails}
        hillshade={hillshade}
        slopeLines={slopeLines}
        osmPois={osmPois}
        replayTrail={replayTrail}
        preview={preview?.line ?? null}
        tours={tab === "explore" ? tours.filter((t) => t.trail.id !== preview?.trail.id).map((t) => ({ id: t.trail.id, line: t.line })) : []}
        onTourClick={(id) => {
          const t = tours.find((x) => x.trail.id === id);
          if (t) setPreview(t);
          if (isMobile) setSheet("peek");
        }}
        bottomInset={isMobile ? sheetHeights.peek + 170 : 0}
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
      <aside
        ref={sidebarRef}
        className={`panel sidebar ${isMobile ? `sheet sheet-${sheet}` : ""} ${dragH != null ? "dragging" : ""}`}
        style={isMobile ? { height: dragH ?? sheetHeights[sheet] } : undefined}
      >
        {isMobile && (
          <div
            className="sheet-top"
            onPointerDown={sheetDown}
            onPointerMove={sheetMove}
            onPointerUp={sheetUp}
            onPointerCancel={sheetUp}
            role="button"
            aria-label={sheet === "peek" ? "Ouvrir le panneau" : "Réduire le panneau"}
          >
            <span className="grip" />
            <div className="summary">
              <div>
                <b>{formatDuration(duration)}</b>
                <small>
                  <Clock size={11} /> durée
                </small>
              </div>
              <div>
                <b>{formatDistance(distance)}</b>
                <small>
                  <MoveHorizontal size={11} /> distance
                </small>
              </div>
              <div>
                <b>{Math.round(stats.gain)} m</b>
                <small>
                  <TrendingUp size={11} /> montée
                </small>
              </div>
              <div>
                <b>{Math.round(stats.loss)} m</b>
                <small>
                  <TrendingDown size={11} /> descente
                </small>
              </div>
            </div>
          </div>
        )}
        <header className="brand">
          <div className="logo" aria-hidden="true">
            <span className="mark">
              <i />
              <i />
            </span>
          </div>
          <div>
            <h1>GPX Studio</h1>
            <p>Carnet de parcours</p>
          </div>
          <div className="brand-actions">
            {account.enabled &&
              (account.user ? (
                <button className="avatar" title={account.user.email ?? "Mon compte"} onClick={() => setAccountOpen({ reason: null })}>
                  {(account.user.email ?? "?").slice(0, 1).toUpperCase()}
                </button>
              ) : (
                <button className="icon-btn ghost" title="Se connecter" onClick={() => setAccountOpen({ reason: null })}>
                  <UserRound size={18} />
                </button>
              ))}
            {PERSONAL ? null : plan.paid ? (
              <span className="pro-pill">PRO</span>
            ) : plan.onTrial ? (
              <button className="trial-pill" onClick={() => setUpgrade({ feature: null })} title="Votre essai Pro">
                Essai · {plan.trialDaysLeft} j
              </button>
            ) : (
              <button className="go-pro" onClick={() => setUpgrade({ feature: null })}>
                Passer Pro
              </button>
            )}
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

        {isMobile && tab === "trace" && track.length > 1 && <section className="m-profile">{profileBody}</section>}

        <section className="hero">
          <div className="hero-main">
            <span className="label">Distance</span>
            <div className="big">
              {distance >= 1000 ? (distance / 1000).toFixed(2).replace(".", ",") : Math.round(distance)}
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
          <button className={tab === "trace" ? "active" : ""} onClick={() => switchTab("trace")}>
            <PenLine size={15} /> Tracer
          </button>
          <button className={tab === "explore" ? "active" : ""} onClick={() => switchTab("explore")}>
            <Compass size={15} /> Explorer
          </button>
          <button className={tab === "plan" ? "active" : ""} onClick={() => switchTab("plan")}>
            <CalendarClock size={15} /> Planifier
          </button>
          <button className={tab === "library" ? "active" : ""} onClick={() => switchTab("library")}>
            <FolderOpen size={15} /> Parcours
            {library.length > 0 && <i>{library.length}</i>}
          </button>
        </nav>

        {tab === "trace" && (
          <>
            <div className="stats">
              <Stat icon={<TrendingUp size={14} />} label="D+" value={`${Math.round(stats.gain)} m`} tone="up" loading={eleLoading} />
              <Stat icon={<TrendingDown size={14} />} label="D-" value={`${Math.round(stats.loss)} m`} tone="down" loading={eleLoading} />
              <Stat
                icon={<Mountain size={14} />}
                label="Pente moy."
                value={formatGrade(stats.climbGrade)}
                sub={`en montée · ${formatDegrees(stats.climbGrade)}`}
              />
              <Stat
                icon={<Gauge size={14} />}
                label="Plus raide"
                value={`${stats.steepest.grade < 0 ? "−" : ""}${formatGrade(stats.steepest.grade)}`}
                sub={`sur ${formatDistance(stats.steepest.over)} · ${formatDegrees(stats.steepest.grade)}`}
              />
            </div>

            <div className="block">
              <div className="block-head">
                <span>{activity === "run" ? "Allure sur le plat" : "Vitesse de marche"}</span>
                <b>{activity === "run" ? `${formatPace(prefs.runPace)} /km` : `${prefs.hikeSpeed.toFixed(1).replace(".", ",")} km/h`}</b>
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
                    Sentiers
                  </button>
                  <button className={prefs.profile === "roads" ? "active" : ""} onClick={() => updatePrefs({ profile: "roads" })}>
                    Routes et chemins
                  </button>
                </div>
              )}

              <button className={`switch-card ${prefs.avoid ? "on" : ""}`} onClick={toggleAvoid} role="switch" aria-checked={prefs.avoid}>
                <span className="switch-icon">
                  <Waypoints size={18} />
                </span>
                <span className="switch-text">
                  <b>
                    Ne jamais repasser au même endroit {!plan.isPro && <span className="pro-pill">PRO</span>}
                  </b>
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
                    {formatDistance(overlaps.length)} parcourus deux fois, surlignés sur la carte.
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
                    <PoiIcon type={t} size={17} />
                  </button>
                ))}
              </div>
              <button className="secondary osm-btn" onClick={findOsmPois} disabled={osmLoading || track.length < 2}>
                {osmLoading ? <span className="spinner" /> : <Compass size={16} />}
                Trouver eau, refuges & sommets sur le parcours
                {!plan.isPro && <span className="pro-pill">PRO</span>}
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
                  <Sparkles size={14} /> Boucle automatique
                </span>
                <b>{loopKm} km</b>
              </div>
              <input type="range" min={2} max={activity === "run" ? 42 : 35} step={1} value={loopKm} onChange={(e) => setLoopKm(+e.target.value)} />
              <button
                className="secondary wide"
                disabled={loop != null}
                onClick={() => {
                  if (needPro("loop")) return;
                  generateLoop({ target: loopKm * 1000, bearing: Math.random() * 360, k: 0.8, attempts: 0 });
                }}
              >
                {loop ? <span className="spinner" /> : <Sparkles size={16} />}
                {waypoints.length > 1 ? "Générer une autre boucle" : "Générer la boucle"}
                {!plan.isPro && <span className="pro-pill">PRO</span>}
              </button>
              <p className="muted small">Depuis votre point de départ (ou le centre de la carte), sans repasser par les mêmes chemins.</p>
            </div>

            <div className="block">
              <div className="chips">
                <span>Format GPX</span>
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
                <Download size={18} /> Exporter le GPX
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={withTimes && plan.isPro}
                  onChange={(e) => {
                    if (e.target.checked && needPro("times")) return;
                    setWithTimes(e.target.checked);
                  }}
                />
                <span>
                  Inclure les horaires estimés (partenaire virtuel montre) {!plan.isPro && <span className="pro-pill">PRO</span>}
                </span>
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

        {tab === "explore" && (
          <Explorer
            map={mapRef.current}
            activity={activity}
            runPace={prefs.runPace}
            hikeSpeed={prefs.hikeSpeed}
            selectedId={preview?.trail.id ?? null}
            onSelect={(t) => {
              setPreview(t);
              if (isMobile) setSheet("peek");
            }}
            onToursChange={setTours}
          />
        )}

        {tab === "plan" && !plan.isPro && (
          <div className="block teaser">
            <span className="pro-pill big">PRO</span>
            <h3>{PRO_FEATURES.planner.title}</h3>
            <ul>
              <li>Météo heure par heure pendant votre sortie</li>
              <li>Heure d'arrivée et alerte coucher du soleil</li>
              <li>Temps de passage kilomètre par kilomètre</li>
              <li>Objectif de temps → allure à tenir</li>
              <li>Eau et nourriture à emporter</li>
            </ul>
            <button className="primary" onClick={() => setUpgrade({ feature: "planner" })}>
              {plan.trialUsed ? "Débloquer avec Pro" : "Essayer gratuitement 14 jours"}
            </button>
          </div>
        )}

        {tab === "plan" && plan.isPro && (
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
              toast(`Vitesse réglée sur ${hikeSpeed.toFixed(1).replace(".", ",")} km/h`, "success");
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
            {cloud && localLibrary.length > 0 && (
              <button className="secondary wide" onClick={importLocalRoutes}>
                Ajouter à mon compte les {localLibrary.length} parcours de cet appareil
              </button>
            )}
            {account.enabled && !cloud && (
              <p className="muted small">
                Parcours enregistrés sur cet appareil.{" "}
                <button className="link" onClick={() => setAccountOpen({ reason: null })}>
                  Connectez-vous
                </button>{" "}
                pour les retrouver partout.
              </p>
            )}
            {!plan.isPro && (
              <p className="muted small">
                {library.length}/{FREE_ROUTE_LIMIT} parcours enregistrés avec l'offre gratuite.{" "}
                <button className="link" onClick={() => setUpgrade({ feature: "library" })}>
                  Illimité avec Pro
                </button>
              </p>
            )}
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
                <button
                  key={k}
                  className={`layer-opt ${baseLayer === k ? "active" : ""}`}
                  onClick={() => {
                    if (PRO_LAYERS.includes(k) && needPro("maps")) return;
                    updatePrefs({ baseLayer: k });
                  }}
                >
                  <span className={`thumb thumb-${k}`}>{PRO_LAYERS.includes(k) && !plan.isPro && <span className="pro-pill">PRO</span>}</span>
                  {l.label}
                </button>
              ))}
              <label className="check">
                <input type="checkbox" checked={prefs.trails} onChange={(e) => updatePrefs({ trails: e.target.checked })} />
                <span>Sentiers balisés</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={hillshade}
                  onChange={(e) => (e.target.checked && needPro("maps") ? null : updatePrefs({ hillshade: e.target.checked }))}
                />
                <span>Relief ombré {!plan.isPro && <span className="pro-pill">PRO</span>}</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={slopeColorsOn}
                  onChange={(e) => (e.target.checked && needPro("maps") ? null : updatePrefs({ slopeColors: e.target.checked }))}
                />
                <span>Colorer le tracé selon la pente {!plan.isPro && <span className="pro-pill">PRO</span>}</span>
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

      {!isMobile && profilePanel}

      {preview && (
        <div className="tour-card panel" style={isMobile ? { bottom: sheetHeights.peek + 14 } : undefined}>
          <button className="icon-btn ghost close" title="Fermer" onClick={() => setPreview(null)}>
            <X size={16} />
          </button>
          <span className="tour-card-kind">
            <span className={`trail-badge k-${preview.trail.kind}`} data-kind={preview.trail.kind}>
              {preview.trail.kind}
            </span>
            {KIND_HINT[preview.trail.kind]}
            {preview.trail.ref && preview.trail.ref !== preview.trail.name ? ` · ${preview.trail.ref}` : null}
          </span>
          <b className="tour-card-name">{preview.trail.name}</b>
          {preview.stats && (
            <div className="tour-card-stats">
              <span>
                <Clock size={13} /> {formatDuration(preview.stats.duration)}
              </span>
              <span>
                <MoveHorizontal size={13} /> {formatDistance(preview.stats.distance)}
              </span>
              <span>
                <TrendingUp size={13} /> {Math.round(preview.stats.gain)} m
              </span>
              <span className={`level level-${preview.stats.level.level}`}>{preview.stats.level.label}</span>
            </div>
          )}
          <button className="primary" onClick={() => loadTrail(preview)}>
            Utiliser ce parcours
          </button>
        </div>
      )}

      {isMobile && sheet === "peek" && !preview && !replay && (
        <div className="quickbar panel" style={{ bottom: sheetHeights.peek + 12 }}>
          <button onClick={undo} disabled={!canUndo}>
            <Undo2 size={19} />
            <span>Annuler</span>
          </button>
          <button onClick={redo} disabled={!canRedo}>
            <Redo2 size={19} />
            <span>Rétablir</span>
          </button>
          <button onClick={() => updatePrefs({ mode: prefs.mode === "snap" ? "line" : "snap" })}>
            {prefs.mode === "snap" ? <Route size={19} /> : <Ruler size={19} />}
            <span>{prefs.mode === "snap" ? "Chemins" : "Ligne"}</span>
          </button>
          <button onClick={closeLoop} disabled={waypoints.length < 2}>
            <Repeat size={19} />
            <span>Boucler</span>
          </button>
          <button onClick={clear} disabled={!waypoints.length}>
            <Trash2 size={19} />
            <span>Effacer</span>
          </button>
          <button className="qb-primary" onClick={exportRoute} disabled={track.length < 2}>
            <Download size={19} />
            <span>GPX</span>
          </button>
        </div>
      )}

      {placing ? (
        <div className="hint panel">
          <PoiIcon type={placing} size={16} />
          Cliquez sur la carte pour placer « {POI_TYPES[placing].label} » · Échap pour annuler
        </div>
      ) : (
        waypoints.length === 0 &&
        !preview && (
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
            <b>{(replay.d / 1000).toFixed(2).replace(".", ",")} km</b>
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

      {accountOpen && (
        <AccountModal
          account={account}
          plan={plan}
          reason={accountOpen.reason}
          onUpgrade={() => {
            setAccountOpen(null);
            setUpgrade({ feature: null });
          }}
          onClose={() => setAccountOpen(null)}
        />
      )}

      {upgrade && (
        <UpgradeModal
          feature={upgrade.feature}
          trialUsed={plan.trialUsed}
          onStartTrial={async () => {
            const r = await plan.startTrial();
            if (r.ok) toast("Essai Pro activé pour 14 jours — profitez-en !", "success");
            return r;
          }}
          onCheckout={plan.checkout}
          onNeedAccount={(reason) => {
            setUpgrade(null);
            setAccountOpen({ reason });
          }}
          onClose={() => setUpgrade(null)}
        />
      )}

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

function Stat(props: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: "up" | "down" | "warn"; loading?: boolean }) {
  return (
    <div className={`stat ${props.tone ?? ""}`}>
      <span className="label">
        {props.icon} {props.label}
      </span>
      <b className={props.loading ? "shimmer" : ""}>{props.value}</b>
      {props.sub && <small className="stat-sub">{props.sub}</small>}
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
          surlignées sur la carte et sur le profil.
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
