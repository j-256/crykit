import type { Page } from '@playwright/test'

// Keep dirty navigation deterministic without racing the ordinary quiet-save delay
export async function blockGuestSavePublication(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    const blocked: typeof put = function (this: IDBObjectStore, ...args) {
      if (this.name === 'active' && this.transaction.db.name === 'crykit-guest-coordinator-v1') throw new DOMException('Synthetic save publication failure', 'QuotaExceededError')
      return put.apply(this, args)
    }
    IDBObjectStore.prototype.put = blocked
    ;(window as unknown as { restoreSaveWrites(): void }).restoreSaveWrites = () => {
      if (IDBObjectStore.prototype.put === blocked) IDBObjectStore.prototype.put = put
    }
  })
  return () => page.evaluate(() => (window as unknown as { restoreSaveWrites(): void }).restoreSaveWrites())
}
