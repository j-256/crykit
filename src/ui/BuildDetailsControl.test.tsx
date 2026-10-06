import { act, StrictMode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asId } from '../domain'
import { TEST_GAME_SETUP_ID, TEST_NOW } from '../domain/test-helpers'
import type { Build, BuildId } from '../domain/types'
import { BuildDetailsControl } from './BuildDetailsControl'
import { WorkspaceHeaderContext } from './WorkspaceHeader'

const BUILD: Build = {
  id: asId<BuildId>('synthetic-build'), gameSetupId: TEST_GAME_SETUP_ID, revision: 1,
  title: 'Synthetic build', archived: false, tags: [], favorite: false,
  createdAt: TEST_NOW, updatedAt: TEST_NOW,
}
const RENAMED_TITLE = 'Renamed build'

let container: HTMLDivElement
let root: Root
let frames: FrameRequestCallback[]
let titleTarget: HTMLDivElement
const prototypeMethods = ['showPopover', 'hidePopover', 'scrollIntoView'] as const
let originalMethods: (PropertyDescriptor | undefined)[]

function button(label: string) {
  return [...container.querySelectorAll('button')].find(button => button.textContent === label)!
}

function flushFrames() {
  for (const frame of frames.splice(0)) frame(performance.now())
}

async function edit(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function headerButton(label: string) {
  return titleTarget.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
}

function compactControl(props: Omit<ComponentProps<typeof BuildDetailsControl>, 'compact' | 'suggestions'>, active = true) {
  return <StrictMode><WorkspaceHeaderContext value={{ active, target: null, primaryTarget: null, setPrimaryTarget: () => undefined, titleTarget, setTitleTarget: () => undefined, setUnsavedObject: () => undefined }}><BuildDetailsControl {...props} compact suggestions={[]}/></WorkspaceHeaderContext></StrictMode>
}

async function beginInline(title = BUILD.title) {
  await act(async () => headerButton('Rename').click())
  const input = titleTarget.querySelector('input')!
  expect(document.activeElement).toBe(input)
  await edit(input, title)
  return input
}

async function begin(title = BUILD.title) {
  await act(async () => button('Rename').click())
  const input = container.querySelector('input')!
  expect(document.activeElement).toBe(input)
  await edit(input, title)
  return input
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
  const open = new WeakSet<HTMLElement>()
  originalMethods = prototypeMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: function (this: HTMLElement) { open.add(this) } },
    hidePopover: { configurable: true, value: function (this: HTMLElement) { open.delete(this) } },
    scrollIntoView: { configurable: true, value: vi.fn() },
  })
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) { return selector === ':popover-open' ? open.has(this) : matches.call(this, selector) })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div')
  titleTarget = document.createElement('div')
  document.body.append(container, titleTarget)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  titleTarget.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [index, name] of prototypeMethods.entries()) {
    const descriptor = originalMethods[index]
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})

