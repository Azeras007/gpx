import type { Page } from "@playwright/test";
import { draft, expect, openEmpty, openWithRoute, test } from "./fixtures";

async function swipe(page: Page, x: number, y0: number, y1: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 8 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const sheetHeight = async (page: Page) => (await page.locator(".sheet").boundingBox())!.height;

/** Waits for the sheet to stop moving: a tap during its animation lands somewhere else. */
async function settled(page: Page) {
  let last = -1;
  await expect
    .poll(async () => {
      const h = await sheetHeight(page);
      const same = Math.abs(h - last) < 0.5;
      last = h;
      return same;
    })
    .toBe(true);
}

test("mobile : tracer au doigt et utiliser la barre rapide", async ({ page, fakes }) => {
  await openEmpty(page, { mode: "line" });
  const vp = page.viewportSize()!;
  await page.touchscreen.tap(vp.width / 2, vp.height * 0.35);
  await page.touchscreen.tap(vp.width / 2 + 80, vp.height * 0.3);
  await page.touchscreen.tap(vp.width / 2 + 40, vp.height * 0.45);
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(3);
  const bar = page.locator(".quickbar");
  await bar.getByRole("button", { name: "Annuler" }).tap();
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(2);
  await bar.getByRole("button", { name: "Rétablir" }).tap();
  await bar.getByRole("button", { name: "Boucler" }).tap();
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(4);
  const [dl] = await Promise.all([page.waitForEvent("download"), bar.getByRole("button", { name: "GPX" }).tap()]);
  expect(dl.suggestedFilename()).toMatch(/\.gpx$/);
  expect(fakes.errors).toEqual([]);
});

test("mobile : le panneau s'ouvre, se ferme et un tap carte le referme", async ({ page }) => {
  await openWithRoute(page);
  const peek = await sheetHeight(page);
  await page.locator(".sheet-top").tap();
  await expect.poll(() => sheetHeight(page)).toBeGreaterThan(peek + 200);
  // A tap on the map closes the sheet instead of adding a point
  await page.touchscreen.tap(200, 80 + 60);
  await expect.poll(() => sheetHeight(page)).toBeLessThan(peek + 5);
  expect((await draft(page)).waypoints).toHaveLength(4);
  // Swipe up all the way, then down
  const top = (await page.locator(".sheet-top").boundingBox())!;
  await swipe(page, top.x + top.width / 2, top.y + 20, 80);
  await expect.poll(() => sheetHeight(page)).toBeGreaterThan(page.viewportSize()!.height * 0.7);
  await settled(page);
  await page.getByRole("button", { name: "Planifier" }).click();
  // The planner is loaded on demand (compiled on first request by the dev server)
  await expect(page.locator(".splits")).toBeVisible({ timeout: 20000 });
  const top2 = (await page.locator(".sheet-top").boundingBox())!;
  await swipe(page, top2.x + top2.width / 2, top2.y + 20, page.viewportSize()!.height - 20);
  await expect.poll(() => sheetHeight(page)).toBeLessThan(peek + 5);
});

test("mobile : survol piloté depuis le bandeau, panneau fermé", async ({ page }) => {
  await openWithRoute(page);
  await page.locator(".sheet-top").tap();
  await page.locator(".m-profile .replay-btn").tap();
  const hud = page.locator(".replay-hud");
  await expect(hud).toBeVisible();
  await expect(page.locator(".quickbar")).toHaveCount(0);
  await hud.getByTitle("Pause").tap();
  const before = await page.locator(".replay-figures b").first().innerText();
  await page.locator(".replay-seek").fill("1500");
  await expect(page.locator(".replay-figures b").first()).not.toHaveText(before);
  await hud.getByTitle("Arrêter le survol").tap();
  await expect(hud).toHaveCount(0);
  await expect(page.locator(".quickbar")).toBeVisible();
  // Map tools stay reachable next to the banner
  await expect(page.getByTitle("Me localiser")).toBeVisible();
});

test("mobile : avis utilisateur", async ({ page, fakes }) => {
  await openWithRoute(page);
  await page.locator(".sheet-top").tap();
  await page.getByTitle("Donner mon avis").tap();
  await page.locator(".modal.feedback textarea").fill("Très pratique sur le terrain");
  await page.locator(".modal.feedback").getByRole("button", { name: "Envoyer" }).tap();
  await expect(page.getByText("Merci, c'est bien reçu")).toBeVisible();
  expect(fakes.reports.at(-1)).toMatchObject({ kind: "feedback", message: "Très pratique sur le terrain" });
});
