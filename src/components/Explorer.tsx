import { useMemo, useState } from "react";
import type L from "leaflet";
import { Compass, Loader2, Repeat, Search } from "lucide-react";
import { formatDistance, type LatLng } from "../lib/geo";
import { fetchTrailGeometry, fetchTrails, type Trail } from "../lib/services";

type Filter = "all" | "short" | "mid" | "long" | "loop";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "short", label: "< 10 km" },
  { id: "mid", label: "10 – 25 km" },
  { id: "long", label: "> 25 km" },
  { id: "loop", label: "Boucles" },
];

const KIND_HINT: Record<Trail["kind"], string> = {
  GR: "Grande Randonnée",
  GRP: "GR de Pays / régional",
  PR: "Petite Randonnée",
  Trail: "Parcours de trail",
  Rando: "Sentier balisé",
};

interface Props {
  map: L.Map | null;
  previewId: number | null;
  onPreview: (trail: Trail, line: LatLng[]) => void;
  onUse: (trail: Trail, line: LatLng[]) => void;
  onError: (msg: string) => void;
}

export default function Explorer({ map, previewId, onPreview, onUse, onError }: Props) {
  const [trails, setTrails] = useState<Trail[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<Map<number, LatLng[]>>(new Map());

  const search = async () => {
    if (!map) return;
    if (map.getZoom() < 9) {
      map.setZoom(10);
      onError("Zoomez sur une région (une vallée, un massif) puis relancez la recherche.");
      return;
    }
    const b = map.getBounds();
    setLoading(true);
    try {
      const found = await fetchTrails(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
      const c = map.getCenter();
      // Closest to the map center first, multi-day routes last
      found.sort(
        (a, z) =>
          Number(a.span > 60000) - Number(z.span > 60000) ||
          Math.hypot(a.center[0] - c.lat, a.center[1] - c.lng) - Math.hypot(z.center[0] - c.lat, z.center[1] - c.lng),
      );
      setTrails(found);
    } catch (e) {
      onError((e as Error).message || "Recherche impossible pour le moment.");
    } finally {
      setLoading(false);
    }
  };

  const geometry = async (t: Trail) => {
    const known = lines.get(t.id);
    if (known) return known;
    setBusyId(t.id);
    try {
      const line = await fetchTrailGeometry(t.id);
      setLines((m) => new Map(m).set(t.id, line));
      return line;
    } catch (e) {
      onError((e as Error).message || "Tracé indisponible.");
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const shown = useMemo(() => {
    if (!trails) return [];
    const words = q.trim().toLowerCase();
    return trails.filter((t) => {
      if (words && !`${t.name} ${t.ref} ${t.operator}`.toLowerCase().includes(words)) return false;
      const d = t.distance;
      if (filter === "loop") return t.loop;
      if (filter === "short") return d != null && d < 10000;
      if (filter === "mid") return d != null && d >= 10000 && d <= 25000;
      if (filter === "long") return d != null ? d > 25000 : t.span > 20000;
      return true;
    });
  }, [trails, filter, q]);

  return (
    <div className="block explorer">
      <p className="muted small">
        Les sentiers balisés (GR, GR de Pays, PR, parcours de trail) de la zone affichée sur la carte, issus d'OpenStreetMap.
      </p>
      <button className="primary" onClick={search} disabled={loading || !map}>
        {loading ? <Loader2 size={17} className="spin" /> : <Search size={17} />}
        {trails ? "Chercher dans cette zone" : "Trouver des randonnées ici"}
      </button>

      {trails && (
        <>
          <div className="chips">
            {FILTERS.map((f) => (
              <button key={f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          {trails.length > 6 && (
            <input className="field" placeholder="Filtrer par nom (ex. GR 5, lac…)" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          <p className="muted small">
            {shown.length} randonnée{shown.length > 1 ? "s" : ""} {filter !== "all" || q ? `sur ${trails.length}` : "dans cette zone"}
          </p>
          <ul className="trail-list">
            {shown.slice(0, 60).map((t) => {
              const line = lines.get(t.id);
              return (
                <li key={t.id} className={previewId === t.id ? "current" : ""}>
                  <button
                    className="trail-main"
                    onClick={async () => {
                      const g = await geometry(t);
                      if (g) onPreview(t, g);
                    }}
                  >
                    <span className={`trail-badge k-${t.kind}`} title={KIND_HINT[t.kind]} data-kind={t.kind}>
                      {t.kind}
                    </span>
                    <span className="trail-text">
                      <b>{t.name}</b>
                      <small>
                        {[t.ref && t.ref !== t.name ? t.ref : null, t.distance ? formatDistance(t.distance) : null, t.loop ? "boucle" : null, t.span > 60000 ? "itinérance" : null]
                          .filter(Boolean)
                          .join(" · ") || KIND_HINT[t.kind]}
                      </small>
                    </span>
                    {busyId === t.id ? <Loader2 size={16} className="spin" /> : t.loop ? <Repeat size={15} /> : <Compass size={15} />}
                  </button>
                  {previewId === t.id && line && (
                    <div className="trail-actions">
                      {t.description && <p>{t.description}</p>}
                      <button className="primary" onClick={() => onUse(t, line)}>
                        Utiliser ce parcours
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {trails.length === 0 && <p className="muted">Aucun sentier balisé connu ici. Essayez une zone plus large.</p>}
          <p className="muted small">© contributeurs OpenStreetMap (ODbL) — vérifiez toujours le balisage sur le terrain.</p>
        </>
      )}
    </div>
  );
}