describe('Build details and focus', () => {
  it('saves tags without rewriting an untouched imported title', async () => {
    const build = { ...BUILD, title: '  Imported title  ' }
    const onSave = vi.fn(async () => undefined)
    await act(async () => root.render(<BuildDetailsControl build={build} suggestions={[]} onDirtyChange={() => undefined} onSave={onSave}/>))
    await act(async () => {
      const details = container.querySelector('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Add tag"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'support')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Save details').click())
    expect(onSave).toHaveBeenCalledWith(BUILD.id, { tags: ['support'] })
  })

  it('preserves untouched imported tag values when saving only a title', async () => {
    const build = { ...BUILD, tags: [' Support ', 'support', ''] }
    const onSave = vi.fn(async () => undefined)
    await act(async () => root.render(<BuildDetailsControl build={build} suggestions={[]} onDirtyChange={() => undefined} onSave={onSave}/>))
    await begin(RENAMED_TITLE)
    await act(async () => button('Save details').click())
    expect(onSave).toHaveBeenCalledWith(BUILD.id, { title: RENAMED_TITLE })
  })

  it('restores focus after asynchronous persistence even when an animation frame precedes the render', async () => {
    let resolveSave!: () => void
    const saved = new Promise<void>(resolve => { resolveSave = resolve })
    const onSave = vi.fn(() => saved)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(<StrictMode><BuildDetailsControl build={BUILD} suggestions={[]} onDirtyChange={onDirtyChange} onSave={onSave}/></StrictMode>))
    const input = await begin(RENAMED_TITLE)
    await act(async () => button('Save details').click())
    expect(onSave).toHaveBeenCalledWith(BUILD.id, { title: RENAMED_TITLE })
    expect(input.disabled).toBe(true)
    await act(async () => {
      resolveSave()
      await saved
      expect(container.querySelector('input')).toBe(input)
      flushFrames()
    })
    expect(container.querySelector('input')).toBeNull()
    expect(document.activeElement).toBe(button('Rename'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it.each(['Cancel details', 'Save details'])('returns focus after %s without writing an unchanged title', async action => {
    const onSave = vi.fn(async () => undefined)
    await act(async () => root.render(<BuildDetailsControl build={BUILD} suggestions={[]} onDirtyChange={() => undefined} onSave={onSave}/>))
    await begin()
    await act(async () => button(action).click())
    flushFrames()
    expect(document.activeElement).toBe(button('Rename'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps a failed rename open for retry and returns focus only after it succeeds', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Synthetic save failure')).mockResolvedValueOnce(undefined)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(<BuildDetailsControl build={BUILD} suggestions={[]} onDirtyChange={onDirtyChange} onSave={onSave}/>))
    const input = await begin(RENAMED_TITLE)
    await act(async () => button('Save details').click())
    expect(container.textContent).toContain('Synthetic save failure')
    expect(container.querySelector('input')).toBe(input)
    expect(input.value).toBe(RENAMED_TITLE)
    expect(input.disabled).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(false)
    await act(async () => button('Save details').click())
    expect(container.querySelector('input')).toBeNull()
    flushFrames()
    expect(document.activeElement).toBe(button('Rename'))
  })

  it('leaves existing focus alone on mount and title updates', async () => {
    const other = document.createElement('button')
    document.body.append(other)
    try {
      other.focus()
      const onSave = async () => undefined
      await act(async () => root.render(<StrictMode><BuildDetailsControl build={BUILD} suggestions={[]} onDirtyChange={() => undefined} onSave={onSave}/></StrictMode>))
      expect(document.activeElement).toBe(other)
      await act(async () => root.render(<StrictMode><BuildDetailsControl build={{ ...BUILD, title: RENAMED_TITLE }} suggestions={[]} onDirtyChange={() => undefined} onSave={onSave}/></StrictMode>))
      expect(document.activeElement).toBe(other)
    } finally {
      other.remove()
    }
  })

  it('associates the inline title with metadata submission while More is closed and never saves on blur', async () => {
    const onSave = vi.fn(async () => undefined)
    await act(async () => root.render(compactControl({ build: BUILD, onDirtyChange: () => undefined, onSave })))
    const heading = titleTarget.querySelector('h1')!
    expect(heading.getAttribute('aria-label')).toBe(BUILD.title)
    expect(headerButton('Rename').textContent).toBe(BUILD.title)
    await act(async () => headerButton('Rename').click())
    const input = titleTarget.querySelector('input')!
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(BUILD.title.length)
    const form = container.querySelector('form')!
    expect(input.form).toBe(form)
    expect(form.contains(input)).toBe(false)
    expect([...form.elements]).toContain(input)
    expect(headerButton('Save details').form).toBe(form)
    expect(input.required).toBe(true)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await edit(input, RENAMED_TITLE)
    await act(async () => button('More').focus())
    expect(onSave).not.toHaveBeenCalled()
    await act(async () => form.requestSubmit(headerButton('Save details')))
    expect(onSave).toHaveBeenCalledExactlyOnceWith(BUILD.id, { title: RENAMED_TITLE })
    expect(titleTarget.querySelector('input')).toBeNull()
    expect(document.activeElement).toBe(headerButton('Rename'))
  })

  it('moves More Rename into the header and keeps the independent tag draft when Escape cancels the title', async () => {
    const onSave = vi.fn(async () => undefined)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(compactControl({ build: BUILD, onDirtyChange, onSave })))
    await act(async () => { button('More').click(); flushFrames() })
    expect(headerButton('Rename')).toBeNull()
    await act(async () => {
      const details = container.querySelector('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    await edit(container.querySelector<HTMLInputElement>('[aria-label="Add tag"]')!, 'support')
    await act(async () => button('Rename').click())
    const input = titleTarget.querySelector('input')!
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(input)
    await edit(input, RENAMED_TITLE)
    await act(async () => button('More').click())
    expect(container.querySelectorAll('[aria-label="Save details"]')).toHaveLength(0)
    expect(button('Save details')).toBeUndefined()
    expect(button('Cancel details')).toBeUndefined()
    await act(async () => { button('More').click(); input.focus() })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(titleTarget.querySelector('input')).toBeNull()
    expect(document.activeElement).toBe(headerButton('Rename'))
    expect(onSave).not.toHaveBeenCalled()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true, expect.objectContaining({ save: expect.any(Function), discard: expect.any(Function) }))
    await act(async () => button('More').click())
    expect(container.querySelector<HTMLInputElement>('[aria-label="Add tag"]')!.value).toBe('support')
    await act(async () => button('Save details').click())
    expect(onSave).toHaveBeenCalledExactlyOnceWith(BUILD.id, { tags: ['support'] })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps invalid inline titles editable and reports blank and whitespace validation without persistence', async () => {
    const onSave = vi.fn(async () => undefined)
    await act(async () => root.render(compactControl({ build: BUILD, onDirtyChange: () => undefined, onSave })))
    const input = await beginInline('')
    await act(async () => container.querySelector('form')!.requestSubmit(headerButton('Save details')))
    expect(input.validity.valueMissing).toBe(true)
    expect(titleTarget.querySelector('[role="alert"]')!.textContent).toBe('Enter a Build title.')
    expect(onSave).not.toHaveBeenCalled()
    await edit(input, '  ')
    await act(async () => container.querySelector('form')!.requestSubmit(headerButton('Save details')))
    expect(titleTarget.querySelector('input')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(titleTarget.querySelector('[role="alert"]')!.textContent).toBe('Enter a Build title.')
    expect(titleTarget.querySelector('h1')!.getAttribute('aria-label')).toBe(BUILD.title)
    expect(onSave).not.toHaveBeenCalled()
    await edit(input, `  ${RENAMED_TITLE}  `)
    await act(async () => headerButton('Save details').click())
    expect(onSave).toHaveBeenCalledExactlyOnceWith(BUILD.id, { title: RENAMED_TITLE })
    expect(document.activeElement).toBe(headerButton('Rename'))
  })

  it('discards the complete metadata draft from the inline Cancel details action', async () => {
    const onSave = vi.fn(async () => undefined)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(compactControl({ build: BUILD, onDirtyChange, onSave })))
    await act(async () => button('More').click())
    await act(async () => {
      const details = container.querySelector('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    await edit(container.querySelector<HTMLInputElement>('[aria-label="Add tag"]')!, 'support')
    await act(async () => button('Rename').click())
    await edit(titleTarget.querySelector('input')!, RENAMED_TITLE)
    await act(async () => headerButton('Cancel details').click())
    expect(document.activeElement).toBe(headerButton('Rename'))
    expect(titleTarget.querySelector('input')).toBeNull()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(onSave).not.toHaveBeenCalled()
    await act(async () => button('More').click())
    expect(container.querySelector('details')!.open).toBe(false)
    await act(async () => {
      const details = container.querySelector('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    expect(container.querySelector<HTMLInputElement>('[aria-label="Add tag"]')!.value).toBe('')
  })

  it('retains failed inline details with concise recovery feedback and retries the same draft', async () => {
    const failure = 'Synthetic save failure. Error code storage-write; diagnostic synthetic-123.'
    const onSave = vi.fn().mockRejectedValueOnce(new Error(failure)).mockResolvedValueOnce(undefined)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(compactControl({ build: BUILD, onDirtyChange, onSave })))
    const input = await beginInline(RENAMED_TITLE)
    await act(async () => headerButton('Save details').click())
    const alert = titleTarget.querySelector('[role="alert"]')!
    expect(alert.firstElementChild!.textContent).toBe('Build details not saved.')
    expect(alert.querySelector('details')!.open).toBe(false)
    expect(alert.textContent).toContain('Synthetic save failure.')
    expect(alert.querySelector('code')!.textContent).toBe('Error code storage-write; diagnostic synthetic-123.')
    expect(titleTarget.querySelector('h1')!.getAttribute('aria-label')).toBe(BUILD.title)
    expect(titleTarget.querySelector('input')).toBe(input)
    expect(input.value).toBe(RENAMED_TITLE)
    expect(input.disabled).toBe(false)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(onDirtyChange).not.toHaveBeenCalledWith(false)
    await act(async () => headerButton('Save details').click())
    expect(onSave).toHaveBeenNthCalledWith(2, BUILD.id, { title: RENAMED_TITLE })
    expect(titleTarget.querySelector('input')).toBeNull()
    expect(document.activeElement).toBe(headerButton('Rename'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('does not take focus when an inline save completes while its workspace is inactive', async () => {
    let resolveSave!: () => void
    const saved = new Promise<void>(resolve => { resolveSave = resolve })
    const onSave = vi.fn(() => saved)
    const props = { build: BUILD, onDirtyChange: vi.fn(), onSave }
    const other = document.createElement('button')
    document.body.append(other)
    try {
      await act(async () => root.render(compactControl(props)))
      const input = await beginInline(RENAMED_TITLE)
      await act(async () => headerButton('Save details').click())
      expect(input.disabled).toBe(true)
      expect(headerButton('Cancel details').disabled).toBe(true)
      await act(async () => root.render(compactControl(props, false)))
      expect(titleTarget.querySelector('[data-workspace-title]')).toBeNull()
      other.focus()
      await act(async () => { resolveSave(); await saved })
      expect(document.activeElement).toBe(other)
      await act(async () => root.render(compactControl(props)))
      expect(document.activeElement).toBe(other)
      expect(headerButton('Rename')).not.toBeNull()
    } finally { other.remove() }
  })

  it('keeps failed tag recovery from opening a popover over an inactive workspace', async () => {
    let rejectSave!: (reason: Error) => void
    const saved = new Promise<void>((_resolve, reject) => { rejectSave = reject })
    const props = { build: BUILD, onDirtyChange: vi.fn(), onSave: vi.fn(() => saved) }
    const other = document.createElement('button')
    document.body.append(other)
    try {
      await act(async () => root.render(compactControl(props)))
      await act(async () => button('More').click())
      await act(async () => {
        const details = container.querySelector('details')!
        details.open = true
        details.dispatchEvent(new Event('toggle'))
      })
      await edit(container.querySelector<HTMLInputElement>('[aria-label="Add tag"]')!, 'support')
      await act(async () => button('Save details').click())
      await act(async () => root.render(compactControl(props, false)))
      other.focus()
      await act(async () => { rejectSave(new Error('Synthetic tag failure')); await saved.catch(() => undefined); flushFrames() })
      expect(container.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(other)
      expect(props.onDirtyChange).not.toHaveBeenCalledWith(false)
    } finally { other.remove() }
  })
})
