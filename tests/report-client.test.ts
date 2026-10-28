import { beforeEach, describe, expect, it, vi } from "vitest";
import { breadcrumb, reportError, sendFeedback, setReportContext } from "../src/lib/report";

const calls: { url: string; body: Record<string, unknown> }[] = [];
let status = 200;
beforeEach(() => {
  status = 200;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status });
  });
});

describe("report client", () => {
  it("sends an error once with breadcrumbs and context", () => {
    setReportContext(() => ({ points: 7 }));
    breadcrumb("clic « Exporter »");
    reportError(new TypeError("x is undefined"), "test");
    reportError(new TypeError("x is undefined"), "test");
    const errs = calls.filter((c) => c.body.message === "TypeError: x is undefined");
    expect(errs).toHaveLength(1);
    expect(errs[0].url).toBe("/api/report");
    expect(errs[0].body.context).toEqual({ points: 7 });
    expect(String((errs[0].body.breadcrumbs as string[])[0])).toContain("Exporter");
  });
  it("ignores noise", () => {
    const n = calls.length;
    reportError(new Error("ResizeObserver loop completed with undelivered notifications."));
    reportError(new DOMException("The user aborted a request.", "AbortError"));
    reportError("Script error.");
    expect(calls.length).toBe(n);
  });
  it("never throws, even when the context does", () => {
    setReportContext(() => {
      throw new Error("bad state");
    });
    expect(() => reportError(new Error("still sent"))).not.toThrow();
    expect(calls.at(-1)!.body.message).toBe("Error: still sent");
  });
  it("caps the number of reports per visit", () => {
    for (let i = 0; i < 40; i++) reportError(new Error(`e${i}`));
    expect(calls.filter((c) => c.body.kind === "error").length).toBeLessThanOrEqual(15);
  });
  it("feedback: explains each failure", async () => {
    expect(await sendFeedback({ category: "Idée", message: "ok" })).toBeNull();
    status = 429;
    expect(await sendFeedback({ category: "Idée", message: "ok" })).toMatch(/plusieurs messages/);
    status = 503;
    expect(await sendFeedback({ category: "Idée", message: "ok" })).toMatch(/pas encore activé/);
    status = 500;
    expect(await sendFeedback({ category: "Idée", message: "ok" })).toMatch(/réessayez/);
  });
});
