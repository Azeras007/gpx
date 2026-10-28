import { draft, expect, openEmpty, openWithRoute, shownDistance, test } from "./fixtures";

test("tracer au clic en suivant les chemins", async ({ page, fakes }) => {
  await openEmpty(page);
  await expect(page.locator(".hint")).toContainText("Cliquez sur la carte");
  await page.mouse.click(800, 450);
  await page.mouse.click(950, 350);
  await page.mouse.click(1100, 420);
  await expect.poll(() => fakes.routingCalls.length).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".routing")).toHaveCount(0);
  const d = await shownDistance(page);
  expect(d).toBeGreaterThan(500);
  // Elevation from the fake terrain: the route climbs eastwards
  await expect(page.locator(".profile svg path").first()).toBeVisible();
  await expect.poll(async () => parseInt(await page.locator(".stat.up b").innerText())).toBeGreaterThan(0);
  expect((await draft(page)).waypoints).toHaveLength(3);
  expect(fakes.errors).toEqual([]);
});

test("ligne droite, annuler, rétablir, raccourcis", async ({ page, fakes }) => {
  await openEmpty(page, { mode: "line" });
  await page.mouse.click(800, 450);
  await page.mouse.click(1000, 450);
  await page.mouse.click(1000, 300);
  expect(fakes.routingCalls).toHaveLength(0);
  expect((await draft(page)).waypoints).toHaveLength(3);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(2);
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(3);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(2);
  // Removing a point is an edit: it can be undone
  await page.getByRole("button", { name: "Annuler" }).first().click();
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(3);
  // B closes the loop back to the start
  await page.keyboard.press("b");
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(4);
  const w = (await draft(page)).waypoints;
  expect(w[3].lat).toBeCloseTo(w[0].lat, 8);
  expect(fakes.errors).toEqual([]);
});

test("aller-retour, inverser, effacer puis annuler", async ({ page }) => {
  await openWithRoute(page);
  const d0 = await shownDistance(page);
  await page.getByRole("button", { name: "Aller-retour" }).click();
  await expect.poll(() => shownDistance(page)).toBeGreaterThan(d0 * 1.9);
  await expect(page.locator(".alert.warn")).toContainText("parcourus deux fois");
  await page.keyboard.press("Control+z");
  const before = (await draft(page)).waypoints;
  await page.getByRole("button", { name: "Inverser" }).click();
  await expect.poll(async () => (await draft(page)).waypoints[0].lat).toBeCloseTo(before.at(-1).lat, 8);
  await page.getByRole("button", { name: "Effacer" }).click();
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(0);
  await expect(page.locator(".toast").filter({ hasText: "Ctrl+Z" })).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(4);
});

test("déplacer, insérer et supprimer un point", async ({ page }) => {
  await openWithRoute(page);
  const mid = page.locator(".wp-mid").first();
  const box = (await mid.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 50, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await draft(page)).waypoints[1].lat).not.toBe(45.925);
  // Click on the line inserts a point
  await mid.dblclick();
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(3);
});

test("générer une boucle de la distance voulue", async ({ page, fakes }) => {
  await openEmpty(page);
  await page.locator(".loop-card input[type=range]").fill("8");
  await page.getByRole("button", { name: /Générer la boucle/ }).click();
  await expect(page.locator(".toast").filter({ hasText: "Boucle de" })).toBeVisible({ timeout: 15000 });
  const d = await shownDistance(page);
  expect(d).toBeGreaterThan(8000 * 0.7);
  expect(d).toBeLessThan(8000 * 1.3);
  expect(fakes.routingCalls.some((u) => u.includes("nogos"))).toBe(true);
});

test("routage en panne : ligne droite et message clair", async ({ page, fakes }) => {
  fakes.routingDown = true;
  await openEmpty(page);
  await page.mouse.click(800, 450);
  await page.mouse.click(1000, 400);
  await expect(page.locator(".toast.error")).toContainText("ligne droite");
  expect(await shownDistance(page)).toBeGreaterThan(100);
  // The failure is reported to the developer
  await expect.poll(() => fakes.reports.some((r) => r.source === "routage")).toBe(true);
});

test("ajouter un repère et des points OpenStreetMap", async ({ page }) => {
  await openWithRoute(page);
  await page.locator(".poi-picker button[title=\"Point d'eau\"]").click();
  await expect(page.locator(".hint")).toContainText("Point d'eau");
  await page.mouse.click(900, 500);
  await expect.poll(async () => (await draft(page)).pois.length).toBe(1);
  await page.getByRole("button", { name: /Trouver eau, refuges/ }).click();
  await expect(page.locator(".toast").filter({ hasText: "point(s) d'eau" })).toBeVisible();
  // The shelter 50 km away is left out
  await expect(page.locator(".osm-poi")).toHaveCount(2);
  await page.locator(".osm-poi").first().click();
  await expect.poll(async () => (await draft(page)).pois.length).toBe(2);
});

test("recherche de lieu", async ({ page }) => {
  await openEmpty(page);
  await page.getByPlaceholder("Rechercher un lieu").fill("Annecy");
  await expect(page.locator(".results li").first()).toContainText("Annecy");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("gpx-studio:prefs")!).view?.lng)) ?? 0, { timeout: 6000 }).toBeLessThan(6.3);
});
