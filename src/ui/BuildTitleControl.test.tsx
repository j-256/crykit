import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asId } from '../domain'
import { TEST_GAME_SETUP_ID, TEST_NOW } from '../domain/test-helpers'
import type { Build, BuildId } from '../domain/types'
import { BuildTitleControl } from './BuildTitleControl'

const BUILD: Build = {
  id: asId<BuildId>('synthetic-build'), gameSetupId: TEST_GAME_SETUP_ID, revision: 1,
  title: 'Synthetic build', kind: 'build', state: 'draft', tags: [], favorite: false,
  createdAt: TEST_NOW, updatedAt: TEST_NOW,
}
const RENAMED_TITLE = 'Renamed build'

let container: HTMLDivElement
let root: Root
let frames: FrameRequestCallback[]

function button(label: string) {
  return [...container.querySelectorAll('button')].find(button => button.textContent === label)!
}

function flushFrames() {
  for (const frame of frames.splice(0)) frame(performance.now())
}

async function begin(title = BUILD.title) {
  await act(async () => button('Rename').click())
  const input = container.querySelector('input')!
  expect(document.activeElement).toBe(input)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, title)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('build title focus', () => {
  it('restores focus after asynchronous persistence even when an animation frame precedes the render', async () => {
    let resolveSave!: () => void
    const saved = new Promise<void>(resolve => { resolveSave = resolve })
    const onRename = vi.fn(() => saved)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(<StrictMode><BuildTitleControl build={BUILD} onDirtyChange={onDirtyChange} onRename={onRename}/></StrictMode>))
    const input = await begin(RENAMED_TITLE)
    await act(async () => button('Save title').click())
    expect(onRename).toHaveBeenCalledWith(BUILD.id, RENAMED_TITLE)
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

  it.each(['Cancel rename', 'Save title'])('returns focus after %s without writing an unchanged title', async action => {
    const onRename = vi.fn(async () => undefined)
    await act(async () => root.render(<BuildTitleControl build={BUILD} onDirtyChange={() => undefined} onRename={onRename}/>))
    await begin()
    await act(async () => button(action).click())
    flushFrames()
    expect(document.activeElement).toBe(button('Rename'))
    expect(onRename).not.toHaveBeenCalled()
  })

  it('keeps a failed rename open for retry and returns focus only after it succeeds', async () => {
    const onRename = vi.fn().mockRejectedValueOnce(new Error('Synthetic save failure')).mockResolvedValueOnce(undefined)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(<BuildTitleControl build={BUILD} onDirtyChange={onDirtyChange} onRename={onRename}/>))
    const input = await begin(RENAMED_TITLE)
    await act(async () => button('Save title').click())
    expect(container.textContent).toContain('Synthetic save failure')
    expect(container.querySelector('input')).toBe(input)
    expect(input.value).toBe(RENAMED_TITLE)
    expect(input.disabled).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(false)
    await act(async () => button('Save title').click())
    expect(container.querySelector('input')).toBeNull()
    flushFrames()
    expect(document.activeElement).toBe(button('Rename'))
  })

  it('leaves existing focus alone on mount and title updates', async () => {
    const other = document.createElement('button')
    document.body.append(other)
    try {
      other.focus()
      const onRename = async () => undefined
      await act(async () => root.render(<StrictMode><BuildTitleControl build={BUILD} onDirtyChange={() => undefined} onRename={onRename}/></StrictMode>))
      expect(document.activeElement).toBe(other)
      await act(async () => root.render(<StrictMode><BuildTitleControl build={{ ...BUILD, title: RENAMED_TITLE }} onDirtyChange={() => undefined} onRename={onRename}/></StrictMode>))
      expect(document.activeElement).toBe(other)
    } finally {
      other.remove()
    }
  })
})
