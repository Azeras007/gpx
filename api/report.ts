// Vercel function: forwards app errors and user feedback to Telegram.
//
// The bot token never reaches the browser. Configure in Vercel → Settings →
// Environment Variables:
//   TELEGRAM_BOT_TOKEN   token given by @BotFather
//   TELEGRAM_CHAT_ID     chat (or channel) that receives the messages
//   TELEGRAM_FEEDBACK_CHAT_ID  optional, another chat for user feedback
//   REPORT_ALLOWED_ORIGINS     optional, comma-separated origins allowed to post
// Without the token and chat id the endpoint answers 503 and sends nothing.

// Read through globalThis so the file compiles with or without Node's types
const env = () => (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

type Kind = "error" | "feedback";

interface Payload {
  kind: Kind;
  /** error: message, source, stack… */
  message?: string;
  stack?: string;
  source?: string;
  level?: "error" | "warn";
  /** feedback */
  category?: string;
  rating?: number;
  email?: string;
  routeLink?: string;
  /** both */
  url?: string;
  userAgent?: string;
  viewport?: string;
  version?: string;
  session?: string;
  breadcrumbs?: string[];
  context?: Record<string, string | number | boolean | null>;
}

const LIMITS: Record<Kind, { max: number; windowMs: number }> = {
  error: { max: 30, windowMs: 60_000 },
  feedback: { max: 5, windowMs: 10 * 60_000 },
};

// Per-instance memory: enough to stop a loop or a spammer from flooding the chat.
const hits = new Map<string, number[]>();
const recentErrors = new Map<string, number>();

function limited(key: string, kind: Kind) {
  const { max, windowMs } = LIMITS[kind];
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

/** The same error from many visitors is sent once every 10 minutes. */
function duplicate(signature: string) {
  const now = Date.now();
  const last = recentErrors.get(signature);
  if (last && now - last < 10 * 60_000) return true;
  recentErrors.set(signature, now);
  if (recentErrors.size > 2000) recentErrors.clear();
  return false;
}

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

function format(p: Payload, ip: string, compact = false): string {
  const lines: string[] = [];
  if (p.kind === "feedback") {
    const stars = typeof p.rating === "number" && p.rating >= 1 && p.rating <= 5 ? " " + "★".repeat(p.rating) + "☆".repeat(5 - p.rating) : "";
    lines.push(`💬 <b>Retour utilisateur</b> · ${esc(cut(p.category, 30) || "Autre")}${stars}`);
    lines.push("");
    lines.push(esc(cut(p.message, 3000)));
    if (p.email) lines.push("", `✉️ ${esc(cut(p.email, 120))}`);
    const link = cut(p.routeLink, 1500);
    if (/^https?:\/\//.test(link)) lines.push("", `🗺 <a href="${esc(link).replace(/"/g, "&quot;")}">Parcours joint</a>`);
  } else {
    lines.push(`${p.level === "warn" ? "⚠️" : "🔴"} <b>${p.level === "warn" ? "Problème" : "Erreur"}</b> · ${esc(cut(p.source, 40) || "app")}`);
    lines.push("");
    lines.push(`<code>${esc(cut(p.message, 600))}</code>`);
    if (p.stack) lines.push("", `<pre>${esc(cut(p.stack, compact ? 500 : 1500))}</pre>`);
    if (Array.isArray(p.breadcrumbs) && p.breadcrumbs.length) {
      lines.push("", "<b>Dernières actions</b>");
      lines.push(esc(p.breadcrumbs.slice(compact ? -4 : -10).map((b) => `• ${cut(b, 100)}`).join("\n")));
    }
  }
  const ctx = Object.entries(p.context ?? {})
    .slice(0, 15)
    .map(([k, v]) => `${cut(k, 30)}: ${cut(String(v), 80)}`);
  if (ctx.length) lines.push("", esc(ctx.join(" · ")));
  lines.push("");
  lines.push(
    esc(
      [
        cut(p.url, 200),
        cut(p.userAgent, 200),
        p.viewport ? `écran ${cut(p.viewport, 20)}` : "",
        p.version ? `version ${cut(p.version, 12)}` : "",
        p.session ? `session ${cut(p.session, 12)}` : "",
        `ip ${ip.replace(/\.\d+$/, ".x")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );
  return lines.join("\n");
}

/** Telegram refuses messages over 4096 characters: shorten, and as a last resort send plain text. */
function message(p: Payload, ip: string): { text: string; parse_mode?: "HTML" } {
  for (const compact of [false, true]) {
    const text = format(p, ip, compact);
    if (text.length <= 4000) return { text, parse_mode: "HTML" };
  }
  const plain = format(p, ip, true)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  return { text: plain.slice(0, 4000) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const token = env().TELEGRAM_BOT_TOKEN;
  const chat = env().TELEGRAM_CHAT_ID;

  const allowed = (env().REPORT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  if (allowed.length && origin && !allowed.includes(origin)) return json(403, { ok: false, error: "origin" });

  const raw = await request.text();
  if (raw.length > 20_000) return json(413, { ok: false, error: "too-large" });
  let p: Payload;
  try {
    p = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "json" });
  }
  if (p.kind !== "error" && p.kind !== "feedback") return json(400, { ok: false, error: "kind" });
  if (p.kind === "feedback" && !cut(p.message, 3000).trim()) return json(400, { ok: false, error: "empty" });

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  if (limited(`${ip}:${p.kind}`, p.kind)) return json(429, { ok: false, error: "rate-limited" });
  if (p.kind === "error" && duplicate(`${cut(p.source, 40)}|${cut(p.message, 200)}`)) return json(200, { ok: true, deduplicated: true });

  if (!token || !chat) return json(503, { ok: false, error: "not-configured" });
  const target = p.kind === "feedback" ? env().TELEGRAM_FEEDBACK_CHAT_ID || chat : chat;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: target, ...message(p, ip), disable_web_page_preview: true }),
  }).catch(() => null);
  if (!res?.ok) return json(502, { ok: false, error: "telegram" });
  return json(200, { ok: true });
}

export function GET(): Response {
  const configured = !!env().TELEGRAM_BOT_TOKEN && !!env().TELEGRAM_CHAT_ID;
  return json(200, { ok: true, configured });
}
