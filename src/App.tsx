import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type L from "leaflet";
import {
  ArrowLeftRight,
  ArrowUpDown,
  Clock,
  Download,
  Footprints,
  FolderOpen,
  Gauge,
  Layers,
  LocateFixed,
  Maximize2,
  Mountain,
  Redo2,
  Repeat,
  Route,
  Ruler,
  Save,
  Search,
  Spline,
  Trash2,
  TrendingDown,
  TrendingUp,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import MapView, { BASE_LAYERS } from "./components/MapView";
import ElevationChart from "./components/ElevationChart";
import {
  computeStats,
  cumulative,
  estimateDuration,
  formatDistance,
  formatDuration,
  formatPace,
  resample,
  simplify,
  uid,
  type Activity,
  type LatLng,
  type ProfilePoint,
  type SegmentMode,
  type Waypoint,
} from "./lib/geo";
import { buildGpx, downloadFile, parseGpx, slugify } from "./lib/gpx";
import { fetchElevations, routeFoot, searchPlaces, type Place } from "./lib/services";
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

const legKey = (a: Waypoint, b: Waypoint) =>
  `${a.lat.toFixed(6)},${a.lng.toFixed(6)}|${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;

type LegState = LatLng[] | "pending" | "error";

interface Toast {
  id: string;
  text: string;
  tone: "info" | "error" | "success";
}

export default function App() {
  const draft = useMemo(loadDraft, []);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [name, setName] = useState(draft?.name ?? "Nouveau parcours");
  const [activity, setActivity] = useState<Activity>(draft?.activity ?? "run");
  const [currentId, setCurrentId] = useState<string | null>(draft?.id ?? null);
  const { waypoints, set, undo, redo, canUndo, canRedo } = useWaypointHistory(draft?.waypoints ?? []);
  const [library, setLibrary] = useState<SavedRoute[]>(loadLibrary);
  const [legCache, setLegCache] = useState<Map<string, LegState>>(() => new Map());
  const [profile, setProfile] = useState<ProfilePoint[]>([]);
  const [eleLoading, setEleLoading] = useState(false);
  const [hover, setHover] = useState<LatLng | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [withTimes, setWithTimes] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const mapRef = useRef<L.Map | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const accent = ACCENTS[activity];

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = uid();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  useEffect(() => savePrefs(prefs), [prefs]);
  useEffect(() => saveDraft({ id: currentId, name, activity, waypoints }), [currentId, name, activity, waypoints]);

  // ── Routing: snap every "snap" leg to the trail network ────────────────────
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      if (b.mode !== "snap") continue;
      const k = legKey(a, b);
      if (legCache.has(k) || inflight.current.has(k)) continue;
      inflight.current.add(k);
      setLegCache((c) => new Map(c).set(k, "pending"));
      routeFoot([a.lat, a.lng], [b.lat, b.lng])
        .then((line) => setLegCache((c) => new Map(c).set(k, line)))
        .catch(() => {
          setLegCache((c) => new Map(c).set(k, "error"));
          toast("Aucun chemin trouvé pour ce segment — tracé en ligne droite.", "error");
        })
        .finally(() => inflight.current.delete(k));
    }
  }, [waypoints, legCache, toast]);

  const { legs, pendingLegs } = useMemo(() => {
    const legs: LatLng[][] = [];
    const pendingLegs: boolean[] = [];
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      const straight: LatLng[] = [
        [a.lat, a.lng],
        [b.lat, b.lng],
      ];
      const st = b.mode === "snap" ? legCache.get(legKey(a, b)) : undefined;
      legs.push(Array.isArray(st) ? st : straight);
      pendingLegs.push(b.mode === "snap" && (st === undefined || st === "pending"));
    }
    return { legs, pendingLegs };
  }, [waypoints, legCache]);

  const track = useMemo<LatLng[]>(() => {
    if (waypoints.length === 1) return [[waypoints[0].lat, waypoints[0].lng]];
    const out: LatLng[] = [];
    legs.forEach((leg, i) => out.push(...(i === 0 ? leg : leg.slice(1))));
    return out;
  }, [legs, waypoints]);

  const cum = useMemo(() => cumulative(track), [track]);
  const distance = cum.length ? cum[cum.length - 1] : 0;
  const routing = pendingLegs.some(Boolean);

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
      fetchElevations(resample(track), ctrl.signal)
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
  }, [track, distance, routing, toast]);

  const stats = useMemo(() => computeStats(distance, profile), [distance, profile]);
  const duration = estimateDuration(activity, stats, prefs.runPace, prefs.hikeSpeed);

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

  // ── Editing actions ────────────────────────────────────────────────────────
  const mk = (p: LatLng, mode: SegmentMode = prefs.mode): Waypoint => ({ id: uid(), lat: p[0], lng: p[1], mode });
  const addPoint = (p: LatLng) => set([...waypoints, mk(p)]);
  const insertPoint = (index: number, p: LatLng) => {
    const next = waypoints.slice();
    next.splice(index, 0, mk(p, waypoints[index]?.mode ?? prefs.mode));
    set(next);
  };
  const movePoint = (id: string, p: LatLng) => set(waypoints.map((w) => (w.id === id ? { ...w, lat: p[0], lng: p[1] } : w)));
  const removePoint = (id: string) => set(waypoints.filter((w) => w.id !== id));
  const closeLoop = () => {
    if (waypoints.length < 2) return toast("Ajoutez au moins deux points pour boucler.");
    const s = waypoints[0];
    set([...waypoints, mk([s.lat, s.lng])]);
    toast("Parcours bouclé vers le départ", "success");
  };
  const outAndBack = () => {
    if (waypoints.length < 2) return toast("Ajoutez au moins deux points.");
    const back = waypoints
      .slice(0, -1)
      .reverse()
      .map((w, i, arr) => ({ ...w, id: uid(), mode: (i === 0 ? waypoints[waypoints.length - 1] : arr[i - 1]).mode }));
    set([...waypoints, ...back]);
    toast("Aller-retour ajouté", "success");
  };
  const reverse = () => {
    if (waypoints.length < 2) return;
    const r = waypoints.slice().reverse();
    set(r.map((w, i) => ({ ...w, mode: i === 0 ? w.mode : r[i - 1].mode })));
  };
  const clear = () => {
    if (!waypoints.length) return;
    set([]);
    toast("Tracé effacé — Ctrl+Z pour annuler");
  };
  const newRoute = () => {
    set([]);
    setCurrentId(null);
    setName("Nouveau parcours");
  };

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

  // ── Import / export / library ──────────────────────────────────────────────
  const exportGpx = () => {
    if (track.length < 2) return toast("Tracez un parcours avant d'exporter.", "error");
    const gpx = buildGpx({ name, activity, track, profile, duration: withTimes ? duration : undefined });
    downloadFile(`${slugify(name)}.gpx`, gpx);
    toast("Fichier GPX téléchargé", "success");
  };

  const importGpx = async (file: File) => {
    try {
      const parsed = parseGpx(await file.text());
      let tol = 3;
      let pts = simplify(parsed.points, tol);
      while (pts.length > 350) pts = simplify(parsed.points, (tol *= 1.6));
      const wps = pts.map((p) => mk(p, "line"));
      set(wps);
      setCurrentId(null);
      setName(parsed.name ?? file.name.replace(/\.gpx$/i, ""));
      fitTo(wps);
      toast(`Trace importée (${wps.length} points)`, "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const saveToLibrary = () => {
    if (waypoints.length < 2) return toast("Rien à enregistrer pour l'instant.", "error");
    const id = currentId ?? uid();
    const entry: SavedRoute = { id, name, activity, waypoints, distance, gain: stats.gain, updatedAt: Date.now() };
    const next = [entry, ...library.filter((r) => r.id !== id)];
    setLibrary(next);
    saveLibrary(next);
    setCurrentId(id);
    toast("Parcours enregistré", "success");
  };

  const openRoute = (r: SavedRoute) => {
    set(r.waypoints);
    setName(r.name);
    setActivity(r.activity);
    setCurrentId(r.id);
    fitTo(r.waypoints);
    setSheetOpen(false);
  };

  const deleteRoute = (id: string) => {
    const next = library.filter((r) => r.id !== id);
    setLibrary(next);
    saveLibrary(next);
    if (id === currentId) setCurrentId(null);
  };

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveToLibrary();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (waypoints.length) set(waypoints.slice(0, -1));
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

  return (
    <div className="app" style={{ "--accent": accent } as React.CSSProperties} data-activity={activity}>
      <MapView
        waypoints={waypoints}
        legs={legs}
        pendingLegs={pendingLegs}
        accent={accent}
        baseLayer={prefs.baseLayer}
        trails={prefs.trails}
        hover={hover}
        kmMarks={kmMarks}
        initialView={prefs.view}
        onReady={(m) => {
          mapRef.current = m;
          if (!prefs.view && waypoints.length) fitTo(waypoints);
        }}
        onAdd={addPoint}
        onInsert={insertPoint}
        onMove={movePoint}
        onRemove={removePoint}
        onStartClick={closeLoop}
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
          <button className="icon-btn ghost" title="Nouveau parcours" onClick={newRoute}>
            <Spline size={18} />
          </button>
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
          </div>
          <div className="hero-side">
            <span className="label">
              <Clock size={12} /> Durée estimée
            </span>
            <div className="mid">{formatDuration(duration)}</div>
            {paceLabel && distance > 0 && <span className="sub">allure moy. {paceLabel}</span>}
          </div>
        </section>

        <div className="stats">
          <Stat icon={<TrendingUp size={14} />} label="D+" value={`${Math.round(stats.gain)} m`} tone="up" loading={eleLoading} />
          <Stat icon={<TrendingDown size={14} />} label="D-" value={`${Math.round(stats.loss)} m`} tone="down" loading={eleLoading} />
          <Stat icon={<Mountain size={14} />} label="Alt. max" value={stats.maxEle != null ? `${Math.round(stats.maxEle)} m` : "—"} />
          <Stat icon={<Gauge size={14} />} label="Pente max" value={`${stats.maxSlope.toFixed(0)} %`} />
        </div>

        <div className="block">
          <div className="block-head">
            <span>{activity === "run" ? "Allure sur le plat" : "Vitesse de marche"}</span>
            <b>{activity === "run" ? `${formatPace(prefs.runPace)} /km` : `${prefs.hikeSpeed.toFixed(1)} km/h`}</b>
          </div>
          {activity === "run" ? (
            <input
              type="range"
              min={3}
              max={10}
              step={1 / 12}
              value={prefs.runPace}
              onChange={(e) => updatePrefs({ runPace: +e.target.value })}
            />
          ) : (
            <input
              type="range"
              min={2}
              max={7}
              step={0.1}
              value={prefs.hikeSpeed}
              onChange={(e) => updatePrefs({ hikeSpeed: +e.target.value })}
            />
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
          <div className="toolbar">
            <Tool icon={<Undo2 size={17} />} label="Annuler" onClick={undo} disabled={!canUndo} />
            <Tool icon={<Redo2 size={17} />} label="Rétablir" onClick={redo} disabled={!canRedo} />
            <Tool icon={<Repeat size={17} />} label="Boucler" onClick={closeLoop} disabled={waypoints.length < 2} />
            <Tool icon={<ArrowLeftRight size={17} />} label="Aller-retour" onClick={outAndBack} disabled={waypoints.length < 2} />
            <Tool icon={<ArrowUpDown size={17} />} label="Inverser" onClick={reverse} disabled={waypoints.length < 2} />
            <Tool icon={<Trash2 size={17} />} label="Effacer" onClick={clear} disabled={!waypoints.length} danger />
          </div>
        </div>

        <div className="block">
          <button className="primary" onClick={exportGpx} disabled={track.length < 2}>
            <Download size={18} /> Exporter en GPX
          </button>
          <label className="check">
            <input type="checkbox" checked={withTimes} onChange={(e) => setWithTimes(e.target.checked)} />
            <span>Inclure les horaires estimés (partenaire virtuel montre)</span>
          </label>
          <div className="row">
            <button className="secondary" onClick={() => fileInput.current?.click()}>
              <Upload size={16} /> Importer
            </button>
            <button className="secondary" onClick={saveToLibrary}>
              <Save size={16} /> Enregistrer
            </button>
          </div>
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
        </div>

        <div className="block library">
          <div className="block-head">
            <span>
              <FolderOpen size={14} /> Mes parcours
            </span>
            <b>{library.length}</b>
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
            </div>
          )}
        </div>
        <button className="icon-btn panel" title="Me localiser" onClick={locate}>
          <LocateFixed size={18} />
        </button>
        <button className="icon-btn panel" title="Recentrer sur le parcours" onClick={() => fitTo(waypoints)} disabled={!waypoints.length}>
          <Maximize2 size={18} />
        </button>
      </div>

      {/* ── Elevation profile ─────────────────────────────────────────────── */}
      <section className="panel profile">
        <div className="profile-head">
          <h2>Profil altimétrique</h2>
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
          onHover={(p) => setHover(p ? [p.lat, p.lng] : null)}
        />
      </section>

      {waypoints.length === 0 && (
        <div className="hint panel">
          <span className="pulse" />
          Cliquez sur la carte pour placer votre point de départ
        </div>
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

function Stat(props: { icon: React.ReactNode; label: string; value: string; tone?: "up" | "down"; loading?: boolean }) {
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
