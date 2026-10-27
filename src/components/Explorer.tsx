import { useEffect, useMemo, useRef, useState } from "react";
import type L from "leaflet";
import { Clock, Loader2, LocateFixed, MoveHorizontal, Repeat, Search, TrendingUp } from "lucide-react";
import {
  computeStats,
  cumulative,
  difficulty,
  estimateDuration,
  formatDistance,
  formatDuration,
  haversine,
  resample,
  type Activity,
  type LatLng,
  type ProfilePoint,
} from "../lib/geo";
import { fetchElevations, fetchTrailGeometries, fetchTrailGeometry, fetchTrails, type BBox, type Trail } from "../lib/services";

type Filter = "all" | "short" | "mid" | "long" | "loop";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "short", label: "< 10 km" },
  { id: "mid", label: "10 – 25 km" },
  { id: "long", label: "> 25 km" },
  { id: "loop", label: "Boucles" },
];

export const KIND_HINT: Record<Trail["kind"], string> = {
  GR: "Grande Randonnée",
  GRP: "GR de Pays",
  PR: "Petite Randonnée",
  Trail: "Parcours de trail",
  Rando: "Sentier balisé",
};

/** How many routes get their line and figures loaded at once. */
const BATCH = 10;
/** Multi-day routes: only their section inside the searched area is shown. */
const isLong = (t: Trail) => t.long;

/** Box of ±`half` degrees of latitude around a point (same distance east-west). */
function boxAround(c: LatLng, half: number): BBox {
  const dLng = half / Math.cos((c[0] * Math.PI) / 180);
  return [c[0] - half, c[1] - dLng, c[0] + half, c[1] + dLng];
}

/** Distance from `c` to the closest point of a line. */
function distanceTo(c: LatLng, line: LatLng[]) {
  const step = Math.max(1, Math.floor(line.length / 200));
  let best = Infinity;
  for (let i = 0; i < line.length; i += step) best = Math.min(best, haversine(c, line[i]));
  return best;
}

export interface TourStats {
  distance: number;
  gain: number;
  duration: number;
  level: ReturnType<typeof difficulty>;
}

export interface Tour {
  trail: Trail;
  line: LatLng[];
  stats: TourStats | null;
}

interface Props {
  map: L.Map | null;
  activity: Activity;
  runPace: number;
  hikeSpeed: number;
  selectedId: number | null;
  onSelect: (tour: Tour) => void;
  /** Every route whose line is known, to draw them all on the map. */
  onToursChange: (tours: Tour[]) => void;
}

