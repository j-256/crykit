import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import * as descriptions from '../catalog/native-description'
import * as availability from '../catalog/mods'
import * as modSearch from '../catalog/mod-search'
import { asId, observeInventory, createPersonalDefinition } from '../domain'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from '../domain/test-helpers'
import { savedCatalogVersion } from '../domain/legacy-definition.test-helpers'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogId, CatalogRevisionId, CatalogSnapshot, EntityId, LocalData } from '../domain/types'
import { buildDefinitionOptions, DefinitionProvider, useDefinitionLibrary } from './definitions'

const freezeFixture = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeFixture); Object.freeze(value) }; return value }
const catalog: CatalogSnapshot = freezeFixture({
  id: asId<CatalogId>('synthetic-options'), revisionId: asId<CatalogRevisionId>('synthetic-revision'),
  schemaVersion: 'synthetic', checksum: 'synthetic', claims: [],
  importedAt: TEST_NOW, applicability: { state: 'unknown' }, rights: { state: 'unknown' },
  entities: {
    item: { id: asId<EntityId>('item'), kind: 'item', name: 'Synthetic item', aliases: [], rawDescription: 'Original description', fields: {}, sources: [], legacy: { requiredMod: 'Synthetic mod' } },
  },
})
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

it.each(['admitted', 'frozen'] as const)('reuses only recursively immutable %s catalog projections after an owned view remount', async source => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const freeze = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
  const immutable = source === 'admitted' ? immutableCatalogSnapshot(structuredClone(catalog)) : freeze(structuredClone(catalog))
  const description = vi.spyOn(descriptions, 'referenceDescription')
  const container = document.createElement('div'), root = createRoot(container)
  const initial = createTestLocalData()
  const render = (key: string, snapshot: CatalogSnapshot, data = initial) => act(async () => root.render(<DefinitionProvider key={key} catalogs={[snapshot]} localData={data} onSaveDefinition={unexpectedSave}><Options/></DefinitionProvider>))
  try {
    await render('first', immutable)
    description.mockClear()
    await render('successor', immutable, observeInventory(initial, { ref, possession: 'owned', quantity: { kind: 'exact', value: 3 }, now: TEST_NOW }))
    expect(description).not.toHaveBeenCalled()
    expect(JSON.parse(container.querySelector('#options')!.textContent!)[0].stockLabel).toBe('3 recorded owned')
    const mutable = Object.freeze(structuredClone(catalog))
    await render('mutable', mutable)
    Object.assign(mutable.entities.item!, { rawDescription: 'Changed nested description' })
    await render('mutable-successor', mutable)
    expect(JSON.parse(container.querySelector('#options')!.textContent!)[0].description).toBe('Changed nested description')
  } finally { await act(async () => root.unmount()); description.mockRestore() }
})

it('reuses immutable option inputs after unrelated notes while recomputing mutable inventory and catalog values', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const freeze = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
  const immutableCatalog = freeze(structuredClone(catalog)), initial = freeze(createTestLocalData())
  const mod = vi.spyOn(availability, 'definitionModAvailability')
  const container = document.createElement('div'), root = createRoot(container)
  const render = (data: LocalData, snapshot = immutableCatalog) => act(async () => root.render(<DefinitionProvider catalogs={[snapshot]} localData={data} onSaveDefinition={unexpectedSave}><Options/></DefinitionProvider>))
  const option = () => JSON.parse(container.querySelector('#options')!.textContent!)[0]
  try {
    await render(initial)
    mod.mockClear()
    await render({ ...initial, revision: initial.revision + 1, builds: { ...initial.builds } })
    expect(mod).not.toHaveBeenCalled()
    const changed = observeInventory(initial, { ref, possession: 'owned', quantity: { kind: 'exact', value: 4 }, now: TEST_NOW })
    await render(changed)
    expect(mod).toHaveBeenCalled()
    expect(option().stockLabel).toBe('4 recorded owned')
    const position = Object.values(changed.playthroughs[changed.selectedPlaythroughId!]!.inventory)[0]!
    Object.assign(position, { quantity: { kind: 'exact', value: 7 } })
    await render(changed)
    expect(option().stockLabel).toBe('7 recorded owned')
    const personal = createPersonalDefinition(initial, { kind: 'item', name: 'Synthetic personal choice', expectedRevision: initial.revision, now: TEST_NOW })
    await render(personal)
    expect(JSON.parse(container.querySelector('#options')!.textContent!).some((value: { name: string }) => value.name === 'Synthetic personal choice')).toBe(true)
    const pinned = { ...initial, gameSetups: { ...initial.gameSetups, [TEST_GAME_SETUP_REVISION_ID]: { ...initial.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, catalogLock: { [catalog.id]: catalog.revisionId }, mods: { state: 'known' as const, value: ['Synthetic mod'] } } } }
    await render(freeze(pinned))
    expect(option().modAvailability.state).toBe('enabled')
    expect(option().gameSetupStatus).toBeUndefined()
    const shallow = Object.freeze(structuredClone(catalog))
    await render(initial, shallow)
    Object.assign(shallow.entities.item!, { rawDescription: 'Changed mutable description' })
    await render(initial, shallow)
    expect(option().description).toBe('Changed mutable description')
  } finally { await act(async () => root.unmount()); mod.mockRestore() }
})

it('groups recorded stock once per projection while preserving lineage, uncertain counts and exact catalog ownership', () => {
  const entities = Object.fromEntries(Array.from({ length: 24 }, (_, at) => [`item-${at}`, { ...catalog.entities.item!, id: asId<EntityId>(`item-${at}`), name: `Synthetic item ${at}` }]))
  const source: CatalogSnapshot = { ...catalog, entities }
  const other: CatalogSnapshot = { ...source, id: asId<CatalogId>('different-synthetic-source') }
  const item = (at: number) => ({ ...ref, entityId: entities[`item-${at}`]!.id })
  let data = createTestLocalData()
  for (const [at, quantity] of [{ kind: 'exact' as const, value: 2 }, { kind: 'atLeast' as const, value: 3 }, { kind: 'unknown' as const }, { kind: 'exact' as const, value: 0 }].entries()) {
    data = observeInventory(data, { ref: item(at), possession: at === 2 ? 'unknown' : at === 3 ? 'notOwned' : 'owned', quantity, now: TEST_NOW })
  }
  const saved = savedCatalogVersion(data, [source], { sourceRef: item(0), now: TEST_NOW })
  data = saved.localData
  const positions = Object.values(data.playthroughs[data.selectedPlaythroughId!]!.inventory)
  let referenceReads = 0
  for (const position of positions) {
    const value = position.ref
    Object.defineProperty(position, 'ref', { enumerable: true, get: () => { referenceReads++; return value } })
  }
  const options = buildDefinitionOptions(data, [source, other])
  const own = (at: number) => options.find(option => option.ref.kind === 'catalog' && option.ref.catalogId === source.id && option.ref.entityId === item(at).entityId)!
  expect([own(0).stockLabel, own(1).stockLabel, own(2).stockLabel, own(3).stockLabel, own(4).stockLabel]).toEqual(['2 recorded owned', '3+ recorded owned; total uncertain', 'Ownership or count uncertain', 'Recorded not owned', 'Stock unrecorded'])
  expect(options.find(option => option.ref.kind === 'personal' && option.ref.definitionId === saved.ref.definitionId)!.stockLabel).toBe('2 recorded owned')
  expect(options.filter(option => option.ref.kind === 'catalog' && option.ref.catalogId === other.id).every(option => option.stockLabel === 'Stock unrecorded')).toBe(true)
  expect(referenceReads).toBe(positions.length)
})
