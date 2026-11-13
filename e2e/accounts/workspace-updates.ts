import { expect, type Page } from '@playwright/test'

// Remote publication never grants old callbacks authority over the newly selected root
// Exercise the same explicit admission as the user before inspecting or editing pulled content
export async function loadAccountUpdate(page: Page) {
  await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText(/^(Synced|Conflicting versions)$/)
  // One accepted publication can leave a continuation queued, which still owns a later head activation
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as { accountBootstrapProof: { accountStorage(): Promise<{ pending: unknown[] }> } }).accountBootstrapProof.accountStorage()).pending.length)).toBe(0)
  const load = page.getByRole('button', { name: 'Load updated data', exact: true })
  await load.click()
  await expect(load).toHaveCount(0)
}
