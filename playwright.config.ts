import { defineConfig, devices } from "@playwright/test";

// End-to-end tests. Every outside service (map tiles, routing, elevation,
// weather, OpenStreetMap…) is replaced by a local fake in e2e/fixtures.ts,
// so the tests are fast and never depend on a public server being up.
export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "retain-on-failure",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec/ },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
      testMatch: /mobile\.spec/,
    },
  ],
  webServer: {
    command: "npx vite --port 5199 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5199/app.html",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
