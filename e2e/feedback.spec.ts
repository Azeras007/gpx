import { draft, expect, openWithRoute, test } from "./fixtures";

test("donner son avis avec le parcours joint", async ({ page, fakes }) => {
  await openWithRoute(page);
  await page.getByTitle("Donner mon avis").click();
  const modal = page.locator(".modal.feedback");
  await expect(modal).toBeVisible();
  // Shortcuts are off while the dialog is open
  await page.keyboard.press("Backspace");
  expect((await draft(page)).waypoints).toHaveLength(4);
  const send = modal.getByRole("button", { name: "Envoyer" });
  await expect(send).toBeDisabled();
  await modal.getByRole("button", { name: "Un bug" }).click();
  await modal.locator("textarea").fill("L'export ne marche pas sur mon téléphone");
  await modal.getByTitle("4 sur 5").click();
  await modal.locator("input[type=email]").fill("pas-un-mail");
  await expect(send).toBeDisabled();
  await modal.locator("input[type=email]").fill("moi@exemple.fr");
  fakes.reportStatus = 503;
  await send.click();
  await expect(modal.locator(".alert")).toContainText("pas encore activé");
  fakes.reportStatus = 200;
  await send.click();
  await expect(modal.getByText("Merci, c'est bien reçu")).toBeVisible();
  const fb = fakes.reports.filter((r) => r.kind === "feedback").at(-1)!;
  expect(fb).toMatchObject({ category: "Bug", rating: 4, email: "moi@exemple.fr" });
  expect(String(fb.routeLink)).toContain("#r=");
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("les erreurs sont remontées une seule fois, avec le contexte", async ({ page, fakes }) => {
  await openWithRoute(page);
  await page.getByRole("button", { name: "Inverser" }).click();
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("boom e2e");
    });
    setTimeout(() => {
      throw new Error("boom e2e");
    });
    void Promise.reject(new Error("rejet e2e"));
  });
  await expect.poll(() => fakes.reports.filter((r) => String(r.message).includes("e2e")).length).toBe(2);
  const r = fakes.reports.find((x) => String(x.message).includes("boom"))!;
  expect(r.context).toMatchObject({ points: 4, activite: "run", onglet: "trace" });
  expect((r.breadcrumbs as string[]).some((b) => b.includes("Inverser"))).toBe(true);
});
