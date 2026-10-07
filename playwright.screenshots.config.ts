import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'

const directory = process.env.CRYKIT_UI_REVIEW_DIRECTORY
const baseURL = process.env.CRYKIT_UI_REVIEW_URL
if (!directory || !baseURL) throw new Error('Start visual capture with npm run screenshots')
const selected = (process.env.CRYKIT_UI_REVIEW_DEVICES ?? '').split(',')

export default defineConfig({
  testDir: './scripts', testMatch: 'ui-review.spec.ts', timeout: 60_000,
  workers: 1, fullyParallel: false, retries: 0, forbidOnly: true,
  reporter: [['list']], outputDir: join(directory, '.artifacts'),
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block', colorScheme: 'dark', reducedMotion: 'reduce' },
  projects: [
    ...(selected.includes('desktop') ? [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } }] : []),
    ...(selected.includes('mobile') ? [{ name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } }] : []),
  ],
})
