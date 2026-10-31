import { defineConfig } from '@playwright/test'
import acceptance from './playwright.acceptance.config'

// Independent backends permit overlap inside this exclusive phase; keep the hosted budget separate
const SAVE_PERFORMANCE_WORKERS = process.env.CI ? 1 : 4

export default defineConfig({
  ...acceptance,
  workers: SAVE_PERFORMANCE_WORKERS,
  projects: acceptance.projects!.filter(project => project.name === 'local-saves').map(project => ({ ...project, workers: SAVE_PERFORMANCE_WORKERS })),
  // The later account phase must not remove save receipts or overwrite their report
  outputDir: '.account-tests/save-performance-artifacts',
  reporter: [['list'], ['json', { outputFile: '.account-tests/save-performance-results.json' }]],
})
