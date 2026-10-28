// Error reporting and user feedback, sent to /api/report (a Vercel function
// that forwards them to Telegram). Everything here fails silently: reporting
// must never break the app or bother the user.

const ENDPOINT = import.meta.env.VITE_REPORT_URL || "/api/report";
const VERSION = (import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA as string | undefined)?.slice(0, 7) || "dev";
/** At most this many error reports per page load. */
const MAX_PER_SESSION = 15;

const session = Math.random().toString(36).slice(2, 10);
const sent = new Set<string>();
let count = 0;
const crumbs: string[] = [];
let contextProvider: () => Record<string, string | number | boolean | null> = () => ({});

/** Last user actions, attached to error reports to understand what led there. */
export function breadcrumb(text: string) {
  const t = new Date().toTimeString().slice(0, 8);
  crumbs.push(`${t} ${text}`);
  if (crumbs.length > 25) crumbs.shift();
}

/** App state attached to reports (route length, active tab…), read when a report is sent. */
export function setReportContext(fn: typeof contextProvider) {
  contextProvider = fn;
}

function safeContext() {
  try {
    return contextProvider();
  } catch {
    return {};
  }
}

function base() {
  return {
    url: location.pathname + location.search,
    userAgent: navigator.userAgent,
    viewport: `${innerWidth}×${innerHeight}`,
    version: VERSION,
    session,
  };
}

async function post(body: object, keepalive = true): Promise<Response | null> {
  try {
    return await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive,
    });
  } catch {
    return null;
  }
}

// Noise that says nothing about the app: browser extensions, benign browser
// warnings, cancelled requests, cross-origin scripts without details.
const IGNORED = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /AbortError|aborted|Recherche annulée/i,
  /chrome-extension:|moz-extension:|safari-extension:/i,
  /Non-Error promise rejection captured/i,
];

function normalize(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: err.stack };
  if (typeof err === "string") return { message: err };
  try {
    return { message: JSON.stringify(err).slice(0, 500) };
  } catch {
    return { message: String(err) };
  }
}

/**
 * Sends an error to the developer. `source` tells where it comes from
 * ("window", "promise", "react", "routage"…); `level: "warn"` is for a
 * service that failed but the app coped (fallback, message to the user).
 */
export function reportError(err: unknown, source = "app", level: "error" | "warn" = "error", extra?: Record<string, string | number | boolean | null>) {
  try {
    const { message, stack } = normalize(err);
    if (!message || IGNORED.some((r) => r.test(message) || (stack && r.test(stack)))) return;
    const signature = `${source}|${message}`;
    if (sent.has(signature) || count >= MAX_PER_SESSION) return;
    sent.add(signature);
    count++;
    if (import.meta.env.DEV) console.info("[report]", source, message);
    void post({
      kind: "error",
      level,
      source,
      message,
      stack,
      breadcrumbs: crumbs.slice(),
      context: { ...safeContext(), ...extra },
      ...base(),
    });
  } catch {
    /* never throw from the reporter */
  }
}

export interface Feedback {
  category: string;
  message: string;
  rating?: number;
  email?: string;
  routeLink?: string;
}

/** Sends a user's feedback; resolves with an error message to show, or null when it went through. */
export async function sendFeedback(f: Feedback): Promise<string | null> {
  const res = await post({ kind: "feedback", ...f, breadcrumbs: crumbs.slice(), context: safeContext(), ...base() }, false);
  if (res?.ok) return null;
  if (res?.status === 429) return "Vous avez déjà envoyé plusieurs messages, réessayez dans quelques minutes.";
  if (res?.status === 503 || res?.status === 404) return "L'envoi des messages n'est pas encore activé sur ce site.";
  return "Envoi impossible pour le moment. Vérifiez votre connexion et réessayez.";
}

let installed = false;

/** Catches every uncaught error and rejected promise, and records clicks as breadcrumbs. */
export function installErrorReporting() {
  if (installed) return;
  installed = true;
  addEventListener("error", (e) => {
    // A resource that failed to load (image, script) has no error object
    if (!(e instanceof ErrorEvent)) return;
    reportError(e.error ?? `${e.message} (${e.filename}:${e.lineno}:${e.colno})`, "window");
  });
  addEventListener("unhandledrejection", (e) => reportError(e.reason, "promise"));
  addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.("button, a, [role=button], label");
      if (!el) return;
      const label = (el.getAttribute("title") || el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
      if (label) breadcrumb(`clic « ${label.slice(0, 50)} »`);
    },
    { capture: true, passive: true },
  );
  addEventListener("online", () => breadcrumb("connexion retrouvée"));
  addEventListener("offline", () => breadcrumb("hors ligne"));
}
