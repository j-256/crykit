import { expect, type Page } from '@playwright/test'

export const ACCOUNT_PREPARATION_TIMEOUT_MS = 60_000

// User journeys wait for the real automatic continuation and explicitly leave meaningful guest work local
export async function finishAccountSignin(page: Page) {
  const choices = page.getByRole('heading', { name: 'Choose what to keep', exact: true })
  const ready = page.getByRole('complementary', { name: 'Account sync' })
  const acknowledgment = page.getByRole('button', { name: 'I have saved my security information. Continue', exact: true })
  await expect(choices.or(ready).or(acknowledgment)).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  if (await acknowledgment.isVisible()) { await acknowledgment.click(); await expect(choices.or(ready)).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }) }
  if (await choices.isVisible()) {
    await page.getByRole('button', { name: 'Use account data on this device', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm use account data', exact: true }).click()
  }
  await expect(ready).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
}

// These synthetic fixture paths need an authenticated key before initial account admission
// They preserve remember-device choice and mount the actual provider only after exact fixture creation
export async function beginSeededAccount(page: Page, app: string, email: string, password: string, remember = false) {
  const path = app.split('#')[0]
  await page.goto(`${path}?fixture-setup=1#/settings/account`)
  await page.waitForFunction(() => !!(window as any).accountBootstrapProof)
  await page.evaluate(input => (window as any).accountBootstrapProof.signIn(input), { email, password, remember })
}
export async function mountSeededAccount(page: Page) {
  await page.evaluate(() => (window as any).accountBootstrapProof.mount())
  await expect(page.getByRole('complementary', { name: 'Account sync' })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
}
