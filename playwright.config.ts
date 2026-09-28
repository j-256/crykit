import { defineConfig, devices } from '@playwright/test'

const e2ePort = process.env.CRYSTAL_COMPANION_E2E_PORT ?? '4173'
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`
const END_TO_END_TEST_TIMEOUT_MS = 60_000
const CI_END_TO_END_WORKERS = 1
const LOCAL_END_TO_END_WORKERS = '25%'

export default defineConfig({
  testDir: './e2e',
  timeout: END_TO_END_TEST_TIMEOUT_MS,
  fullyParallel: false,
  workers: process.env.CI ? CI_END_TO_END_WORKERS : LOCAL_END_TO_END_WORKERS,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: e2eBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npm run preview -- --port ${e2ePort} --strictPort`,
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
