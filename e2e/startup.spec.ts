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

    test('shows loading feedback before the application starts and while local storage opens', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
      let releaseApplication!: () => void
      const applicationHeld = new Promise<void>(resolve => { releaseApplication = resolve })
      let releaseStyles!: () => void
      const stylesHeld = new Promise<void>(resolve => { releaseStyles = resolve })
      // Hold application styles too: module-only coverage can hide an unstyled HTML fallback
      await page.route('**/assets/*.css', async route => { await stylesHeld; await route.continue() })
      for (const pattern of ['**/assets/startup-recovery-*.js', '**/assets/index-*.js']) {
        await page.route(pattern, async route => { await applicationHeld; await route.continue() })
      }
      const releaseStorage = await holdWorkspaceSelection(page)
      try {
        await page.goto('/#/builds', { waitUntil: 'commit' })
        const loading = loadingScreen(page)
        await expect(loading).toBeVisible()
        await expect(loading.getByRole('status')).toHaveText('Loading application files...')
        await expect(loading).toHaveCSS('display', 'grid')
        await expect(loading).toHaveCSS('background-color', 'rgb(23, 29, 34)')
        await expect(loading.locator('.loading-screen__crystal svg')).toBeVisible()
        const before = await loading.locator('.loading-screen__content').boundingBox()
        const viewport = page.viewportSize()!
        expect(Math.abs(before!.x + before!.width / 2 - viewport.width / 2)).toBeLessThan(2)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        // Screenshots wait for font readiness, which pending stylesheets deliberately hold open
        // Assert the critical layout first, then allow CSS to finish while the application stays held
        releaseStyles()
        await page.screenshot({ path: testInfo.outputPath('branded-html-loading.png') })

        await expectLoadingMotion(loading, reducedMotion === 'reduce')
        releaseApplication()
        // Released downloads still need to finish before asserting the module-rendered storage phase
        await page.waitForLoadState('domcontentloaded')
        await expect(loading.getByRole('status')).toHaveText('Opening saved workspace...')
        await expect(loading.locator('.loading-screen__crystal svg')).toBeVisible()
        await expect(loading).toHaveCSS('background-color', 'rgb(23, 29, 34)')
        await page.screenshot({ path: testInfo.outputPath('branded-workspace-loading.png') })
        await expectLoadingMotion(loading, reducedMotion === 'reduce')
        await releaseStorage()
        await waitForPlannerReady(page)
        await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
        await expect(loading).toHaveCount(0)
      } finally {
        releaseStyles()
        releaseApplication()
        await releaseStorage()
      }
    })
  })
}
