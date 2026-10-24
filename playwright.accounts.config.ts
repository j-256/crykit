import { defineConfig, devices } from '@playwright/test'

// Playwright forces color in child servers/workers, so inherited NO_COLOR would conflict
delete process.env.NO_COLOR

const port = process.env.CRYKIT_ACCOUNTS_PORT ?? '8787'
const https = process.env.CRYKIT_ACCOUNTS_HTTPS === '1'
const baseURL = `${https ? 'https' : 'http'}://127.0.0.1:${port}`
export default defineConfig({
  testDir: './e2e/accounts', fullyParallel: false, workers: 1, forbidOnly: true, retries: 0,
  use: { baseURL, ignoreHTTPSErrors: https, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: { command: `CRYKIT_ACCOUNTS_PORT=${port} npm run dev:accounts`, url: baseURL, ignoreHTTPSErrors: https, reuseExistingServer: process.env.CRYKIT_ACCOUNTS_REUSE_SERVER === '1', timeout: 120_000 },
})
