import { draft, expect, openEmpty, test } from "./fixtures";

test("explorer la communauté et utiliser un parcours", async ({ page, fakes }) => {
  await openEmpty(page);
  await page.getByRole("button", { name: "Explorer" }).click();
  await page.getByRole("button", { name: "Zone affichée" }).click();
  const card = page.locator(".tours li").first();
  await expect(card).toContainText("Boucle matinale du lac");
  await expect(card).toContainText("par Coureuse");
  await expect(card.locator(".tour-stats")).toContainText("km");
  await page.locator(".chips button").filter({ hasText: "Rando" }).click();
  await expect(page.locator(".tours li")).toHaveCount(0);
  await page.locator(".chips button").filter({ hasText: "Course" }).click();
  await card.locator("button.tour").click();
  await expect(page.locator(".tour-card")).toBeVisible();
  await page.getByRole("button", { name: "Utiliser ce parcours" }).click();
  await expect(page.locator(".title-input")).toHaveValue("Boucle matinale du lac");
  expect((await draft(page)).waypoints.length).toBeGreaterThan(5);
  expect(fakes.errors).toEqual([]);
});

test("explorer les sentiers balisés", async ({ page }) => {
  await openEmpty(page);
  await page.getByRole("button", { name: "Explorer" }).click();
  await page.getByRole("button", { name: "Sentiers balisés" }).click();
  await page.getByRole("button", { name: "Zone affichée" }).click();
  const card = page.locator(".tours li").first();
  await expect(card).toContainText("Sentier des Tests");
  await expect(card.locator(".trail-badge")).toHaveText("PR");
  await expect(card.locator(".tour-stats")).toContainText("km", { timeout: 10000 });
  await card.locator("button.tour").click();
  await page.getByRole("button", { name: "Utiliser ce parcours" }).click();
  await expect(page.locator(".title-input")).toHaveValue(/Sentier des Tests/);
});

test("explorer : serveur en panne, message et nouvel essai possible", async ({ page, fakes }) => {
  await page.route(/api\.openstreetmap\.org/, (r) => r.fulfill({ status: 509, body: "busy" }));
  await openEmpty(page);
  await page.getByRole("button", { name: "Explorer" }).click();
  await page.getByRole("button", { name: "Zone affichée" }).click();
  await expect(page.locator(".explorer .alert")).toContainText("saturé");
  await expect(page.getByRole("button", { name: "Zone affichée" })).toBeEnabled();
  await expect.poll(() => fakes.reports.some((r) => r.source === "communauté")).toBe(true);
});
