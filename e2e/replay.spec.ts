import type { Page } from "@playwright/test";
import { expect, openWithRoute, test } from "./fixtures";

const km = async (page: Page) => page.locator(".replay-figures b").first().innerText();
const dot = async (page: Page) => (await page.locator(".replay-dot").boundingBox())!;

test("survol : pause, le profil et le point pilotent la position", async ({ page, fakes }) => {
  await openWithRoute(page);
  await page.locator(".profile .replay-btn").click();
  await expect(page.locator(".replay-dot")).toBeVisible();
  await page.locator(".replay-buttons").getByTitle("Pause").click();
  const chart = (await page.locator(".profile .chart").boundingBox())!;
  await page.mouse.move(chart.x + chart.width * 0.3, chart.y + chart.height / 2);
  const k30 = await km(page);
  const p30 = await dot(page);
  await page.mouse.move(chart.x + chart.width * 0.7, chart.y + chart.height / 2);
  await expect.poll(() => km(page)).not.toBe(k30);
  expect((await dot(page)).x).not.toBe(p30.x);
  // Bring the point back on screen, then drag it along the route
  await page.locator(".replay-buttons").getByTitle("Reprendre").click();
  await page.waitForTimeout(300);
  await page.locator(".replay-buttons").getByTitle("Pause").click();
  const before = await km(page);
  const b = await dot(page);
  await page.mouse.move(b.x + 13, b.y + 13);
  await page.mouse.down();
  await page.mouse.move(b.x - 130, b.y + 110, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => km(page)).not.toBe(before);
  // The slider also seeks
  await page.locator(".replay-seek").fill("0");
  await expect.poll(() => km(page)).toBe("0,00 km");
  expect(fakes.errors).toEqual([]);
});

test("survol : déplacer la carte arrête le suivi, « Suivre » le reprend", async ({ page }) => {
  await openWithRoute(page);
  await page.keyboard.press(" ");
  await expect(page.locator(".replay-dot")).toBeVisible();
  await page.mouse.move(1000, 300);
  await page.mouse.down();
  await page.mouse.move(800, 200, { steps: 8 });
  await page.mouse.up();
  const follow = page.getByTitle("Recentrer la carte sur le point");
  await expect(follow).toBeVisible();
  const a = await dot(page);
  await page.waitForTimeout(500);
  expect((await dot(page)).x).not.toBe(a.x);
  await follow.click();
  await expect(follow).toHaveCount(0);
  // Space pauses, Escape stops
  await page.keyboard.press(" ");
  await expect(page.locator(".replay-buttons").getByTitle("Reprendre")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".replay-hud")).toHaveCount(0);
  await expect(page.locator(".replay-dot")).toHaveCount(0);
});

test("survol : jusqu'au bout puis rejouer, et les points restent déplaçables", async ({ page }) => {
  await openWithRoute(page);
  await page.locator(".profile .replay-btn").click();
  await page.locator(".replay-buttons .speed").first().click(); // 2×
  await page.locator(".replay-buttons .speed").first().click(); // 4×
  await page.locator(".replay-buttons .speed").first().click(); // 8×
  await expect(page.locator(".replay-buttons").getByTitle("Rejouer")).toBeVisible({ timeout: 10000 });
  await page.locator(".replay-buttons").getByTitle("Arrêter le survol").click();
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  const wp = (await page.locator(".wp-mid").first().boundingBox())!;
  const lat0 = await page.evaluate(() => JSON.parse(localStorage.getItem("gpx-studio:draft")!).waypoints[1].lat);
  await page.mouse.move(wp.x + 9, wp.y + 9);
  await page.mouse.down();
  await page.mouse.move(wp.x + 80, wp.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("gpx-studio:draft")!).waypoints[1].lat)).not.toBe(lat0);
});
