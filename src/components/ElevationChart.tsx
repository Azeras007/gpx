import { useMemo, useRef, useState, useLayoutEffect } from "react";
import type { ProfilePoint } from "../lib/geo";
import { formatDistance, slopeColor } from "../lib/geo";

interface Props {
  profile: ProfilePoint[];
  accent: string;
  loading: boolean;
  /** Points of interest located along the route (distance in meters). */
  marks: { d: number; emoji: string; name: string }[];
  /** Distance ranges where the route passes again over itself. */
  overlaps: [number, number][];
  /** Cursor driven from outside (hovering the route on the map, replay). */
  cursorD?: number | null;
  onHover: (p: ProfilePoint | null) => void;
  onPick: (p: ProfilePoint) => void;
}

const PAD = { l: 44, r: 14, t: 14, b: 24 };

function niceStep(range: number, target: number) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export default function ElevationChart({ profile, accent, loading, marks, overlaps, cursorD, onHover, onPick }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 150 });
  const [localI, setHoverI] = useState<number | null>(null);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo(() => profile.filter((p) => p.ele != null) as (ProfilePoint & { ele: number })[], [profile]);

  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    const total = pts[pts.length - 1].d || 1;
    let min = Math.min(...pts.map((p) => p.ele));
    let max = Math.max(...pts.map((p) => p.ele));
    const span = Math.max(40, max - min);
    min = Math.floor((min - span * 0.1) / 10) * 10;
    max = Math.ceil((max + span * 0.12) / 10) * 10;
    const iw = size.w - PAD.l - PAD.r;
    const ih = size.h - PAD.t - PAD.b;
    const x = (d: number) => PAD.l + (d / total) * iw;
    const y = (e: number) => PAD.t + (1 - (e - min) / (max - min)) * ih;
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)},${y(p.ele).toFixed(1)}`).join("");
    const area = `${line}L${x(total)},${PAD.t + ih}L${x(0)},${PAD.t + ih}Z`;
    // Slope-colored strokes, merged into runs of the same color
    const runs: { color: string; d: string }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = slopeColor(((b.ele - a.ele) / (b.d - a.d || 1)) * 100);
      const seg = `${x(b.d).toFixed(1)},${y(b.ele).toFixed(1)}`;
      const last = runs[runs.length - 1];
      if (last && last.color === c) last.d += `L${seg}`;
      else runs.push({ color: c, d: `M${x(a.d).toFixed(1)},${y(a.ele).toFixed(1)}L${seg}` });
    }
    const yStep = niceStep(max - min, 3);
    const yTicks: number[] = [];
    for (let v = Math.ceil(min / yStep) * yStep; v <= max; v += yStep) yTicks.push(v);
    const xStep = niceStep(total, Math.max(2, Math.floor(iw / 90)));
    const xTicks: number[] = [];
    for (let v = 0; v <= total + 1; v += xStep) xTicks.push(v);
    return { total, x, y, line, area, runs, yTicks, xTicks, ih, iw };
  }, [pts, size]);

  const handleMove = (e: React.PointerEvent) => {
    if (!geom) return;
    const rect = wrap.current!.getBoundingClientRect();
    const d = ((e.clientX - rect.left - PAD.l) / geom.iw) * geom.total;
    const best = nearest(d);
    setHoverI(best);
    onHover(pts[best]);
  };
  const leave = () => {
    setHoverI(null);
    onHover(null);
  };

  const nearest = (d: number) => {
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].d <= d) lo = mid;
      else hi = mid;
    }
    return Math.abs(pts[hi].d - d) < Math.abs(pts[lo].d - d) ? hi : lo;
  };
  const hoverI = localI ?? (cursorD != null && pts.length > 1 ? nearest(cursorD) : null);
  const hp = hoverI != null ? pts[hoverI] : null;
  const slope =
    hoverI != null && hoverI > 0
      ? ((pts[hoverI].ele - pts[hoverI - 1].ele) / (pts[hoverI].d - pts[hoverI - 1].d || 1)) * 100
      : 0;

  return (
    <div
      className="chart"
      ref={wrap}
      onPointerMove={handleMove}
      onPointerLeave={leave}
      onClick={() => hoverI != null && onPick(pts[hoverI])}
    >
      {!geom ? (
        <div className="chart-empty">
          {loading ? <span className="spinner" /> : null}
          {loading ? "Calcul du profil…" : "Le profil altimétrique apparaîtra ici dès que vous tracerez un parcours."}
        </div>
      ) : (
        <svg width={size.w} height={size.h}>
          <defs>
            <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity="0.45" />
              <stop offset="100%" stopColor={accent} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {geom.yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={size.w - PAD.r} y1={geom.y(v)} y2={geom.y(v)} className="grid" />
              <text x={PAD.l - 8} y={geom.y(v) + 4} textAnchor="end" className="tick">
                {Math.round(v)}
              </text>
            </g>
          ))}
          {geom.xTicks.map((v) => (
            <text key={v} x={geom.x(v)} y={size.h - 6} textAnchor="middle" className="tick">
              {v >= 1000 ? `${+(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`}
            </text>
          ))}
          {overlaps.map(([a, b]) => (
            <rect key={a} x={geom.x(a)} y={PAD.t} width={Math.max(2, geom.x(b) - geom.x(a))} height={geom.ih} className="overlap" />
          ))}
          <path d={geom.area} fill="url(#area)" />
          {geom.runs.map((r, i) => (
            <path key={i} d={r.d} fill="none" stroke={r.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {marks
            .filter((m) => m.d <= geom.total)
            .map((m, i) => (
              <g key={i} transform={`translate(${geom.x(m.d)},${PAD.t})`}>
                <title>{m.name}</title>
                <line y1={10} y2={geom.ih} className="poi-line" />
                <text y={8} textAnchor="middle" fontSize={13}>
                  {m.emoji}
                </text>
              </g>
            ))}
          {hp && (
            <g>
              <line x1={geom.x(hp.d)} x2={geom.x(hp.d)} y1={PAD.t} y2={PAD.t + geom.ih} className="cursor" />
              <circle cx={geom.x(hp.d)} cy={geom.y(hp.ele)} r={5} fill={accent} stroke="#fff" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {hp && geom && (
        <div
          className="chart-tip"
          style={{ left: Math.min(Math.max(geom.x(hp.d), 70), size.w - 70), top: 6 }}
        >
          <b>{Math.round(hp.ele)} m</b>
          <span>{formatDistance(hp.d)}</span>
          <span style={{ color: slopeColor(slope) }}>
            {slope > 0 ? "+" : ""}
            {slope.toFixed(1)} %
          </span>
        </div>
      )}
    </div>
  );
}
