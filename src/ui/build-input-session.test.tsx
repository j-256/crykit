// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BuildInputProvider, createBuildInputSession, useBuildInputState } from './build-input-session'
import type { useWorkspace } from './WorkspaceProvider'
import { downloadBytes } from './model'
import { newOwnedFileCommand } from '../workspace/owned-file-command'

let workspace: ReturnType<typeof useWorkspace>
vi.mock('./WorkspaceProvider', () => ({ useWorkspace: () => workspace }))
vi.mock('./model', () => ({ downloadBytes: vi.fn() }))
let root: Root, container: HTMLDivElement

function Field() {
  const [title, setTitle] = useBuildInputState('title', 'Synthetic unsaved Build')
  return <input aria-label="Build title" value={title} onChange={event => setTitle(event.target.value)}/>
}
const button = (name: string) => [...container.querySelectorAll('button')].find(value => value.textContent === name)!
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  workspace = {
    buildInputSession: createBuildInputSession(),
    isCurrent: vi.fn(() => true),
    confirmBuildHydration: vi.fn().mockRejectedValue(new Error('Synthetic reopening failure')),
    retryBuildImport: vi.fn().mockRejectedValue(new Error('There is no Build import awaiting reconciliation')),
  } as unknown as ReturnType<typeof useWorkspace>
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks() })
const render = () => act(async () => root.render(<BuildInputProvider scope="synthetic-build"><Field/></BuildInputProvider>))

it('reports reopening failures without claiming a mod was imported or input was preserved', async () => {
  await render()
  expect(container.textContent).toContain('This Build could not be reopened.')
  expect(container.textContent).not.toContain('The import outcome needs checking')
  expect(container.textContent).not.toContain('Your Build input is kept here')
  expect(container.textContent).toContain('Synthetic reopening failure')
})

it('retries reopening directly when no import needs reconciliation and retains input', async () => {
  await render()
  vi.mocked(workspace.confirmBuildHydration).mockResolvedValue(undefined)
  await act(async () => button('Retry reopening').click())
  expect(workspace.confirmBuildHydration).toHaveBeenCalledTimes(2)
  expect(workspace.retryBuildImport).not.toHaveBeenCalled()
  expect(container.querySelector('section')).toBeNull()
  expect(container.querySelector('input')!.value).toBe('Synthetic unsaved Build')
})

it('keeps reconciliation and its failure visible when a mod import is uncertain', async () => {
  workspace.buildInputSession.scope = 'synthetic-build'
  workspace.buildInputSession.phase = 'recovery'
  workspace.buildInputSession.recovery = { outcome: { status: 'uncertain' }, command: newOwnedFileCommand('libraryImport') }
  vi.mocked(workspace.retryBuildImport).mockRejectedValue(new Error('Synthetic import is still uncertain'))
  await render()
  await act(async () => button('Retry reopening').click())
  expect(workspace.retryBuildImport).toHaveBeenCalledOnce()
  expect(workspace.confirmBuildHydration).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('The import outcome needs checking')
  expect(container.textContent).toContain('Synthetic import is still uncertain')
  expect(container.querySelector('input')!.value).toBe('Synthetic unsaved Build')
})

it('downloads only inert input for a current owner', async () => {
  await render()
  await act(async () => button('Download Build input').click())
  expect(downloadBytes).toHaveBeenCalledOnce()
  const [bytes, name, type] = vi.mocked(downloadBytes).mock.calls[0]!
  expect(name).toBe('build-input-recovery.json')
  expect(type).toBe('application/json')
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ format: 'crykit-build-input-recovery', version: 1, values: { title: 'Synthetic unsaved Build' } })
})

it.each(['workspace', 'view', 'download'] as const)('shows a visible download failure for an unavailable %s', async failure => {
  await render()
  if (failure === 'workspace') vi.mocked(workspace.isCurrent).mockReturnValue(false)
  if (failure === 'view') workspace.buildInputSession.controller.revoke()
  if (failure === 'download') vi.mocked(downloadBytes).mockImplementation(() => { throw new Error('Synthetic browser download failure') })
  await act(async () => button('Download Build input').click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Build input could not be downloaded')
  if (failure !== 'download') expect(downloadBytes).not.toHaveBeenCalled()
  expect(container.querySelector('input')!.value).toBe('Synthetic unsaved Build')
})
