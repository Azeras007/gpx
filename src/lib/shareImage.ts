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
const PAPER = "#f4f0e6";
const INK = "#1d1c18";
const INK_3 = "#8b8578";
const LINE = "#d9d0bd";

/** Renders a shareable "story" card — a page of a field notebook — as a PNG. */
export async function renderCard(d: CardData): Promise<Blob> {
  // Make sure the web fonts are there before drawing text with them.
  await Promise.all([
    document.fonts?.load('500 72px "Fraunces Variable"'),
    document.fonts?.load('italic 400 30px "Fraunces Variable"'),
    document.fonts?.load('600 22px "Instrument Sans Variable"'),
  ]).catch(() => {});
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const serif = (w: number, size: number, italic = false) => `${italic ? "italic " : ""}${w} ${size}px "Fraunces Variable", Georgia, serif`;
  const sans = (w: number, size: number) => `${w} ${size}px "Instrument Sans Variable", system-ui, sans-serif`;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // Header: waymark + small caps
  ctx.fillStyle = "#fff";
  ctx.fillRect(80, 84, 44, 15);
  ctx.fillStyle = "#c8372d";
  ctx.fillRect(80, 99, 44, 15);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(80, 84, 44, 30);
  ctx.fillStyle = INK;
  ctx.font = sans(600, 22);
  ctx.letterSpacing = "4px";
  ctx.fillText("GPX STUDIO", 144, 107);
  const tag = d.activity === "run" ? "COURSE À PIED" : "RANDONNÉE";
  ctx.fillStyle = INK_3;
  ctx.textAlign = "right";
  ctx.fillText(tag, W - 80, 107);
  ctx.textAlign = "left";
  ctx.letterSpacing = "0px";

  // Title
  ctx.fillStyle = INK;
  ctx.font = serif(500, 76);
  const lines = wrap(ctx, d.name, W - 160).slice(0, 2);
  lines.forEach((l, i) => ctx.fillText(l, 76, 222 + i * 84));
  const top = 250 + lines.length * 84;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, top - 18);
  ctx.lineTo(W - 80, top - 18);
  ctx.stroke();

  // Route shape
  const box = { x: 110, y: top + 20, w: W - 220, h: 820 - top };
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
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 16;
    ctx.stroke();
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 8;
    ctx.stroke();
    const [sx, sy] = proj(pts[0]);
    const [ex, ey] = proj(pts[pts.length - 1]);
    dot(ctx, ex, ey, 12, INK);
    dot(ctx, sx, sy, 12, "#2e5a45");
  }

  // Elevation profile
  const eles = d.profile.filter((p) => p.ele != null) as (ProfilePoint & { ele: number })[];
  const pf = { x: 80, y: 900, w: W - 160, h: 150 };
  if (eles.length > 1) {
    const total = eles[eles.length - 1].d || 1;
    const lo = Math.min(...eles.map((p) => p.ele));
    const hi = Math.max(...eles.map((p) => p.ele));
    const span = Math.max(30, hi - lo);
    const px = (dd: number) => pf.x + (dd / total) * pf.w;
    const py = (e: number) => pf.y + pf.h - ((e - lo) / span) * pf.h;
    ctx.beginPath();
    eles.forEach((p, i) => (i ? ctx.lineTo(px(p.d), py(p.ele)) : ctx.moveTo(px(p.d), py(p.ele))));
    ctx.lineTo(px(total), pf.y + pf.h);
    ctx.lineTo(px(0), pf.y + pf.h);
    ctx.closePath();
    ctx.fillStyle = hexA(d.accent, 0.14);
    ctx.fill();
    ctx.beginPath();
    eles.forEach((p, i) => (i ? ctx.lineTo(px(p.d), py(p.ele)) : ctx.moveTo(px(p.d), py(p.ele))));
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = INK_3;
    ctx.font = serif(400, 26, true);
    ctx.fillText(`point culminant ${Math.round(hi)} m`, pf.x, pf.y - 16);
  }

  // Stats
  ctx.strokeStyle = LINE;
  ctx.beginPath();
  ctx.moveTo(80, 1110);
  ctx.lineTo(W - 80, 1110);
  ctx.stroke();
  const colW = (W - 160) / d.stats.length;
  d.stats.forEach((st, i) => {
    const x = 80 + i * colW;
    ctx.fillStyle = INK_3;
    ctx.font = sans(600, 20);
    ctx.letterSpacing = "3px";
    ctx.fillText(st.label.toUpperCase(), x, 1160);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = INK;
    ctx.font = serif(500, 50);
    ctx.fillText(st.value, x, 1222);
  });
  ctx.fillStyle = INK_3;
  ctx.font = serif(400, 24, true);
  ctx.fillText("préparé avec GPX Studio", 80, H - 52);

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
