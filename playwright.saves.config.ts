import { defineConfig } from '@playwright/test'
import acceptance from './playwright.acceptance.config'

export default defineConfig({
  ...acceptance,
  projects: acceptance.projects!.filter(project => project.name === 'local-saves'),
  // The later account phase must not remove save receipts or overwrite their report
  outputDir: '.account-tests/save-performance-artifacts',
  reporter: [['list'], ['json', { outputFile: '.account-tests/save-performance-results.json' }]],
})
