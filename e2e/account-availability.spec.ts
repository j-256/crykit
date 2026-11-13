import { expect, test } from '@playwright/test'
import { formatAppRoute } from '../src/ui/navigation/routes'
import { MOBILE_TEST_TAG } from './test-tags'

const accountRoute = formatAppRoute({ page: { page: 'settings', section: 'account' }, overlays: [], query: {} })
const readiness = (accountsAvailable: boolean, signupAvailable = accountsAvailable) => ({ version: 1, accountsAvailable, signupAvailable, supportedWireVersions: [1] })

test(`closed accounts hide online forms and preserve local continuation ${MOBILE_TEST_TAG}`, async ({ page }) => {
  await page.route('**/api/v1/service', route => route.fulfill({ json: readiness(false) }))
  await page.goto(`/${accountRoute}`)
  await expect(page.getByText('Online accounts are unavailable.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Request approval', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Use recovery code', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Privacy, upload, and recovery terms (opens in a new tab)' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue using this device' }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toHaveCount(0)
})

test(`account availability failures keep forms closed and allow a live recheck ${MOBILE_TEST_TAG}`, async ({ page }) => {
  let available = false
  await page.route('**/api/v1/service', route => available ? route.fulfill({ json: readiness(true) }) : route.abort('failed'))
  await page.goto(`/${accountRoute}`)
  await expect(page.getByText('Account availability could not be checked.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
  available = true
  await page.getByRole('button', { name: 'Check account availability' }).click()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Public screen name', exact: true })).toBeVisible()
})

test(`paused registration retains sign-in for existing accounts ${MOBILE_TEST_TAG}`, async ({ page }) => {
  await page.route('**/api/v1/service', route => route.fulfill({ json: readiness(true, false) }))
  await page.goto(`/${accountRoute}`)
  await expect(page.getByText('New account registration is unavailable.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0)
})
