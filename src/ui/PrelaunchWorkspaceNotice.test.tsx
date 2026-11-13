import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PrelaunchWorkspaceNotice } from './PrelaunchWorkspaceNotice'

it('requires a deliberate start and retains the explanation when preparation fails', async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error('Synthetic storage failure')).mockResolvedValue(undefined)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<PrelaunchWorkspaceNotice onStart={start}/>))
    expect(start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('CryKit')
    expect(container.textContent).toContain('remain stored in this browser')
    const button = container.querySelector('button')!
    expect(button.textContent).toContain('Start new workspace')
    await act(async () => button.click())
    expect(start).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Synthetic storage failure')
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(start).toHaveBeenCalledTimes(2)
  } finally { await act(async () => root.unmount()); container.remove() }
})
