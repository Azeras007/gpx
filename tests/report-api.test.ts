// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env: Record<string, string | undefined> = {};
vi.stubGlobal("process", { env });
const sent: { url: string; body: Record<string, string> }[] = [];
let telegramOk = true;

const { POST, GET } = await import("../api/report");
const realFetch = globalThis.fetch;

const req = (body: unknown, ip = "1.2.3.4", origin = "https://gpx.example") =>
  new Request("https://x/api/report", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "x-forwarded-for": ip, origin },
  });
let ipN = 0;
const freshIp = () => `10.0.${Math.floor(++ipN / 250)}.${ipN % 250}`;

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  env.TELEGRAM_BOT_TOKEN = "T";
  env.TELEGRAM_CHAT_ID = "42";
  telegramOk = true;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: telegramOk ? 200 : 400 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("api/report", () => {
  it("does nothing until configured", async () => {
    delete env.TELEGRAM_BOT_TOKEN;
    expect((await POST(req({ kind: "error", message: "unconfigured" }, freshIp()))).status).toBe(503);
    expect(await (await GET()).json()).toEqual({ ok: true, configured: false });
  });
  it("validates input", async () => {
    expect((await POST(req("{bad", freshIp()))).status).toBe(400);
    expect((await POST(req({ kind: "x" }, freshIp()))).status).toBe(400);
    expect((await POST(req({ kind: "feedback", message: "  " }, freshIp()))).status).toBe(400);
    expect((await POST(req("x".repeat(30000), freshIp()))).status).toBe(413);
  });
  it("forwards an escaped error with its context", async () => {
    const r = await POST(req({ kind: "error", source: "routage", message: "<b>boom</b>", stack: "at x", breadcrumbs: ["clic « GPX »"], context: { points: 3 } }));
    expect(r.status).toBe(200);
    const m = sent.at(-1)!;
    expect(m.url).toBe("https://api.telegram.org/botT/sendMessage");
    expect(m.body.chat_id).toBe("42");
    expect(m.body.parse_mode).toBe("HTML");
    expect(m.body.text).toContain("&lt;b&gt;boom&lt;/b&gt;");
    expect(m.body.text).toContain("clic « GPX »");
    expect(m.body.text).toContain("ip 1.2.3.x");
  });
  it("sends the same error only once", async () => {
    const n = sent.length;
    await POST(req({ kind: "error", source: "s", message: "dup" }, freshIp()));
    const second = await POST(req({ kind: "error", source: "s", message: "dup" }, freshIp()));
    expect((await second.json()).deduplicated).toBe(true);
    expect(sent.length).toBe(n + 1);
  });
  it("routes feedback to its own chat, with the rating", async () => {
    env.TELEGRAM_FEEDBACK_CHAT_ID = "77";
    await POST(req({ kind: "feedback", category: "Idée", rating: 4, message: "Top", routeLink: "https://a.b/app.html#r=x" }, freshIp()));
    const m = sent.at(-1)!;
    expect(m.body.chat_id).toBe("77");
    expect(m.body.text).toContain("★★★★☆");
    expect(m.body.text).toContain('href="https://a.b/app.html#r=x"');
  });
  it("ignores links that are not web links", async () => {
    await POST(req({ kind: "feedback", message: "q", routeLink: 'javascript:alert(1)"' }, freshIp()));
    expect(sent.at(-1)!.body.text).not.toContain("javascript:");
  });
  it("rate limits feedback per visitor", async () => {
    const ip = freshIp();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await POST(req({ kind: "feedback", message: `m${i}` }, ip))).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });
  it("refuses other sites when origins are set", async () => {
    env.REPORT_ALLOWED_ORIGINS = "https://gpx.example";
    expect((await POST(req({ kind: "feedback", message: "x" }, freshIp(), "https://evil.example"))).status).toBe(403);
    expect((await POST(req({ kind: "feedback", message: "x" }, freshIp()))).status).toBe(200);
  });
  it("reports Telegram failures", async () => {
    telegramOk = false;
    expect((await POST(req({ kind: "error", message: "tg down" }, freshIp()))).status).toBe(502);
  });
  it("keeps huge reports under Telegram's limit with balanced tags", async () => {
    await POST(
      req(
        { kind: "error", message: "m".repeat(5000), stack: "s".repeat(5000), breadcrumbs: Array(30).fill("b".repeat(200)), context: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(100)])) },
        freshIp(),
      ),
    );
    const t = sent.at(-1)!.body.text;
    expect(t.length).toBeLessThanOrEqual(4000);
    expect((t.match(/<pre>/g) ?? []).length).toBe((t.match(/<\/pre>/g) ?? []).length);
  });
});
