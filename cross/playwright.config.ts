// End-to-end tests of the shared app (the web build Windows, Android and iPhone wrap), against the Vite dev server.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [['list'], ['json', { outputFile: 'e2e/.out/results.json' }]],
  outputDir: 'e2e/.out/artifacts',
  use: { baseURL: 'http://localhost:5199', acceptDownloads: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
  ],
  webServer: { command: 'npm run dev -- --port 5199 --strictPort', url: 'http://localhost:5199', reuseExistingServer: true, timeout: 120_000 },
});
