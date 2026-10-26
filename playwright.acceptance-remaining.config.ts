import { defineConfig } from '@playwright/test'
import acceptance from './playwright.acceptance.config'

export default defineConfig({
  ...acceptance,
  // Publication runs this project's complete coverage in the earlier exclusive phase
  projects: acceptance.projects!.filter(project => project.name !== 'local-saves'),
})
