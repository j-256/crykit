import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import * as descriptions from '../catalog/native-description'
import * as modSearch from '../catalog/mod-search'
import { asId, observeInventory } from '../domain'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from '../domain/test-helpers'
import type { CatalogId, CatalogRevisionId, CatalogSnapshot, EntityId, LocalData } from '../domain/types'
import { DefinitionProvider, useDefinitionLibrary } from './definitions'

const catalog: CatalogSnapshot = {
  id: asId<CatalogId>('synthetic-options'), revisionId: asId<CatalogRevisionId>('synthetic-revision'),
  schemaVersion: 'synthetic', checksum: 'synthetic', claims: [],
  importedAt: TEST_NOW, applicability: { state: 'unknown' }, rights: { state: 'unknown' },
  entities: {
    item: { id: asId<EntityId>('item'), kind: 'item', name: 'Synthetic item', aliases: [], rawDescription: 'Original description', fields: {}, sources: [], legacy: { requiredMod: 'Synthetic mod' } },
  },
}
const catalogs = [catalog]
const planningCatalogs = [...catalogs]
const ref = { kind: 'catalog' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: catalog.entities.item!.id }
const unexpectedSave = () => Promise.reject(new Error('Unexpected definition save'))

function Options() {
  const { options, planningOptions, onRequestBundledSearch, bundledSearchPending, bundledSearchError } = useDefinitionLibrary()
  return <><output id="options">{JSON.stringify(options)}</output><output id="planning-options">{JSON.stringify(planningOptions)}</output><button onClick={onRequestBundledSearch} type="button">Load mod choices</button><output id="search-state">{bundledSearchError ?? (bundledSearchPending ? 'pending' : 'ready')}</output></>
}

it('reuses catalog metadata across saves while refreshing stock, enabled state, pins, and replaced catalog content', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const description = vi.spyOn(descriptions, 'referenceDescription')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (localData: LocalData, snapshots = catalogs) => act(async () => root.render(<DefinitionProvider catalogs={snapshots} localData={localData} onSaveDefinition={unexpectedSave} planningCatalogs={snapshots === catalogs ? planningCatalogs : snapshots}><Options/></DefinitionProvider>))
  const option = (id: string) => JSON.parse(container.querySelector(`#${id}`)!.textContent!)[0]
  try {
    const initial = createTestLocalData()
    await render(initial)
    expect(option('options')).toMatchObject({ description: 'Original description', stockLabel: 'Stock unrecorded', modAvailability: { state: 'unknown' }, gameSetupStatus: 'Outside the current Game Setup catalog pin' })
    description.mockClear()
    const observed = observeInventory(initial, { ref, possession: 'owned', quantity: { kind: 'exact', value: 2 }, now: TEST_NOW })
    const setup = observed.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const updated: LocalData = { ...observed, planningGameSetupRevisionId: setup.id, gameSetups: { ...observed.gameSetups, [setup.id]: { ...setup, mods: { state: 'known', value: ['Synthetic mod'] }, catalogLock: { [catalog.id]: catalog.revisionId } } } }
    await render(updated)
    expect(description).not.toHaveBeenCalled()
    for (const id of ['options', 'planning-options']) {
      expect(option(id)).toMatchObject({ description: 'Original description', stockLabel: '2 recorded owned', modAvailability: { state: 'enabled' } })
      expect(option(id).gameSetupStatus).toBeUndefined()
    }
    const replacement: CatalogSnapshot = { ...catalog, entities: { item: { ...catalog.entities.item!, rawDescription: 'Replacement description' } } }
    await render(updated, [replacement])
    expect(description).toHaveBeenCalled()
    expect(option('options')).toMatchObject({ description: 'Replacement description', stockLabel: '2 recorded owned', modAvailability: { state: 'enabled' } })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it.each(['loaded', 'failed'])('defers bundled discovery until requested and retains loaded definitions when discovery is %s', async outcome => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const preview: CatalogSnapshot = { ...catalog, id: asId<CatalogId>('synthetic-preview'), legacy: { bundledSearchPreview: true }, entities: { item: { ...catalog.entities.item!, name: 'Unloaded mod item' } } }
  const discovery = vi.spyOn(modSearch, 'bundledModSearchCatalogs').mockImplementation(() => {
    if (outcome === 'failed') throw new Error('Synthetic discovery failure')
    return [preview]
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<DefinitionProvider catalogs={catalogs} localData={createTestLocalData()} onLoadBundledMod={unexpectedSave} onSaveDefinition={unexpectedSave}><Options/></DefinitionProvider>))
    expect(discovery).not.toHaveBeenCalled()
    expect(JSON.parse(container.querySelector('#options')!.textContent!).map((option: { name: string }) => option.name)).toEqual(['Synthetic item'])
    await act(async () => container.querySelector('button')!.click())
    await act(async () => new Promise(resolve => window.setTimeout(resolve, 0)))
    expect(discovery).toHaveBeenCalledTimes(1)
    const names = JSON.parse(container.querySelector('#options')!.textContent!).map((option: { name: string }) => option.name)
    expect(names).toContain('Synthetic item')
    if (outcome === 'loaded') {
      expect(names).toContain('Unloaded mod item')
      expect(container.querySelector('#search-state')!.textContent).toBe('ready')
    } else {
      expect(names).not.toContain('Unloaded mod item')
      expect(container.querySelector('#search-state')!.textContent).toContain('Synthetic discovery failure')
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
