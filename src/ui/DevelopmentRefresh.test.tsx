// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:5187/"}
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevelopmentRefresh } from './DevelopmentRefresh'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubEnv('DEV', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllEnvs()
})

describe('development refresh', () => {
  it('shows the current development port and requests a full page reload', async () => {
    const onRefresh = vi.fn()
    await act(async () => root.render(<DevelopmentRefresh blocked={false} onRefresh={onRefresh}/>))
    expect(container.querySelector('[role="note"]')?.getAttribute('aria-label')).toBe('Development server port 5187')
    expect(container.textContent).toContain('Port 5187')
    const button = container.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Reload development app')
    expect(button.title).toContain('Reload the full development page')
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('blocks reload while changes or pending work require protection', async () => {
    const onRefresh = vi.fn()
    await act(async () => root.render(<DevelopmentRefresh blocked onRefresh={onRefresh}/>))
    const button = container.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('Save or discard changes')
    expect(button.title).toContain('resolve failed saves')
    await act(async () => button.click())
    expect(onRefresh).not.toHaveBeenCalled()
    await act(async () => root.render(<DevelopmentRefresh blocked={false} onRefresh={onRefresh}/>))
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('omits development controls from production', async () => {
    vi.stubEnv('DEV', false)
    await act(async () => root.render(<DevelopmentRefresh blocked={false} onRefresh={vi.fn()}/>))
    expect(container.childElementCount).toBe(0)
  })
})
