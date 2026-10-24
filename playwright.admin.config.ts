import { defineConfig, devices } from '@playwright/test'

delete process.env.NO_COLOR
export default defineConfig({
  testDir: './e2e/accounts', testMatch: ['admin-panel.spec.ts', 'admin-security.spec.ts'], workers: 1, fullyParallel: false, retries: 0,
  use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
