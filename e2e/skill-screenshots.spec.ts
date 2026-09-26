import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { screenshotTestProfile, CHARACTER } from '../src/domain/skill-trees.test-helpers'
import { TEST_NOW } from '../src/domain/test-helpers'
import type { Profile } from '../src/domain/types'

async function dataPanel(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function loadFixture(page: Page) {
  await page.goto('/')
  const profile = { ...screenshotTestProfile(), changes: [] }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({ 'manifest.json': encode({ format: 'crystal-companion-backup', formatVersion: '1.0.0', exportedAt: TEST_NOW, payload: 'bundle.json', sources: [] }), 'bundle.json': encode({ profile, lineage: { rootProfileId: profile.id }, catalogs: [], evidence: [], history: [] }) })
  const panel = await dataPanel(page)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-learning.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await expect(panel.getByText('native-backup-1.0.0', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await page.goto(`/#/characters/${CHARACTER}/knowledge`)
  return profile
}

async function syntheticScreenshot(page: Page, menu = 'Learn', name = 'Rowan'): Promise<Buffer> {
  const url = await page.evaluate(({ menu, name }) => {
    const image = document.createElement('canvas')
    image.width = 1280; image.height = 720
    const ctx = image.getContext('2d')!
    ctx.fillStyle = '#1f252b'; ctx.fillRect(0, 0, 1280, 720)
    ctx.fillStyle = '#fafafa'; ctx.font = '20px Arial'
    ctx.fillText(menu, 134, 110); ctx.fillText(name, 490, 60); ctx.fillText('Practice class', 305, 229)
    ctx.fillRect(624, 211, 1, 18)
    for (const [row, column, color] of [[0, 0, '#c0bb28'], [0, 1, '#2096d4'], [1, 0, '#425059'], [1, 1, '#c0bb28']] as const) {
      const x = 670 + column * 64; const y = 222 + row * 64
      ctx.fillStyle = color
      ctx.fillRect(x, y, 40, 1); ctx.fillRect(x, y, 1, 40); ctx.fillRect(x + 39, y, 1, 40); ctx.fillRect(x, y + 39, 40, 1)
    }
    ctx.fillStyle = '#2096d4'; ctx.fillRect(734, 293, 1, 24)
    return image.toDataURL('image/png')
  }, { menu, name })
  return Buffer.from(url.split(',')[1], 'base64')
}

async function openImport(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByRole('button', { name: 'Import skill screenshots', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import skill screenshots', exact: true })
  await dialog.getByLabel('Skill screenshots', { exact: true }).setInputFiles(files)
  await expect(dialog.getByLabel('Screenshot to review', { exact: true })).toBeVisible()
  return dialog
}

function withPngMetadata(png: Buffer): Buffer {
  const payload = Buffer.from('Comment\0Synthetic metadata')
  const content = Buffer.concat([Buffer.from('tEXt'), payload])
  let crc = 0xffffffff
  const polynomial = 0xedb88320
  for (const byte of content) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ polynomial : crc >>> 1
  }
  const chunk = Buffer.alloc(payload.length + 12)
  chunk.writeUInt32BE(payload.length)
  content.copy(chunk, 4)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
}

async function mapSquares(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Import skill screenshots', exact: true })
  await dialog.getByLabel('Screenshot character', { exact: true }).selectOption({ label: 'Rowan' })
  await dialog.getByLabel('Screenshot class', { exact: true }).selectOption({ label: 'Practice class' })
  await dialog.getByLabel('Show definitions from all classes', { exact: true }).check()
  for (const [index, label] of ['Practice skill', 'Second skill', 'Third skill'].entries()) {
    await dialog.getByRole('button', { name: new RegExp(`^Square ${index + 1},`) }).click()
    await dialog.getByLabel('Ability for selected square', { exact: true }).selectOption({ label: `${label} (ability)` })
  }
  await dialog.getByLabel('I reviewed this character, class, square states, and assigned names', { exact: true }).check()
}

async function exportProfile(page: Page): Promise<Profile> {
  const panel = await dataPanel(page)
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const path = await (await download).path()
  const payload = JSON.parse(strFromU8(unzipSync(await readFile(path!))['bundle.json'])) as { profile: Profile }
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return payload.profile
}

test('screenshots compile reviewed names offline, skip duplicates, and preserve unknowns', async ({ page, context }) => {
  const original = await loadFixture(page)
  const pixels = await syntheticScreenshot(page)
  const wrong = await syntheticScreenshot(page, 'Equip')
  const panel = await dataPanel(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expect(panel.getByText('Offline ready', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  const outside: string[] = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:') && !request.url().startsWith('blob:')) outside.push(request.url()) })
  const dialog = await openImport(page, [{ name: 'synthetic-tree.png', mimeType: 'image/png', buffer: pixels }, { name: 'copy.png', mimeType: 'image/png', buffer: withPngMetadata(pixels) }, { name: 'equipment.png', mimeType: 'image/png', buffer: wrong }])
  await expect(dialog).toContainText('1 included · 1 duplicates skipped · 1 unreadable')
  await expect(dialog.getByRole('button', { name: 'Save reviewed screenshots', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Square 1, row 1, column 1: Learned', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Square 2, row 1, column 2: Available, not learned', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Square 4, row 2, column 2: Unknown', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog.getByText('Unsaved screenshot review', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await mapSquares(page)
  await dialog.getByRole('button', { name: 'Save reviewed screenshots', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.reload()
  await expect(page.getByText('Practice class screenshot', { exact: true })).toBeVisible()
  const saved = await exportProfile(page)
  const nodes = Object.values(saved.characters[CHARACTER].learnedNodes)
  expect(nodes.map(node => node.learned.state === 'known' ? node.learned.value : null)).toEqual([true, false, false])
  expect(nodes.every(node => node.actualPaidLp.state === 'unknown')).toBe(true)
  expect(saved.characters[CHARACTER].classProgress).toEqual({})
  expect(saved.characters[CHARACTER].snapshots).toEqual(original.characters[CHARACTER].snapshots)
  expect(saved.progress).toEqual(original.progress)
  expect(Object.values(saved.skillTreeCaptures!)[0].squares[3].state).toBe('unknown')
  expect(outside).toEqual([])
  const repeated = await openImport(page, [{ name: 'same-tree.png', mimeType: 'image/png', buffer: pixels }])
  await expect(repeated.locator('.skill-compiled-list')).toContainText('Practice skill')
  await expect(repeated.locator('.skill-compiled-list')).toContainText('Third skill')
  await repeated.getByRole('button', { name: 'Cancel and discard', exact: true }).click()
  await context.setOffline(false)
})

test('failed screenshot writes retain review and recover through Retry save', async ({ page }) => {
  await loadFixture(page)
  const pixels = await syntheticScreenshot(page)
  const dialog = await openImport(page, [{ name: 'synthetic-tree.png', mimeType: 'image/png', buffer: pixels }])
  await mapSquares(page)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'profiles') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic storage failure', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await dialog.getByRole('button', { name: 'Save reviewed screenshots', exact: true }).click()
  await expect(dialog.getByText('Screenshot import not saved', { exact: true })).toBeVisible()
  await expect(dialog.locator('.skill-compiled-list')).toContainText('Practice skill')
  await dialog.getByRole('button', { name: 'Close review', exact: true }).click()
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  const saved = await exportProfile(page)
  expect(Object.values(saved.characters[CHARACTER].learnedNodes)).toHaveLength(3)
  expect(Object.values(saved.skillTreeCaptures!)).toHaveLength(1)
})