export default function Explorer(p: Props) {
  const [trails, setTrails] = useState<Trail[] | null>(null);
  const [lines, setLines] = useState<Map<number, LatLng[]>>(new Map());
  const [stats, setStats] = useState<Map<number, TourStats>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadingLines, setLoadingLines] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(BATCH);
  const listRef = useRef<HTMLUListElement>(null);

  // Figures follow the chosen activity and pace, without new requests
  const elevations = useRef(new Map<number, ProfilePoint[]>());
  const computeFor = (id: number, line: LatLng[]): TourStats => {
    const profile = elevations.current.get(id) ?? [];
    const cum = cumulative(line);
    const distance = cum[cum.length - 1] ?? 0;
    const st = computeStats(distance, profile);
    return {
      distance,
      gain: st.gain,
      duration: estimateDuration(p.activity, st, p.runPace, p.hikeSpeed),
      level: difficulty(st),
    };
  };
  useEffect(() => {
    setStats(new Map([...lines].map(([id, line]) => [id, computeFor(id, line)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, p.activity, p.runPace, p.hikeSpeed]);

  const [box, setBox] = useState<BBox | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const loadLines = async (batch: Trail[], area: BBox, signal: AbortSignal) => {
    const ids = batch.filter((t) => !lines.has(t.id)).map((t) => t.id);
    if (!ids.length) return;
    setLoadingLines(true);
    try {
      // Clipped to the searched area: a long-distance route only costs its local section
      const got = await fetchTrailGeometries(ids, area, signal);
      setLines((m) => new Map([...m, ...got]));
      // Elevation for D+ and duration, from terrain tiles (no rate limit)
      await Promise.all(
        [...got].map(async ([id, line]) => {
          try {
            elevations.current.set(id, await fetchElevations(resample(line, 120, 30)));
          } catch {
            /* figures stay without elevation */
          }
        }),
      );
      setLines((m) => new Map(m));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setLoadingLines(false);
    }
  };

  const cancel = () => {
    ctrlRef.current?.abort();
    setLoading(false);
    setLoadingLines(false);
    setStatus(null);
  };

  /** Searches a box around `c` (half-size in degrees of latitude). */
  const searchAround = async (c: LatLng, half: number, note: string | null = null) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const area = boxAround(c, half);
    setLoading(true);
    setError(note);
    setStatus("Recherche des sentiers balisés…");
    try {
      const found = await fetchTrails(area, ctrl.signal);
      // Day routes first, multi-day sections after
      found.sort((a, z) => Number(isLong(a)) - Number(isLong(z)));
      elevations.current.clear();
      setLines(new Map());
      setOrigin(c);
      setBox(area);
      setTrails(found);
      setShown(BATCH);
      setStatus(null);
      setLoading(false);
      loadLines(found.slice(0, BATCH), area, ctrl.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message || "Recherche impossible pour le moment.");
      setStatus(null);
      setLoading(false);
    }
  };

  const searchHere = () => {
    if (!p.map) return;
    const b = p.map.getBounds();
    const c = p.map.getCenter();
    // At most ~20 km across: enough for a day out, light for the public servers
    searchAround([c.lat, c.lng], Math.min(0.09, (b.getNorth() - b.getSouth()) / 2));
  };

  const searchNearMe = () => {
    const fallback = (why: string) => {
      const c = p.map?.getCenter();
      if (c) searchAround([c.lat, c.lng], 0.08, why);
      else {
        setError(why);
        setLoading(false);
      }
    };
    if (!navigator.geolocation) return fallback("Votre appareil ne donne pas sa position : recherche autour du centre de la carte.");
    setLoading(true);
    setError(null);
    setStatus("Localisation…");
    let done = false;
    // Some browsers never answer while the permission prompt is ignored
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      fallback("Position introuvable : recherche autour du centre de la carte.");
    }, 10000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const c: LatLng = [pos.coords.latitude, pos.coords.longitude];
        p.map?.setView(c, 13);
        searchAround(c, 0.08);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fallback(
          err.code === err.PERMISSION_DENIED
            ? "Position refusée (autorisez la localisation pour ce site) : recherche autour du centre de la carte."
            : "Position introuvable : recherche autour du centre de la carte.",
        );
      },
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 },
    );
  };

  const nearDist = useMemo(() => {
    const m = new Map<number, number>();
    if (origin) for (const [id, line] of lines) m.set(id, distanceTo(origin, line));
    return m;
  }, [lines, origin]);

  const tourOf = (t: Trail): Tour | null => {
    const line = lines.get(t.id);
    return line ? { trail: t, line, stats: stats.get(t.id) ?? null } : null;
  };

  const select = async (t: Trail) => {
    let tour = tourOf(t);
    if (!tour) {
      setBusyId(t.id);
      try {
        const line = await fetchTrailGeometry(t.id, box ?? undefined);
        setLines((m) => new Map(m).set(t.id, line));
        tour = { trail: t, line, stats: computeFor(t.id, line) };
      } catch (e) {
        setError((e as Error).message || "Tracé indisponible.");
      } finally {
        setBusyId(null);
      }
    }
    if (tour) p.onSelect(tour);
  };

  // Share every known line with the map
  useEffect(() => {
    if (!trails) return;
    p.onToursChange(trails.map(tourOf).filter((x): x is Tour => !!x));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trails, lines, stats]);

  // A route picked on the map comes into view in the list
  useEffect(() => {
    if (p.selectedId == null) return;
    listRef.current?.querySelector(`[data-id="${p.selectedId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.selectedId]);

  const filtered = useMemo(() => {
    if (!trails) return [];
    const words = q.trim().toLowerCase();
    return trails.filter((t) => {
      if (words && !`${t.name} ${t.ref} ${t.operator}`.toLowerCase().includes(words)) return false;
      const d = stats.get(t.id)?.distance ?? t.distance;
      if (filter === "loop") return t.loop;
      if (filter === "short") return d != null && d < 10000;
      if (filter === "mid") return d != null && d >= 10000 && d <= 25000;
      if (filter === "long") return d != null ? d > 25000 : isLong(t);
      return true;
    });
  }, [trails, filter, q, stats]);
  // Closest first once their lines are known; still-loading ones keep their place after
  const sorted = useMemo(
    () =>
      [...filtered].sort((a, z) => {
        const da = nearDist.get(a.id);
        const dz = nearDist.get(z.id);
        if (da == null || dz == null) return Number(da == null) - Number(dz == null);
        return Number(isLong(a)) - Number(isLong(z)) || da - dz;
      }),
    [filtered, nearDist],
  );

  const visible = sorted.slice(0, shown);

  return (
    <div className="block explorer">
      <div className="row">
        <button className="primary" onClick={searchNearMe} disabled={loading}>
          {loading ? <Loader2 size={17} className="spin" /> : <LocateFixed size={17} />}
          Autour de moi
        </button>
        <button className="secondary" onClick={searchHere} disabled={loading || !p.map}>
          <Search size={16} /> Zone affichée
        </button>
      </div>
      {status && (
        <div className="search-status">
          <Loader2 size={15} className="spin" /> {status}
          <button className="link" onClick={cancel}>
            Annuler
          </button>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {!trails && !error && (
        <p className="muted small">
          Les randonnées balisées autour de vous : GR, GR de Pays, PR et parcours de trail, avec leur distance, leur durée et leur
          dénivelé.
        </p>
      )}

      {trails && (
        <>
          <div className="chips scroll">
            {FILTERS.map((f) => (
              <button key={f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          {trails.length > 8 && (
            <input className="field" placeholder="Filtrer par nom (ex. GR 5, lac…)" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          <p className="muted small">
            {filtered.length} randonnée{filtered.length > 1 ? "s" : ""}
            {loadingLines && " · calcul des tracés…"}
          </p>
          <ul className="tours" ref={listRef}>
            {visible.map((t) => {
              const line = lines.get(t.id);
              const st = stats.get(t.id);
              const selected = p.selectedId === t.id;
              return (
                <li key={t.id} data-id={t.id} className={selected ? "selected" : ""}>
                  <button className="tour" onClick={() => select(t)}>
                    <Thumb line={line ?? null} loading={busyId === t.id || (!line && loadingLines)} kind={t.kind} />
                    <span className="tour-body">
                      <b>{t.name}</b>
                      {st ? (
                        <span className="tour-stats">
                          <span>
                            <Clock size={12} /> {formatDuration(st.duration)}
                          </span>
                          <span>
                            <MoveHorizontal size={12} /> {formatDistance(st.distance)}
                          </span>
                          <span>
                            <TrendingUp size={12} /> {Math.round(st.gain)} m
                          </span>
                        </span>
                      ) : (
                        <span className="tour-stats muted">
                          {t.distance ? formatDistance(t.distance) : KIND_HINT[t.kind]}
                          {isLong(t) && " · section dans la zone"}
                        </span>
                      )}
                      <span className="tour-meta">
                        <span className={`trail-badge k-${t.kind}`} title={KIND_HINT[t.kind]} data-kind={t.kind}>
                          {t.kind}
                        </span>
                        {st && <span className={`level level-${st.level.level}`}>{st.level.label}</span>}
                        {t.loop && (
                          <span>
                            <Repeat size={11} /> boucle
                          </span>
                        )}
                        {isLong(t) && st && <span>section de l'itinéraire</span>}
                        {nearDist.has(t.id) && <span>à {formatDistance(nearDist.get(t.id)!)}</span>}
                      </span>
                    </span>
                  </button>
                  {selected && t.description && (
                    <div className="tour-actions">
                      <p>{t.description}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {filtered.length > shown && (
            <button
              className="secondary wide"
              onClick={() => {
                const next = sorted.slice(shown, shown + BATCH);
                setShown((n) => n + BATCH);
                if (box && ctrlRef.current) loadLines(next, box, ctrlRef.current.signal);
              }}
            >
              Voir plus de randonnées
            </button>
          )}
          {trails.length === 0 && <p className="muted">Aucun sentier balisé connu ici. Essayez une autre zone.</p>}
          <p className="muted small">© contributeurs OpenStreetMap (ODbL) — vérifiez toujours le balisage sur le terrain.</p>
        </>
      )}
    </div>
  );
}

/** Small drawing of a route's shape, like a tour card thumbnail. */
function Thumb({ line, loading, kind }: { line: LatLng[] | null; loading: boolean; kind: Trail["kind"] }) {
  const d = useMemo(() => {
    if (!line || line.length < 2) return null;
    const step = Math.max(1, Math.floor(line.length / 120));
    const pts = line.filter((_, i) => i % step === 0);
    const lat0 = (pts[0][0] * Math.PI) / 180;
    const xs = pts.map((q) => q[1] * Math.cos(lat0));
    const ys = pts.map((q) => -q[0]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min(68 / (maxX - minX || 1e-9), 50 / (maxY - minY || 1e-9));
    const ox = 6 + (68 - (maxX - minX) * s) / 2;
    const oy = 6 + (50 - (maxY - minY) * s) / 2;
    return pts.map((_, i) => `${i ? "L" : "M"}${(ox + (xs.at(i)! - minX) * s).toFixed(1)},${(oy + (ys.at(i)! - minY) * s).toFixed(1)}`).join("");
  }, [line]);
  return (
    <span className={`thumbnail k-${kind}`}>
      {d ? (
        <svg viewBox="0 0 80 62" aria-hidden="true">
          <path d={d} fill="none" stroke="#fbf9f4" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
          <path d={d} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : loading ? (
        <Loader2 size={16} className="spin" />
      ) : null}
    </span>
  );
}
