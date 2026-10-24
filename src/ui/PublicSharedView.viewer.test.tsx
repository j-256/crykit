import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { addTestBuild, addTestDefinition, createTestLocalData, personalRef } from '../domain/test-helpers'
import type { WorkspaceState } from '../workspace/documents'
import { createPublicSnapshot, encodePublicSnapshot } from '../interchange/public-share'
import { CopiedPublicCheckpointView, PublicSharedView, HostedSharedView } from './PublicSharedView'
import { clearServiceNotice } from '../account/service-notice'
import { preparePublicSnapshotCopy } from '../interchange/public-share-enrichment'
import { editCopiedCheckpoint } from '../interchange/public-checkpoint-edit'
const context = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('./WorkspaceProvider', () => ({ useOptionalWorkspace: () => context.current }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
let root = createRoot(container)
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(container); context.current = undefined; clearServiceNotice(); vi.restoreAllMocks() })
it('letsAViewerRetryTheSameRateLimitedLinkWithoutRequestingAReplacement', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('limited', { status: 429 })).mockResolvedValueOnce(Response.json({ error: { code: 'NOT_FOUND', requestId: 'synthetic' } }, { status: 404 }))
  await act(async () => root.render(<HostedSharedView shareId="AAAAAAAAAAAAAAAAAAAAAA"/>))
  expect(container.textContent).toContain('Cloud requests are temporarily paused')
  expect(container.textContent).not.toContain('ask its owner for a new link')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(container.textContent).toContain('ask its owner for a new link')
})
function fixture() {
  let localData = addTestDefinition(createTestLocalData(), 'private-own')
  localData = addTestBuild(localData, 'Shared sword', '', { hand: { ref: personalRef('private-own') } })
  const definition = localData.personalDefinitions['private-own']!
  localData = { ...localData, personalDefinitions: { [definition.id]: { ...definition, rawDescription: 'OWN_VERIFIED_EFFECT' } } }
  const state: WorkspaceState = { planner: { localData, catalogs: [], lineage: { rootLocalDataId: localData.id }, sources: [], evidence: [], history: [] }, assets: [], blobs: [], editorDocuments: [], saveDocuments: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [] }
  const snapshot = createPublicSnapshot(state, { kind: 'build', revisionId: 'Shared sword-revision' as never }, { includeNotes: false })
  return { state, encoded: encodePublicSnapshot(snapshot) }
}
it('offers an explicit editable checkpoint while keeping the copied public checkpoint intact', async () => {
  const { state: original, encoded } = fixture()
  const { decodePublicSnapshot } = await import('../interchange/public-share')
  const copied = preparePublicSnapshotCopy(original, decodePublicSnapshot(encoded))
  let state = copied.state
  const checkpoint = state.planner.localData.buildRevisions[state.planner.localData.builds[copied.result.buildId!]!.latestRevisionId!]!
  context.current = { repository: { readWorkspace: async () => state, subscribe: () => () => undefined } }
  await act(async () => root.render(<CopiedPublicCheckpointView checkpoint={checkpoint} setup={state.planner.localData.gameSetups[checkpoint.gameSetupRevisionId]!} title="My copy" onEdit={async (viewer, input) => {
    const result = editCopiedCheckpoint(viewer, input)
    state = { ...state, planner: { ...state.planner, localData: result.localData } }
    return result.checkpoint
  }}/>))
  const adapt = [...container.querySelectorAll('button')].find(button => button.textContent === 'Create editable checkpoint')
  expect(adapt).toBeDefined()
  await act(async () => adapt!.click())
  const saved = state.planner.localData.buildRevisions[state.planner.localData.builds[checkpoint.buildId]!.latestRevisionId!]!
  expect(saved.publicSourceContext).toBeUndefined()
  expect(saved.content.equipment.hand!.ref).toEqual(personalRef('private-own'))
  expect(state.planner.localData.buildRevisions[checkpoint.id]).toEqual(checkpoint)
})
it('keeps copied notes after a failed save and supports the existing explicit discard action', async () => {
  const { state: original, encoded } = fixture()
  const { decodePublicSnapshot } = await import('../interchange/public-share')
  const copied = preparePublicSnapshotCopy(original, decodePublicSnapshot(encoded)), state = copied.state
  const checkpoint = state.planner.localData.buildRevisions[state.planner.localData.builds[copied.result.buildId!]!.latestRevisionId!]!
  let actions: import('./drafts').DraftActions | undefined
  context.current = { repository: { readWorkspace: async () => state, subscribe: () => () => undefined } }
  await act(async () => root.render(<CopiedPublicCheckpointView checkpoint={checkpoint} setup={state.planner.localData.gameSetups[checkpoint.gameSetupRevisionId]!} title="My copy" onDraftChange={(_dirty, next) => { actions = next }} onEdit={async () => { throw new Error('Synthetic save failure') }}/>))
  const notes = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Slot 1 rotation notes"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Unsaved recipient notes')
    notes.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save notes')!
  await act(async () => save.click())
  expect(container.textContent).toContain('Synthetic save failure')
  expect(notes.value).toBe('Unsaved recipient notes')
  expect(state.planner.localData.buildRevisions[checkpoint.id]).toEqual(checkpoint)
  await act(async () => { expect(await actions!.discard()).toBe(true) })
  expect(notes.value).toBe('')
})
it('shows only exact viewer definitions and drops a late prior-profile read', async () => {
  const { state, encoded } = fixture()
  let finish!: (state: WorkspaceState) => void
  context.current = { repository: { readWorkspace: () => new Promise(resolve => { finish = resolve }), subscribe: () => () => undefined } }
  await act(async () => root.render(<PublicSharedView encoded={encoded}/>))
  expect(finish).toBeTypeOf('function')
  expect(container.textContent).not.toContain('OWN_VERIFIED_EFFECT')
  context.current = { repository: { readWorkspace: async () => ({ ...state, planner: { ...state.planner, localData: createTestLocalData() } }), subscribe: () => () => undefined } }
  await act(async () => root.render(<PublicSharedView encoded={encoded}/>))
  await act(async () => finish(state))
  expect(container.textContent).not.toContain('OWN_VERIFIED_EFFECT')
  context.current = { repository: { readWorkspace: async () => state, subscribe: () => () => undefined } }
  await act(async () => root.render(<PublicSharedView encoded={encoded}/>))
  expect(container.textContent).toContain('OWN_VERIFIED_EFFECT')
})

