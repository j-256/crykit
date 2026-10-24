import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FolderImportPreview as FolderPreview } from '../../workspace/folder-import'
import { FolderImportPreview } from './FolderImportPreview'

const preview = {
  projects: [
    { projectId: 'shared-project', sourceId: 'source:first', relativePath: 'one.json', title: 'Synthetic mod', declaredVersion: '1', byteLength: 100 },
    { projectId: 'shared-project', sourceId: 'source:second', relativePath: 'two.json', title: 'Synthetic mod', declaredVersion: '2', byteLength: 120 },
  ],
  uploadCandidates: [{ relativePath: 'art/icon.png', width: 32, height: 32, byteLength: 200 }],
  selectedArtwork: [], excludedFiles: [{ relativePath: 'notes.txt', reason: 'Unsupported' }], unresolvedAssociations: ['art/icon.png'], totalBytes: 420,
} as unknown as FolderPreview
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('requires an exact revision and explicit choices before saving', async () => {
  const onConfirm = vi.fn()
  await act(async () => root.render(<FolderImportPreview preview={preview} busy={false} onConfirm={onConfirm} onCancel={() => {}}/>))
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save selected JSON')!
  expect(save.disabled).toBe(true)
  const revisions = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
  expect(revisions).toHaveLength(2)
  expect([...revisions].every(input => !input.checked)).toBe(true)
  await act(async () => revisions[1]!.click())
  const choices = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  expect(choices).toHaveLength(3)
  expect(choices[0]!.checked).toBe(false)
  expect(choices[1]!.checked).toBe(false)
  await act(async () => { choices[0]!.click(); choices[1]!.click(); save.click() })
  expect(onConfirm).toHaveBeenCalledWith({ projects: [{ projectId: 'shared-project', sourceId: 'source:second', relativePath: 'two.json', choices: { inReference: true, futureDefault: true } }], assets: [] })
})

it('requires exact association and includes selected artwork in confirmation', async () => {
  const onConfirm = vi.fn(), onCancel = vi.fn()
  await act(async () => root.render(<FolderImportPreview preview={preview} busy={false} onConfirm={onConfirm} onCancel={onCancel}/>))
  await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click())
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2]!.click())
  expect(container.textContent).toContain('Associate each selected image')
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save selected JSON and artwork')!
  expect(save.disabled).toBe(true)
  await act(async () => {
    const select = container.querySelector('select')!
    select.value = JSON.stringify(['source:first', 'one.json'])
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(onConfirm).toHaveBeenCalledWith({ projects: [{ projectId: 'shared-project', sourceId: 'source:first', relativePath: 'one.json', choices: { inReference: false, futureDefault: false } }], assets: [{ relativePath: 'art/icon.png', projectId: 'shared-project', sourceId: 'source:first', projectRelativePath: 'one.json' }] })
  const excluded = container.querySelector('details')!
  expect(excluded.textContent).toContain('notes.txt: Unsupported')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Cancel folder import')!.click())
  expect(onCancel).toHaveBeenCalledOnce()
})
