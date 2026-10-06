// @vitest-environment jsdom
import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationNotice } from './useNavigationNotice'

let container: HTMLDivElement
let root: Root
let originalScroll: PropertyDescriptor | undefined
const scrollIntoView = vi.fn()
const frames = new Map<number, FrameRequestCallback>()
let nextFrame: number

function Harness({ nested = false }: { readonly nested?: boolean }) {
  const { noticeRef, revealNotice } = useNavigationNotice()
  const [blocked, setBlocked] = useState(false)
  const [draft, setDraft] = useState('Retained draft')
  const notice = blocked && <div aria-label="Navigation recovery" ref={noticeRef} role="region" tabIndex={-1}>Save or discard before leaving<button type="button">Keep editing</button></div>
  return <>
    <input aria-label="Draft" onChange={event => setDraft(event.target.value)} value={draft}/>
    <button onClick={() => { setBlocked(true); revealNotice() }} type="button">Try to leave</button>
    {nested ? <details><summary>Outer</summary><details><summary>Inner</summary>{notice}</details></details> : notice}
  </>
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  scrollIntoView.mockClear()
  nextFrame = 0
  frames.clear()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const frame = ++nextFrame
    frames.set(frame, callback)
    return frame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(frame => { frames.delete(frame) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

describe('navigation notice reveal', () => {
  it('leaves focus alone until a blocked attempt renders its recovery region', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      outside.focus()
      await act(async () => root.render(<StrictMode><Harness/></StrictMode>))
      expect(document.activeElement).toBe(outside)
      expect(scrollIntoView).not.toHaveBeenCalled()
      await act(async () => container.querySelector('button')!.click())
      const notice = container.querySelector<HTMLDivElement>('[role="region"]')!
      expect(document.activeElement).toBe(notice)
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center', inline: 'nearest', behavior: 'instant' })
      expect(scrollIntoView.mock.contexts[0]).toBe(notice)
    } finally { outside.remove() }
  })

  it('reveals repeated identical attempts without replacing the input or losing its draft', async () => {
    await act(async () => root.render(<Harness/>))
    const input = container.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsaved deep edit')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const attempt = container.querySelector('button')!
    await act(async () => attempt.click())
    const notice = container.querySelector<HTMLDivElement>('[role="region"]')!
    const focus = vi.spyOn(notice, 'focus')
    input.focus()
    await act(async () => attempt.click())
    expect(container.querySelector('input')).toBe(input)
    expect(input.value).toBe('Unsaved deep edit')
    expect(document.activeElement).toBe(notice)
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="region"]')).toBe(notice)
  })

  it('opens every containing disclosure before focusing and scrolling the recovery choices', async () => {
    await act(async () => root.render(<Harness nested/>))
    const details = [...container.querySelectorAll('details')]
    expect(details.every(detail => !detail.open)).toBe(true)
    scrollIntoView.mockImplementationOnce(function(this: HTMLElement) {
      expect(details.every(detail => detail.open)).toBe(true)
      expect(document.activeElement).toBe(this)
    })
    await act(async () => container.querySelector('button')!.click())
    expect(details.every(detail => detail.open)).toBe(true)
    expect(document.activeElement).toBe(container.querySelector('[role="region"]'))
  })

  it.each(['popstate', 'hashchange'])('reveals focused recovery feedback after native %s scroll restoration', async eventName => {
    await act(async () => root.render(<Harness/>))
    await act(async () => container.querySelector('button')!.click())
    const notice = container.querySelector<HTMLDivElement>('[role="region"]')!
    let scrollPosition = 'revealed'
    scrollIntoView.mockImplementation(() => { scrollPosition = 'revealed' })

    window.dispatchEvent(new Event(eventName))
    expect(frames.size).toBe(1)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    // Emulate native restoration after event handlers before the requested animation frame
    scrollPosition = 'old deep scroll'
    const callback = [...frames.values()][0]!
    frames.clear()
    callback(performance.now())

    expect(scrollPosition).toBe('revealed')
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView.mock.contexts[1]).toBe(notice)
    expect(document.activeElement).toBe(notice)
  })

  it('does not interrupt resumed field editing before or after a history replay is scheduled', async () => {
    await act(async () => root.render(<Harness/>))
    await act(async () => container.querySelector('button')!.click())
    const input = container.querySelector('input')!
    input.focus()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(frames.size).toBe(0)

    await act(async () => container.querySelector('button')!.click())
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(frames.size).toBe(1)
    input.focus()
    const callback = [...frames.values()][0]!
    frames.clear()
    callback(performance.now())

    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Retained draft')
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it('coalesces history events and removes pending replay work when the notice unmounts', async () => {
    await act(async () => root.render(<Harness/>))
    await act(async () => container.querySelector('button')!.click())
    window.dispatchEvent(new PopStateEvent('popstate'))
    const obsoleteFrame = [...frames.keys()][0]!
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(obsoleteFrame)
    expect(frames.size).toBe(1)
    const pendingCallback = [...frames.values()][0]!
    const requestCount = vi.mocked(window.requestAnimationFrame).mock.calls.length

    await act(async () => root.render(<input aria-label="Resumed workflow"/>))
    const resumed = container.querySelector('input')!
    resumed.focus()
    expect(frames.size).toBe(0)
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(requestCount)
    pendingCallback(performance.now())
    expect(document.activeElement).toBe(resumed)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})
