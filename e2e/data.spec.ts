import { readFileSync } from "node:fs";
import { draft, expect, openEmpty, openWithRoute, shownDistance, test } from "./fixtures";

const GPX = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="45.931" lon="6.871"><name>Refuge du test</name></wpt>
<trk><name>Trace importée</name><trkseg>
${Array.from({ length: 200 }, (_, i) => `<trkpt lat="${(45.92 + i * 0.0001).toFixed(5)}" lon="${(6.86 + Math.sin(i / 20) * 0.002).toFixed(5)}"><ele>${1000 + i}</ele></trkpt>`).join("")}
</trkseg></trk></gpx>`;

test("exporter un GPX lisible avec altitudes", async ({ page }) => {
  await openWithRoute(page);
  await expect(page.locator(".stat.up b")).not.toHaveText("0 m");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exporter le GPX" }).click()]);
  expect(dl.suggestedFilename()).toBe("parcours-test.gpx");
  const xml = readFileSync((await dl.path())!, "utf8");
  expect(xml).toContain("<name>Parcours test</name>");
  expect(xml.match(/<trkpt/g)!.length).toBeGreaterThanOrEqual(4);
  expect(xml).toMatch(/<ele>\d+\.\d<\/ele>/);
  // Ctrl+E does the same
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+e")]);
  expect(dl2.suggestedFilename()).toMatch(/\.gpx$/);
});

test("exporter avec horaires pour le partenaire virtuel", async ({ page }) => {
  await openWithRoute(page);
  await page.getByText("Inclure les horaires estimés").click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exporter le GPX" }).click()]);
  const xml = readFileSync((await dl.path())!, "utf8");
  expect(xml.match(/<time>/g)!.length).toBeGreaterThan(4);
});

test("importer un GPX par le bouton et par glisser-déposer", async ({ page, fakes }) => {
  await openEmpty(page);
  await page.getByRole("button", { name: /Parcours/ }).last().click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Importer GPX" }).click()]);
  await chooser.setFiles({ name: "trace.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(GPX) });
  await expect(page.locator(".toast").filter({ hasText: "Trace importée" })).toBeVisible();
  await expect(page.locator(".title-input")).toHaveValue("Trace importée");
  const d = await draft(page);
  expect(d.waypoints.length).toBeGreaterThan(2);
  expect(d.waypoints.length).toBeLessThan(200);
  expect(d.pois[0].name).toBe("Refuge du test");
  expect(await shownDistance(page)).toBeGreaterThan(1500);

  // Drop a broken file: clear message, nothing lost
  const dt = await page.evaluateHandle(() => {
    const t = new DataTransfer();
    t.items.add(new File(["<gpx><oops"], "casse.gpx", { type: "application/gpx+xml" }));
    return t;
  });
  await page.dispatchEvent("body", "dragenter", { dataTransfer: dt });
  await expect(page.locator(".drop-zone")).toBeVisible();
  await page.dispatchEvent("body", "drop", { dataTransfer: dt });
  await expect(page.locator(".toast.error")).toContainText(/invalide|Aucune trace/);
  expect((await draft(page)).waypoints.length).toBe(d.waypoints.length);
  expect(fakes.reports.some((r) => r.source === "import")).toBe(true);
});

test("lien de partage : copié puis ouvert ailleurs", async ({ page, context, browser }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openWithRoute(page);
  await page.getByRole("button", { name: "Lien" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Lien copié" })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/app\.html#r=/);
  const other = await browser.newPage();
  await other.route(/tile\.|cartocdn|arcgis|geopf|terrarium|brouter|routing\./, (r) => r.abort());
  await other.goto(link);
  await expect(other.locator(".toast").filter({ hasText: "Parcours partagé chargé" })).toBeVisible();
  await expect(other.locator(".title-input")).toHaveValue("Parcours test");
  expect(other.url()).not.toContain("#r=");
  await other.close();
});

test("un lien de partage abîmé ouvre l'app normalement", async ({ page, fakes }) => {
  await page.goto("/app.html#r=Y2Fzc8OpCg");
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator(".hint")).toBeVisible();
  expect(fakes.errors).toEqual([]);
});

test("enregistrer, recharger, rouvrir, supprimer", async ({ page }) => {
  await openWithRoute(page);
  await page.locator(".title-input").fill("Ma boucle du dimanche");
  await page.keyboard.press("Escape");
  await page.locator(".title-input").blur();
  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast").filter({ hasText: "enregistré" })).toBeVisible();
  await page.reload();
  // The draft comes back after a reload
  await expect(page.locator(".title-input")).toHaveValue("Ma boucle du dimanche");
  await page.getByRole("button", { name: "Nouveau parcours" }).click();
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(0);
  await page.getByRole("button", { name: /Parcours/ }).last().click();
  const item = page.locator(".library li").filter({ hasText: "Ma boucle du dimanche" });
  await expect(item).toBeVisible();
  await item.click();
  await expect.poll(async () => (await draft(page)).waypoints.length).toBe(4);
  await page.getByRole("button", { name: /Parcours/ }).last().click();
  await item.getByTitle("Supprimer").click();
  await expect(page.locator(".library li")).toHaveCount(0);
});

test("des données locales corrompues ne cassent pas l'app", async ({ page, fakes }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gpx-studio:draft", JSON.stringify({ waypoints: [{ lat: "x" }, { lat: 45.92, lng: 6.86 }, null], pois: [{ type: "?" }] }));
    localStorage.setItem("gpx-studio:prefs", "{pas du json");
    localStorage.setItem("gpx-studio:library", JSON.stringify([{ id: 1 }, "x"]));
    localStorage.setItem("gpx-studio:community", "corrompu");
    localStorage.setItem("gpx-studio:weather-cache", "[1,2");
  });
  await page.goto("/app.html");
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator(".wp-start")).toHaveCount(1);
  expect(fakes.errors).toEqual([]);
});

test("changer de fond de carte et le garder", async ({ page }) => {
  await openWithRoute(page);
  await page.getByTitle("Fonds de carte").click();
  await page.locator(".layer-opt").filter({ hasText: "Satellite" }).click();
  await expect(page.locator(".map")).toHaveAttribute("data-layer", "satellite");
  await page.getByText("Colorer le tracé selon la pente").click();
  await expect(page.locator(".map")).toHaveClass(/slope-mode/);
  await page.reload();
  await expect(page.locator(".map")).toHaveAttribute("data-layer", "satellite");
});

test("image de partage", async ({ page }) => {
  await openWithRoute(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Image" }).click()]);
  expect(dl.suggestedFilename()).toBe("parcours-test.png");
  const buf = readFileSync((await dl.path())!);
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  expect(buf.length).toBeGreaterThan(20000);
});

test("exporter pour Garmin (TCX)", async ({ page }) => {
  await openWithRoute(page);
  await page.locator(".chips button").filter({ hasText: "Garmin" }).click();
  await expect(page.getByRole("button", { name: "Exporter pour Garmin" })).toBeVisible();
  await expect(page.getByText("Options de parcours")).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exporter pour Garmin" }).click()]);
  expect(dl.suggestedFilename()).toBe("parcours-test.tcx");
  const xml = readFileSync((await dl.path())!, "utf8");
  expect(xml).toContain("<TrainingCenterDatabase");
  expect(xml).toContain("<Name>Parcours test</Name>");
  expect(xml.match(/<Trackpoint>/g)!.length).toBeGreaterThanOrEqual(4);
  expect(xml).toMatch(/<DistanceMeters>2\d{3}\.\d<\/DistanceMeters>/);
  // The choice is remembered
  await page.reload();
  await expect(page.getByRole("button", { name: "Exporter pour Garmin" })).toBeVisible();
});
