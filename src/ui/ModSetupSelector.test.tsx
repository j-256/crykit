// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SYNTHETIC_BUNDLED_MOD } from '../catalog/mod.test-helpers'
import type { CatalogId } from '../domain/types'
import { ModSetupSelector } from './ModSetupSelector'

let root: Root
let container: HTMLDivElement
const showModal = HTMLDialogElement.prototype.showModal
const close = HTMLDialogElement.prototype.close
const second = { ...SYNTHETIC_BUNDLED_MOD, id: 'crystal-edit:synthetic-second' as CatalogId, title: 'Synthetic Second' }
const library = [SYNTHETIC_BUNDLED_MOD, second]
const onApply = vi.fn<(ids: readonly CatalogId[]) => Promise<void>>()
const onClose = vi.fn()

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function() { this.removeAttribute('open') }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onApply.mockReset().mockResolvedValue(undefined); onClose.mockReset()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); HTMLDialogElement.prototype.showModal = showModal; HTMLDialogElement.prototype.close = close })
function button(name: string) { return [...document.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') ?? element.textContent) === name)! }
async function click(name: string) { await act(async () => button(name).click()) }
async function render(available = library) { await act(async () => root.render(<ModSetupSelector library={available} starterIds={[second.id, SYNTHETIC_BUNDLED_MOD.id]} onApply={onApply} onSkip={async () => {}} onClose={onClose}/>)) }

it('keeps hidden selections and applies their explicit priority with an available library', async () => {
  await render(); await click('Choose mods'); await click('Use starter selection')
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'no matching title'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(document.body.textContent).toContain('2 selected')
  expect(document.body.textContent).toContain('Your selections are kept while searching')
  await click('Move Synthetic Library earlier'); await click('Use selected mods')
  expect(onApply).toHaveBeenCalledExactlyOnceWith([SYNTHETIC_BUNDLED_MOD.id, second.id])
  expect(onClose).toHaveBeenCalledTimes(1)
})
it('preserves choices after a failed save and closes only after retry succeeds', async () => {
  await render(); await click('Choose mods'); await click('Use starter selection')
  onApply.mockRejectedValueOnce(new Error('Synthetic storage failure'))
  await click('Use selected mods')
  expect(document.body.textContent).toContain('Mod choices not saved')
  expect(document.body.textContent).toContain('2 selected'); expect(onClose).not.toHaveBeenCalled()
  await click('Use selected mods')
  expect(onApply.mock.calls).toEqual([[[second.id, SYNTHETIC_BUNDLED_MOD.id]], [[second.id, SYNTHETIC_BUNDLED_MOD.id]]])
  expect(onClose).toHaveBeenCalledTimes(1)
})
it('offers a usable base-game path when the supplied library is empty', async () => {
  await render([]); await click('Choose mods'); await click('Use starter selection')
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect(button('Use selected mods').disabled).toBe(true)
  expect(document.body.textContent).toContain('You can import mod JSON in Mods')
  await click('Continue without mods'); expect(onApply).toHaveBeenCalledExactlyOnceWith([])
})
