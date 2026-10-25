import { expect, test } from '@playwright/test'
import { waitForPlannerReady } from './local-data-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectLoadingMotion, holdWorkspaceSelection, loadingScreen } from './startup-helpers'

// Each storage hold keeps a real IndexedDB transaction alive with queued reads
// Run motion variants sequentially per browser so concurrent holders do not starve module startup
test.describe.configure({ mode: 'default' })

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test.describe(`startup with ${reducedMotion} motion`, () => {
    test.use({ reducedMotion })

    test('shows loading feedback before the application starts and while local storage opens', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
      let releaseApplication!: () => void
      const applicationHeld = new Promise<void>(resolve => { releaseApplication = resolve })
      // Both startup downloads must leave the HTML loading screen visible before React can render
      for (const pattern of ['**/assets/startup-recovery-*.js', '**/assets/index-*.js']) {
        await page.route(pattern, async route => { await applicationHeld; await route.continue() })
      }
      const releaseStorage = await holdWorkspaceSelection(page)
      try {
        await page.goto('/#/builds', { waitUntil: 'commit' })
        const loading = loadingScreen(page)
        await expect(loading).toBeVisible()
        await expect(loading.getByRole('status')).toHaveText('Loading application files...')

        await expectLoadingMotion(loading, reducedMotion === 'reduce')
        releaseApplication()
        await expect(loading.getByRole('status')).toHaveText('Opening saved workspace...')
        await expectLoadingMotion(loading, reducedMotion === 'reduce')
        await releaseStorage()
        await waitForPlannerReady(page)
        await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
        await expect(loading).toHaveCount(0)
      } finally {
        releaseApplication()
        await releaseStorage()
      }
    })
  })
}
