import { defineConfig, devices } from "@playwright/test";

// The extension spec loads extension/dist, so build first (npm run build); nothing else needs a server.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
