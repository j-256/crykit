import { expect, type Locator } from '@playwright/test'

const OFFLINE_PREPARATION_TIMEOUT_MS = 30_000

export async function expectOfflineReady(settings: Locator): Promise<void> {
  await expect(settings.getByText('Offline ready', { exact: true })).toBeVisible({ timeout: OFFLINE_PREPARATION_TIMEOUT_MS })
}
