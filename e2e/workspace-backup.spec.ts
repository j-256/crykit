import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { readCompleteBackup } from './workspace-backup'
import { waitForPlannerReady } from './local-data-helpers'

test('completeGuestBackupDownloadsValidatedSavedWorkspace', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  await page.goto('/')
  await waitForPlannerReady(page)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const pending = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('crykit-workspace.crykit')
  const state = await readCompleteBackup(await readFile((await download.path())!))
  expect(Object.keys(state.planner.localData.builds).length).toBeGreaterThan(0)
  expect(state.planner.catalogs.length).toBeGreaterThan(0)
  expect(state.editorDocuments).toEqual([])
  expect(state.saveDocuments).toEqual([])
  await expect(panel.getByRole('button', { name: 'Export backup', exact: true })).toBeEnabled()
})
