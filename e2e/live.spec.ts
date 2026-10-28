import { expect, openWithRoute, test } from "./fixtures";

const route: [number, number][] = [
  [45.92, 6.86],
  [45.925, 6.87],
  [45.93, 6.875],
  [45.928, 6.885],
];

test("suivi en direct : progression, écart et arrivée", async ({ page, context, fakes }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 45.9201, longitude: 6.8602, accuracy: 8 });
  await openWithRoute(page, route);
  await page.getByTitle("Suivre ma position en direct").click();
  const hud = page.locator(".live-hud");
  await expect(hud).toContainText("Reste");
  const left = async () => (await hud.locator(".replay-figures b").first().innerText()).replace(/\s/g, "");
  const atStart = await left();
  expect(atStart).toMatch(/^2,4\d?km$/);
  await expect(page.locator(".me-dot")).toBeVisible();

  // Halfway along the second leg
  await context.setGeolocation({ latitude: 45.9275, longitude: 6.8725, accuracy: 8 });
  await expect.poll(left).not.toBe(atStart);
  expect(parseFloat((await left()).replace(",", "."))).toBeLessThan(1.6);

  // 300 m away from the line
  await context.setGeolocation({ latitude: 45.9275, longitude: 6.8765, accuracy: 8 });
  await expect(hud.locator(".live-alert")).toContainText("Hors parcours");
  await expect(page.locator(".me-dot.off")).toBeVisible();

  // Finish
  await context.setGeolocation({ latitude: 45.928, longitude: 6.8849, accuracy: 8 });
  await expect(page.locator(".toast").filter({ hasText: "Arrivée" })).toBeVisible();

  await hud.getByTitle("Arrêter le suivi en direct").click();
  await expect(hud).toHaveCount(0);
  await expect(page.locator(".me-dot")).toHaveCount(0);
  expect(fakes.errors).toEqual([]);
});

test("suivi en direct : position refusée", async ({ page }) => {
  await openWithRoute(page, route);
  await page.evaluate(() => {
    navigator.geolocation.watchPosition = (_ok, fail) => {
      setTimeout(() => fail?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "denied" } as GeolocationPositionError));
      return 1;
    };
  });
  await page.getByTitle("Suivre ma position en direct").click();
  await expect(page.locator(".toast.error")).toContainText("autorisez la localisation");
  await expect(page.locator(".live-hud")).toHaveCount(0);
});

test("boucle depuis ma position", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 45.9, longitude: 6.12, accuracy: 10 });
  await openWithRoute(page, route);
  await page.locator(".loop-card input[type=range]").fill("6");
  await page.getByRole("button", { name: "Depuis ma position" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Boucle de" })).toBeVisible({ timeout: 15000 });
  const d = await page.evaluate(() => JSON.parse(localStorage.getItem("gpx-studio:draft")!));
  expect(d.waypoints[0].lat).toBeCloseTo(45.9, 4);
  expect(d.waypoints[0].lng).toBeCloseTo(6.12, 4);
  expect(d.waypoints.at(-1).lat).toBeCloseTo(45.9, 4);
});
