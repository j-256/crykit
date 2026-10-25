import { expect, test, type Page } from '@playwright/test'
import { readManagedGuestWorkspace } from './guest-planner-reader'
import { skipInitialModSetup, waitForPlannerReady } from './local-data-helpers'

const COORDINATOR_NAME = 'crykit-guest-coordinator-v1'
interface StoredChunk { revisionId: string; index: number; bytes: Uint8Array }

async function corruptReferencedChunk(page: Page): Promise<StoredChunk> {
  return page.evaluate(name => new Promise<StoredChunk>((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction(['active', 'managedRecords', 'managedChunks'], 'readwrite')
      let original: StoredChunk | undefined, failure: Error | undefined
      const fail = () => { failure = new Error('The synthetic guest has no referenced chunk'); transaction.abort() }
      const active = transaction.objectStore('active').get('active')
      active.onsuccess = () => {
        const root = active.result?.manifest?.root
        if (!root) { fail(); return }
        const record = transaction.objectStore('managedRecords').get(root.revisionId)
        record.onsuccess = () => {
          const reference = record.result?.dependencies?.[0]
          if (!reference) { fail(); return }
          const chunk = transaction.objectStore('managedChunks').get([reference.revisionId, 0])
          chunk.onsuccess = () => {
            original = chunk.result
            if (!original?.bytes.length) { fail(); return }
            const bytes = original.bytes.slice()
            bytes[0] = bytes[0]! ^ 1
            transaction.objectStore('managedChunks').put({ ...original, bytes })
          }
        }
      }
      transaction.oncomplete = () => { database.close(); original ? resolve(original) : reject(new Error('The synthetic guest chunk was not captured')) }
      transaction.onabort = () => { database.close(); reject(failure ?? transaction.error) }
    }
  }), COORDINATOR_NAME)
}

async function restoreChunk(page: Page, chunk: StoredChunk): Promise<void> {
  await page.evaluate(({ name, chunk }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result, transaction = database.transaction('managedChunks', 'readwrite')
      transaction.objectStore('managedChunks').put(chunk)
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }), { name: COORDINATOR_NAME, chunk })
}

test('guest inspection rereads native bytes and rejects a head changed during its admission', async ({ page }) => {
  await page.goto('/#/builds/library')
  await waitForPlannerReady(page)
  await skipInitialModSetup(page)
  const before = (await readManagedGuestWorkspace(page))!
  const chunk = await corruptReferencedChunk(page)
  try { await expect(readManagedGuestWorkspace(page)).rejects.toThrow(/digest/i) }
  finally { await restoreChunk(page, chunk) }
  expect((await readManagedGuestWorkspace(page))!.planner.localData).toEqual(before.planner.localData)

  const title = 'Synthetic inspection successor'
  await expect(readManagedGuestWorkspace(page, async () => {
    await page.getByRole('button', { name: 'New Build', exact: true }).click()
    await page.getByRole('textbox', { name: 'Build title', exact: true }).fill(title)
    await page.getByRole('button', { name: 'Save build', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  })).rejects.toThrow('The selected guest changed during inspection')
  const after = (await readManagedGuestWorkspace(page))!
  expect(Object.values(after.planner.localData.builds).some(build => build.title === title)).toBe(true)
  for (const [id, build] of Object.entries(before.planner.localData.builds)) expect(after.planner.localData.builds[id]).toEqual(build)
})
