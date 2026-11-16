// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { ReferenceDescription } from './ReferenceDescription'

let container: HTMLDivElement
let root: Root
const prototypeMethods = ['showPopover', 'hidePopover', 'scrollIntoView'] as const
let originalMethods: (PropertyDescriptor | undefined)[]

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const open = new WeakSet<HTMLElement>()
  originalMethods = prototypeMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: function (this: HTMLElement) { open.add(this) } },
    hidePopover: { configurable: true, value: function (this: HTMLElement) { open.delete(this) } },
    scrollIntoView: { configurable: true, value: vi.fn() },
  })
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) { return selector === ':popover-open' ? open.has(this) : matches.call(this, selector) })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(performance.now()); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [index, name] of prototypeMethods.entries()) {
    const descriptor = originalMethods[index]
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})

it('keeps the effect concise and opens its original field attribution and license from Sources', async () => {
  const shard = CURRENT_CATALOG.entities['base:item:22']!
  await act(async () => root.render(<ReferenceDescription catalog={CURRENT_CATALOG} entity={shard} hideGeneratedSummary/>))
  expect(container.textContent).toContain('teleports the party to the roof of the Gaea Shrine')
  expect(container.textContent).not.toMatch(/CC-BY-SA|reviewed native|assumption|Applicability/)
  expect(container.textContent?.match(/teleports the party/g)).toHaveLength(1)
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Sources for Description"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.click())
  const popup = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Sources for Description"]')!
  expect(popup.querySelector('a[href="https://crystal-project.fandom.com/wiki/Gaea_Shard?oldid=7599"]')).not.toBeNull()
  expect(popup.textContent).toContain('Gaea Shard')
  expect(popup.textContent).toContain('revision 7599')
  expect(popup.textContent).toContain('Crystal Project Wiki contributors')
  expect(popup.textContent).toContain('CC-BY-SA')
  expect(popup.querySelector('a[href="https://www.fandom.com/licensing"]')).not.toBeNull()
})
