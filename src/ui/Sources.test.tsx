// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dropdown } from './Dropdown'
import { Sources } from './Sources'

let container: HTMLDivElement
let root: Root
const prototypeMethods = ['showPopover', 'hidePopover', 'scrollIntoView'] as const
let originalMethods: PropertyDescriptor[]

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const open = new WeakSet<HTMLElement>()
  originalMethods = prototypeMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!)
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

function button(label: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
}

function ParentDropdown() {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const focusRef = useRef<HTMLDivElement>(null)
  return <><button aria-label="Open parent" onClick={() => setOpen(true)} ref={anchorRef}>Open parent</button><Dropdown anchorRef={anchorRef} id="parent" initialFocusRef={focusRef} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} open={open} title="Parent"><div ref={focusRef} tabIndex={-1}><Sources><p>Nested evidence</p></Sources></div></Dropdown></>
}

describe('Sources disclosure', () => {
  it('opens with named focus, inlines nested disclosures, and restores focus on close', async () => {
    await act(async () => root.render(<Sources label="Sources for synthetic item"><Sources label="Original claim"><p>Preserved synthetic evidence</p></Sources><Sources><p>Additional evidence</p></Sources></Sources>))
    const trigger = button('Sources for synthetic item')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => trigger.click())
    const popup = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(popup.getAttribute('aria-label')).toBe('Sources for synthetic item')
    expect(document.activeElement).toBe(popup.querySelector('h3'))
    expect(popup.querySelectorAll('.sources-trigger')).toHaveLength(0)
    expect(popup.querySelector('h4')?.textContent).toBe('Original claim')
    expect(popup.textContent).toContain('Preserved synthetic evidence')
    expect(popup.textContent).toContain('Additional evidence')
    await act(async () => button('Close sources').click())
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the source popup before a containing dropdown on Escape', async () => {
    await act(async () => root.render(<ParentDropdown/>))
    await act(async () => button('Open parent').click())
    await act(async () => button('Sources').click())
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="dialog"][aria-label="Sources"]')).toBeNull()
    expect(container.querySelector('[role="dialog"][aria-label="Parent"]')).not.toBeNull()
    expect(document.activeElement).toBe(button('Sources'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    expect(document.activeElement).toBe(button('Open parent'))
  })

  it('handles Escape before the opening frame without closing its parent or reopening later', async () => {
    await act(async () => root.render(<ParentDropdown/>))
    await act(async () => button('Open parent').click())
    const pending = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const frame = nextFrame++
      pending.set(frame, callback)
      return frame
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(frame => { pending.delete(frame) })
    const flushFrames = () => {
      const frames = [...pending.values()]
      pending.clear()
      for (const callback of frames) callback(performance.now())
    }
    await act(async () => button('Sources').click())
    const child = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Sources"]')!
    expect(pending.size).toBe(1)
    expect(child.matches(':popover-open')).toBe(false)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(container.querySelector('[role="dialog"][aria-label="Parent"]')).not.toBeNull()
    expect(container.querySelector('[role="dialog"][aria-label="Sources"]')).toBeNull()
    expect(cancel).toHaveBeenCalledWith(1)
    expect(pending.size).toBe(0)
    await act(async () => flushFrames())
    expect(child.matches(':popover-open')).toBe(false)

    await act(async () => button('Sources').click())
    await act(async () => flushFrames())
    expect(container.querySelector<HTMLElement>('[role="dialog"][aria-label="Sources"]')!.matches(':popover-open')).toBe(true)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(container.querySelector('[role="dialog"][aria-label="Sources"]')).toBeNull()
    expect(container.querySelector('[role="dialog"][aria-label="Parent"]')).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0)
  })

  it('keeps structured anchors visible and preserves nested anchors without extra triggers', async () => {
    await act(async () => root.render(<Sources anchor={<dl><dt>Synthetic field</dt><dd>Synthetic value</dd></dl>} label="Sources for synthetic field"><Sources anchor={<p>Nested annotated text</p>} label="Nested evidence"><p>Original attribution</p></Sources></Sources>))
    const trigger = button('Sources for synthetic field')
    const group = trigger.closest('.sources-attached')!
    expect(group.querySelector(':scope > .sources-anchor > dl')?.textContent).toBe('Synthetic fieldSynthetic value')
    await act(async () => trigger.click())
    const popup = container.querySelector('[role="dialog"]')!
    expect(popup.textContent).toContain('Nested annotated text')
    expect(popup.textContent).toContain('Original attribution')
    expect(popup.querySelectorAll('.sources-trigger')).toHaveLength(0)
    expect(container.querySelectorAll('p div, p dl, p table')).toHaveLength(0)
  })
})