it('scopes a pending copy to its original repository', async () => {
  const { state, encoded } = fixture()
  let finish!: () => void
  const commitWorkspace = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  context.current = { repository: { readWorkspace: async () => state, subscribe: () => () => undefined, commitWorkspace } }
  await act(async () => root.render(<PublicSharedView encoded={encoded}/>))
  const save = () => [...container.querySelectorAll('button')].find(button => ['Save a copy', 'Saving...'].includes(button.textContent ?? ''))!
  await act(async () => save().click())
  expect(commitWorkspace).toHaveBeenCalledOnce()
  expect(save().disabled).toBe(true)
  context.current = { repository: { readWorkspace: async () => state, subscribe: () => () => undefined } }
  await act(async () => root.render(<PublicSharedView encoded={encoded}/>))
  expect(save().disabled).toBe(false)
  await act(async () => finish())
  expect(container.textContent).not.toContain('Copy saved')
})

it('coalesces library notifications and defers refresh while the viewer owns a copy', async () => {
  const { state, encoded } = fixture()
  let notify!: () => void, finishRead!: (state: WorkspaceState) => void, finishCopy!: () => void
  const readWorkspace = vi.fn(() => new Promise<WorkspaceState>(resolve => { finishRead = resolve }))
  const onSave = vi.fn(() => new Promise<never>((_resolve, reject) => { finishCopy = () => reject(new Error('Copy interrupted. Retry from this view.')) }))
  context.current = { repository: { readWorkspace, subscribe: (listener: () => void) => { notify = listener; return () => undefined } } }
  await act(async () => root.render(<PublicSharedView encoded={encoded} onSave={onSave}/>))
  await act(async () => { notify(); notify(); notify() })
  expect(readWorkspace).toHaveBeenCalledTimes(1)
  await act(async () => finishRead(state))
  expect(readWorkspace).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('OWN_VERIFIED_EFFECT')
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save a copy')!
  await act(async () => save.click())
  await act(async () => { notify(); notify(); notify() })
  expect(onSave).toHaveBeenCalledOnce()
  expect(readWorkspace).toHaveBeenCalledTimes(2)
  await act(async () => finishRead({ ...state, planner: { ...state.planner, localData: createTestLocalData() } }))
  expect(container.textContent).toContain('OWN_VERIFIED_EFFECT')
  await act(async () => finishCopy())
  expect(container.textContent).toContain('Copy interrupted. Retry from this view.')
  expect(readWorkspace).toHaveBeenCalledTimes(3)
  await act(async () => finishRead(state))
})

it('requires a completed library read before import and offers recovery after a failed read', async () => {
  const { state, encoded } = fixture()
  const { decodePublicSnapshot } = await import('../interchange/public-share')
  const original = decodePublicSnapshot(encoded)
  const shared = encodePublicSnapshot({ ...original, setup: { ...original.setup, layers: [{ catalogId: 'own-project', catalogRevisionId: 'exact-source', title: 'Required file' }] } })
  let rejectRead!: (error: Error) => void
  const readWorkspace = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject })).mockResolvedValue(state)
  context.current = { repository: { readWorkspace, subscribe: () => () => undefined } }
  await act(async () => root.render(<PublicSharedView encoded={shared}/>))
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Add matching files')!.click())
  expect(container.querySelector<HTMLInputElement>('input[type=file]')!.disabled).toBe(true)
  expect(container.textContent).toContain('Reading your library...')
  expect(container.textContent).not.toContain('Matching content is available')
  await act(async () => rejectRead(new Error('Captured read interrupted')))
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry library read')!
  expect(retry).toBeTruthy()
  await act(async () => retry.click())
  expect(readWorkspace).toHaveBeenCalledTimes(2)
  expect(container.querySelector<HTMLInputElement>('input[type=file]')!.disabled).toBe(false)
  expect(container.textContent).toContain('This exact source is missing from your library.')
})
