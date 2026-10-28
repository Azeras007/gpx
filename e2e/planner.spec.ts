import { expect, openWithRoute, test } from "./fixtures";

test("planifier : météo, arrivée, temps de passage, objectif", async ({ page, fakes }) => {
  await openWithRoute(page, [[45.92, 6.86], [45.93, 6.88], [45.94, 6.9], [45.95, 6.91]]);
  await page.getByRole("button", { name: "Planifier" }).click();
  await page.getByRole("button", { name: "Maintenant" }).click();
  await expect(page.locator(".timeline")).toBeVisible();
  await expect(page.locator(".weather .hour").first()).toBeVisible();
  await expect(page.locator(".source")).toContainText("Open-Meteo");
  await expect(page.locator(".splits .split:not(.head)")).not.toHaveCount(0);
  // Target time → pace to keep, applied in one click
  await page.getByPlaceholder("ex. 1:45").fill("0:30");
  await expect(page.locator(".target-result")).toContainText("/km");
  await page.getByRole("button", { name: "Appliquer" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Allure réglée" })).toBeVisible();
  await expect(page.locator(".hero .mid")).toHaveText("30 min");
  // Weight drives calories
  const kcal = await page.locator(".bag div").nth(2).locator("b").innerText();
  await page.locator(".inline-field input").fill("90");
  await expect(page.locator(".bag div").nth(2).locator("b")).not.toHaveText(kcal);
  expect(fakes.errors).toEqual([]);
});

test("planifier : départ trop lointain pour la météo", async ({ page }) => {
  await openWithRoute(page);
  await page.getByRole("button", { name: "Planifier" }).click();
  await page.locator("input[type=datetime-local]").fill("2030-06-01T08:00");
  await expect(page.getByText("Prévisions disponibles jusqu'à 15 jours")).toBeVisible();
});
