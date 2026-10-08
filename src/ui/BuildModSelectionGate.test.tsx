// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { SYNTHETIC_MOD_SNAPSHOT } from '../catalog/mod.test-helpers'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { buildBehavior } from '../domain/build-behavior'
import { buildBundledModEntities } from '../domain/bundled-mods'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { BuildRevisionContent, CatalogSnapshot } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { BuildModSelectionGate, useBuildModSelection } from './BuildModSelectionGate'
import { DefinitionLibraryContext, type DefinitionOption } from './definitions'

vi.mock('../catalog/mod-library-metadata', async () => {
  const { SYNTHETIC_BUNDLED_MOD } = await import('../catalog/mod.test-helpers')
  return { BUNDLED_MOD_LIBRARY: [SYNTHETIC_BUNDLED_MOD], STARTER_MOD_PROJECT_IDS: [] }
})
let root: Root
let container: HTMLDivElement
const showModal = HTMLDialogElement.prototype.showModal
const close = HTMLDialogElement.prototype.close
const localData = createTestLocalData()
const record = Object.values(buildBundledModEntities(SYNTHETIC_MOD_SNAPSHOT, NATIVE_GAME_DATA.enums)).find(value => value.kind === 'class')!
const catalog = { ...CURRENT_CATALOG, entities: { ...CURRENT_CATALOG.entities, [record.id]: record } }
const option: DefinitionOption = { key: 'synthetic-selection', ref: { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: record.id }, kind: record.kind, name: record.name, aliases: [], sourceLabel: 'Synthetic Library', stockLabel: '', preferred: true, record }
const content: BuildRevisionContent = { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }
const before = buildBehavior(localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!)
const accept = vi.fn()
const cancel = vi.fn()
const restoreFocus = vi.fn()
const onChange = vi.fn()
const onBusyChange = vi.fn()
const loader = vi.fn<() => Promise<CatalogSnapshot>>()
function Trigger() {
  const gate = useBuildModSelection()!
  return <button onClick={() => gate.select({ option, accept, cancel, restoreFocus })}>Select synthetic class</button>
}
function button(name: string) { return [...document.querySelectorAll('button')].find(element => element.textContent === name)! }
async function click(name: string) { await act(async () => button(name).click()) }
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function() { this.removeAttribute('open') }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.clearAllMocks(); loader.mockReset()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(performance.now()); return 1 })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); HTMLDialogElement.prototype.showModal = showModal; HTMLDialogElement.prototype.close = close; vi.restoreAllMocks() })
it('keeps a bundled selection pending after load failure and accepts its exact imported revision only after a successful retry', async () => {
  const imported = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: SYNTHETIC_MOD_SNAPSHOT.source.projectId, Title: SYNTHETIC_MOD_SNAPSHOT.source.title, Version: '2.2', EditorVersion: 34, ...SYNTHETIC_MOD_SNAPSHOT.families })), 'synthetic.json')).proposed.catalogs[0]!
  loader.mockRejectedValueOnce(new Error('Synthetic source read failure')).mockResolvedValueOnce(imported)
  await act(async () => root.render(<DefinitionLibraryContext value={{ localData, catalogs: [catalog], options: [option], availableOptions: [option], planningOptions: [option], availablePlanningOptions: [option], onSaveDefinition: async () => option.ref, onLoadBundledMod: loader, onRequestBundledSearch: () => undefined, bundledSearchPending: false }}><BuildModSelectionGate content={content} value={before} onChange={onChange} onBusyChange={onBusyChange}><Trigger/></BuildModSelectionGate></DefinitionLibraryContext>))
  await click('Select synthetic class'); await click('Enable and select Synthetic Class')
  expect(document.body.textContent).toContain('Synthetic source read failure')
  expect(document.body.textContent).toContain('Your selection has not changed')
  expect(onChange).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  expect(document.querySelector('dialog')?.open).toBe(true)
  await click('Enable and select Synthetic Class')
  expect(loader).toHaveBeenCalledTimes(2)
  expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modComposition: expect.objectContaining({ layers: [{ catalogId: imported.id, catalogRevisionId: imported.revisionId, enabled: true }] }) }))
  expect(accept).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled(); expect(restoreFocus).toHaveBeenCalledTimes(1)
  expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  expect(document.querySelector('dialog[open]')).toBeNull()
  expect(before).toEqual(buildBehavior(localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!))
})
