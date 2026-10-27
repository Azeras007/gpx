import type { Activity, LatLng, ProfilePoint } from "./geo";

export interface CardData {
  name: string;
  activity: Activity;
  accent: string;
  track: LatLng[];
  profile: ProfilePoint[];
  stats: { label: string; value: string }[];
}

const W = 1080;
const H = 1350;

/** Renders a shareable "story" card (route shape, profile and key stats) as a PNG. */
export async function renderCard(d: CardData): Promise<Blob> {
  await document.fonts?.ready;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const font = (w: number, size: number) => `${w} ${size}px Inter, system-ui, sans-serif`;

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0b0f17");
  bg.addColorStop(1, "#141a26");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(140, 120, 0, 140, 120, 900);
  glow.addColorStop(0, hexA(d.accent, 0.28));
  glow.addColorStop(1, hexA(d.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = font(700, 26);
  ctx.letterSpacing = "6px";
  ctx.fillText("GPX STUDIO", 80, 110);
  ctx.letterSpacing = "0px";
  const pill = d.activity === "run" ? "COURSE À PIED" : "RANDONNÉE";
  ctx.font = font(700, 24);
  const pw = ctx.measureText(pill).width + 44;
  roundRect(ctx, W - 80 - pw, 78, pw, 46, 23);
  ctx.fillStyle = d.accent;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(pill, W - 80 - pw + 22, 110);

  ctx.font = font(800, 68);
  ctx.fillStyle = "#fff";
  const lines = wrap(ctx, d.name, W - 160).slice(0, 2);
  lines.forEach((l, i) => ctx.fillText(l, 80, 210 + i * 78));
  const top = 230 + lines.length * 78;

  // Route shape
  const box = { x: 100, y: top + 20, w: W - 200, h: 840 - top };
  if (d.track.length > 1) {
    const lat0 = (d.track.reduce((a, p) => a + p[0], 0) / d.track.length) * (Math.PI / 180);
    const pts = d.track.map(([la, ln]) => [ln * Math.cos(lat0), -la]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min(box.w / (maxX - minX || 1e-9), box.h / (maxY - minY || 1e-9));
    const ox = box.x + (box.w - (maxX - minX) * s) / 2;
    const oy = box.y + (box.h - (maxY - minY) * s) / 2;
    const proj = (p: number[]) => [ox + (p[0] - minX) * s, oy + (p[1] - minY) * s];
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [x, y] = proj(p);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.shadowColor = d.accent;
    ctx.shadowBlur = 40;
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
    const [sx, sy] = proj(pts[0]);
    const [ex, ey] = proj(pts[pts.length - 1]);
    dot(ctx, ex, ey, 16, "#111827");
    dot(ctx, sx, sy, 16, "#10b981");
  }

  // Elevation profile
  const eles = d.profile.filter((p) => p.ele != null) as (ProfilePoint & { ele: number })[];
  const pf = { x: 80, y: 930, w: W - 160, h: 170 };
  if (eles.length > 1) {
    const total = eles[eles.length - 1].d || 1;
    const lo = Math.min(...eles.map((p) => p.ele));
    const hi = Math.max(...eles.map((p) => p.ele));
    const span = Math.max(30, hi - lo);
    const px = (dd: number) => pf.x + (dd / total) * pf.w;
    const py = (e: number) => pf.y + pf.h - ((e - lo) / span) * pf.h;
    ctx.beginPath();
    eles.forEach((p, i) => (i ? ctx.lineTo(px(p.d), py(p.ele)) : ctx.moveTo(px(p.d), py(p.ele))));
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.lineTo(px(total), pf.y + pf.h);
    ctx.lineTo(px(0), pf.y + pf.h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, pf.y, 0, pf.y + pf.h);
    fill.addColorStop(0, hexA(d.accent, 0.45));
    fill.addColorStop(1, hexA(d.accent, 0.02));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = font(600, 22);
    ctx.fillText(`${Math.round(hi)} m`, pf.x, pf.y - 14);
  }

  // Stats
  const colW = (W - 160) / d.stats.length;
  d.stats.forEach((st, i) => {
    const x = 80 + i * colW;
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = font(700, 22);
    ctx.fillText(st.label.toUpperCase(), x, 1180);
    ctx.fillStyle = "#fff";
    ctx.font = font(800, 46);
    ctx.fillText(st.value, x, 1240);
  });
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = font(500, 22);
  ctx.fillText("Tracé avec GPX Studio", 80, H - 50);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Image impossible"))), "image/png"));
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, r + 5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > max && line) {
      out.push(line);
      line = w;
    } else line = test;
  }
  if (line) out.push(line);
  return out;
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
