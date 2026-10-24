// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestLocalData } from '../domain/test-helpers'
import { CharactersView, type CharacterDraft } from './CharactersView'
import { NavigationProvider, useNavigationController, type NavigationController } from './navigation'

let root: Root, container: HTMLDivElement, navigation: NavigationController
const noop = async () => {}
const showModal = HTMLDialogElement.prototype.showModal, close = HTMLDialogElement.prototype.close
function Harness({ save = noop }: { save?: (draft: CharacterDraft) => Promise<void> }) {
  navigation = useNavigationController()
  return <NavigationProvider controller={navigation}><CharactersView localData={createTestLocalData()} catalogs={[]} hasPendingSave={false} onAdd={save} onCapture={noop} onUpsertClass={noop} onUpsertLearned={noop} onImportScreenshots={noop} onDraftChange={() => {}} onRetrySave={noop}/></NavigationProvider>
}
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); window.queueMicrotask(() => this.dispatchEvent(new Event('close'))) }
  window.history.replaceState(null, '', '#/characters/new')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); HTMLDialogElement.prototype.showModal = showModal; HTMLDialogElement.prototype.close = close })
async function typeName() {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Name used in your playthrough"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Typed character'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  return input
}
it('typedCharacterGuardsNavigationAndExplicitCancelReleasesIt', async () => {
  await act(async () => root.render(<Harness/>))
  expect(navigation.hasOpenDraft()).toBe(false)
  const input = await typeName()
  expect(navigation.hasOpenDraft()).toBe(true)
  await act(async () => { navigation.navigate({ page: { page: 'builds', view: 'library' }, overlays: [], query: {} }) })
  expect(input.value).toBe('Typed character')
  expect(document.body.textContent).toContain('Unsaved character')
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click() })
  expect(navigation.hasOpenDraft()).toBe(false)
  expect(document.querySelector('input[placeholder="Name used in your playthrough"]')).toBeNull()
})
it('failedSaveRetainsTheGuardAndSuccessfulSaveClosesNormally', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('Synthetic local save failure')).mockResolvedValue(undefined)
  await act(async () => root.render(<Harness save={save}/>)); await typeName()
  const submit = () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await act(async () => { submit() })
  expect(navigation.hasOpenDraft()).toBe(true)
  expect(document.body.textContent).toContain('Synthetic local save failure')
  await act(async () => { submit() })
  expect(save).toHaveBeenLastCalledWith({ name: 'Typed character' })
  expect(navigation.hasOpenDraft()).toBe(false)
})
it('workspaceUnmountReleasesItsGuardAndLateSaveCannotNavigateTheSuccessor', async () => {
  let release!: () => void
  const save = () => new Promise<void>(resolve => { release = resolve })
  await act(async () => root.render(<Harness save={save}/>)); await typeName()
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  const captured = navigation
  await act(async () => root.render(<p>Successor workspace</p>))
  expect(captured.hasOpenDraft()).toBe(false)
  window.history.replaceState(null, '', '#/settings/account')
  await act(async () => { release() })
  expect(window.location.hash).toBe('#/settings/account')
  expect(container.textContent).toBe('Successor workspace')
})
