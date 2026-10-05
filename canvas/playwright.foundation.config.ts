import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";

// Test-only credentials are shared with the child launcher and test workers.
process.env.FOUNDATION_E2E_SESSION_API_KEY ??= randomBytes(24).toString("hex");
const port = process.env.FOUNDATION_E2E_FRONTEND_PORT ?? "19301";

export default defineConfig({
  testDir: "./tests/e2e/agent-foundation",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  outputDir: "test-results-foundation",
  reporter: [
    ["line"],
    ["html", { outputFolder: "playwright-report-foundation", open: "never" }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/e2e/agent-foundation/scripts/start-stack.mjs",
    url: `http://127.0.0.1:${port}`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
