import { readFile } from 'node:fs/promises'
import { expect, type Page, type TestInfo } from './test-fixture'

// Native storage, backup downloads and device removal remain real browser assertions
// Compose them after an already verified cloud drain instead of preparing the workspace again
export async function assertAccountStorageRecovery(page: Page, testInfo: TestInfo): Promise<void> {
  const storage = page.getByRole('region', { name: 'Storage and recovery' })
  await storage.getByRole('button', { name: 'Refresh storage', exact: true }).focus()
  await page.keyboard.press('Enter')
  await storage.getByRole('button', { name: 'Find unused sync data', exact: true }).click()
  await expect(storage.getByText(/^Cloud usage:/)).toBeVisible()
  await expect(storage.getByText(/^Local content:/)).toBeVisible()
  await expect(storage.getByText('No verified recovery point is known. Download a private backup.')).toBeVisible()
  await expect(storage.getByText(/Cleanup preserves source files, drafts and history/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await testInfo.attach('storage-recovery', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  const downloaded = page.waitForEvent('download')
  await storage.getByRole('button', { name: 'Account backup', exact: true }).click()
  const file = await downloaded
  expect((await readFile((await file.path())!)).byteLength).toBeGreaterThan(0)
  await storage.getByRole('button', { name: 'Remove saved account from this device', exact: true }).click()
  await expect(storage.getByRole('button', { name: 'Remove this device copy', exact: true })).toBeDisabled()
  await storage.getByRole('checkbox').check()
  await storage.getByRole('button', { name: 'Remove this device copy', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Account sync' })).toHaveCount(0)
  expect(await page.evaluate(async () => {
    const accounts = (await indexedDB.databases()).filter(value => value.name?.startsWith('crykit-account-v1-'))
    return Promise.all(accounts.map(value => new Promise<number>((resolve, reject) => { const open = indexedDB.open(value.name!); open.onerror = () => reject(open.error); open.onsuccess = () => { const database = open.result, count = database.transaction('profileMeta').objectStore('profileMeta').count(); count.onerror = () => reject(count.error); count.onsuccess = () => { database.close(); resolve(count.result) } } })))
  })).toEqual([0])
}
