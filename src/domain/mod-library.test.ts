import { expect, it } from 'vitest'
import { SYNTHETIC_BUNDLED_MOD, SYNTHETIC_MOD_SNAPSHOT } from '../catalog/mod.test-helpers'
import { buildBundledModEntities } from './bundled-mods'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
const BUNDLED_MOD_LIBRARY = [SYNTHETIC_BUNDLED_MOD]
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { completeModLibrary, modLibraryCards, modCardIncludesEntry } from './mod-library'
import { bundledModReplacementLinks, composeModLayers, prepareModComposition } from './mod-layers'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { asTimestamp } from './core'
import type { CatalogId } from './types'

const imported = async (id: string, extra: object) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: id, Title: 'Synthetic renamed update', Version: 'synthetic-next', EditorVersion: 34, ...extra })), 'synthetic-update.json')).proposed.catalogs[0]!

it('unifies curated catalog names with full sources and includes mods without JSON', async () => {
  const bundled = SYNTHETIC_BUNDLED_MOD
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { Equipment: [{ ID: 9000, Name: 'Synthetic equipment' }] })
  const library = completeModLibrary([update], [bundled])
  const entry = { key: 'original', name: 'Synthetic Library', sourceIds: [] }
  const entries = [entry, { key: 'updated', projectId: update.id, sourceIds: [] }, { key: 'manual', name: 'Renamed manual item', projectId: update.id, sourceIds: [] }, { key: 'doge', name: 'Doge Shield', sourceIds: [] }]
  const before = JSON.stringify(library)
  const cards = modLibraryCards(library, ['Synthetic Library', 'Doge Shield', 'Missing mod'], entries)
  expect(cards.find(card => card.project?.id === update.id)).toMatchObject({ title: 'Synthetic renamed update', entryCount: 3 })
  expect(cards.filter(card => card.catalogNames.includes('Synthetic Library'))).toHaveLength(1)
  expect(cards.find(card => card.title === 'Doge Shield')?.entryCount).toBe(1)
  expect(cards.find(card => card.title === 'Doge Shield')?.project).toBeUndefined()
  expect(cards.find(card => card.title === 'Missing mod')?.entryCount).toBe(0)
  expect(JSON.stringify(library)).toBe(before)
})

it('keeps same-name imports and ambiguous curated names separate from manual records', async () => {
  const update = await imported('synthetic-foreign', { Title: 'Doge Shield', Equipment: [{ ID: 9000, Name: 'Synthetic unrelated item' }] })
  const cards = modLibraryCards(completeModLibrary([update], []), ['Doge Shield'], [{ key: 'manual', name: 'Doge Shield', sourceIds: [] }, { key: 'foreign', projectId: update.id, sourceIds: [] }])
  expect(cards.filter(card => card.title === 'Doge Shield')).toHaveLength(2)
  expect(cards.map(card => card.entryCount)).toEqual([1, 1])
  expect(modCardIncludesEntry(cards.find(card => card.project)!, { key: 'manual', name: 'Doge Shield', sourceIds: [] })).toBe(false)
  const bundled = SYNTHETIC_BUNDLED_MOD
  const ambiguous = modLibraryCards(completeModLibrary([], [bundled, { ...bundled, id: 'crystal-edit:synthetic-other' as CatalogId }]), ['Synthetic Library'], [{ key: 'manual', name: 'Synthetic Library', sourceIds: [] }])
  expect(ambiguous.find(card => !card.project)?.entryCount).toBe(1)
  expect(ambiguous.filter(card => card.project).every(card => card.entryCount === 0)).toBe(true)
})

it('recognizes effective source references while explicit project bindings take precedence', async () => {
  const update = await imported('synthetic-effective', { Equipment: [{ ID: 9000, Name: 'Synthetic source' }] })
  const sourceIds = Object.values(update.entities)[0]!.sources.map(source => source.sourceId)
  const card = modLibraryCards(completeModLibrary([update], []), [], [])[0]!
  expect(modCardIncludesEntry(card, { key: 'effective', sourceIds })).toBe(true)
  expect(modCardIncludesEntry(card, { key: 'explicit', projectId: 'crystal-edit:other' as CatalogId, sourceIds })).toBe(false)
})

it('counts the latest source revision and unversioned personal entries without mixing earlier snapshots', async () => {
  const earlier = { ...await imported('synthetic-versions', { Equipment: [{ ID: 9000, Name: 'Synthetic earlier item' }] }), importedAt: asTimestamp('2026-01-01T00:00:00Z') }
  const latest = { ...await imported('synthetic-versions', { Equipment: [{ ID: 9001, Name: 'Synthetic latest item' }] }), importedAt: asTimestamp('2026-01-02T00:00:00Z') }
  const earlierSourceIds = Object.values(earlier.entities)[0]!.sources.map(source => source.sourceId)
  const entries = [{ key: 'earlier', projectId: earlier.id, projectRevisionId: earlier.revisionId, sourceIds: [] }, { key: 'latest', projectId: latest.id, projectRevisionId: latest.revisionId, sourceIds: [] }, { key: 'manual', projectId: latest.id, sourceIds: [] }, { key: 'earlier-effective', name: 'Synthetic renamed update', sourceIds: earlierSourceIds }]
  const cards = modLibraryCards(completeModLibrary([latest, earlier], []), [], entries)
  expect(cards).toHaveLength(1)
  expect(cards[0]?.entryCount).toBe(2)
  expect(modCardIncludesEntry(cards[0]!, entries[0]!)).toBe(false)
  expect(modCardIncludesEntry(cards[0]!, entries[3]!)).toBe(false)
})

it('groups bundled and saved revisions by project ID while retaining all originals', async () => {
  const bundled = SYNTHETIC_BUNDLED_MOD
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { Equipment: [{ ID: 266, Name: 'Synthetic updated item' }] })
  const library = completeModLibrary([update, DEFAULT_CATALOG], [bundled, { ...bundled, sourceDigest: 'sha256:synthetic-earlier' }])
  expect(library).toHaveLength(1)
  expect(library[0]?.title).toBe('Synthetic renamed update')
  expect(library[0]?.bundled).toHaveLength(2)
  expect(library[0]?.revisions[0]?.catalog).toEqual(update)
  expect(completeModLibrary([], [bundled])[0]?.revisions).toEqual([])
})

it('links updates by verified project, family and ID without relying on names', async () => {
  const bundled = SYNTHETIC_BUNDLED_MOD
  const target = buildBundledModEntities(SYNTHETIC_MOD_SNAPSHOT, NATIVE_GAME_DATA.enums)['mod:synthetic-library:equipment:9000']!
  const baseline = { ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [target.id]: target } }
  const id = target.fields['Crystal Edit model ID']!
  const family = target.fields['Crystal Edit model type']!
  expect(id.state).toBe('known'); expect(family.state).toBe('known')
  const record = { ID: id.state === 'known' ? id.value : -1, Name: 'Synthetic renamed equipment' }
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { [family.state === 'known' ? String(family.value) : 'Equipment']: [record] })
  const links = bundledModReplacementLinks(baseline, update, BUNDLED_MOD_LIBRARY)
  const historicalLinks = [{ modelKey: `crystal-edit:${family.state === 'known' ? family.value : ''}:${record.ID}`, targetEntityId: target.id }]
  expect(links).toEqual([{ ...historicalLinks[0], projectId: update.id }])
  const before = JSON.stringify(baseline)
  const catalogs = [baseline, update]
  const composition = { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: update.id, catalogRevisionId: update.revisionId, enabled: true }], links }
  const prepared = prepareModComposition(composition, catalogs)
  expect(prepared.version).toBe(3)
  expect(prepared.links).toEqual(links)
  const result = composeModLayers(prepared, catalogs)
  expect(result.entities[target.id]?.name).toBe(record.Name)
  for (const version of [undefined, 2] as const) {
    const historical = { ...composition, version, links: historicalLinks }
    const saved = JSON.stringify(historical)
    expect(composeModLayers(historical, catalogs).entities[target.id]?.name).toBe(record.Name)
    expect(JSON.stringify(historical)).toBe(saved)
    expect(() => composeModLayers({ ...historical, links }, catalogs)).toThrow('selected version 3 layer')
  }
  expect(JSON.stringify(baseline)).toBe(before)
  expect(bundledModReplacementLinks(baseline, { ...update, id: 'crystal-edit:unrelated' as CatalogId }, BUNDLED_MOD_LIBRARY)).toEqual([])
})

it('preserves innate kinds when replacing exported innate passives and links dated class records', async () => {
  const bundled = { ...SYNTHETIC_BUNDLED_MOD, models: { Jobs: [0], Passives: [10] }, nativeBaseReplacements: true };
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { Jobs: [{ ID: 0, Name: 'Synthetic revised Warrior' }], Passives: [{ ID: 10, Name: 'Synthetic revised innate', IsInnate: true, PP: 0 }] })
  const links = bundledModReplacementLinks(DEFAULT_CATALOG, update, [bundled])
  expect(links).toContainEqual({ modelKey: 'crystal-edit:Jobs:0', targetEntityId: 'base:job:0' })
  const innate = links.find(link => link.modelKey === 'crystal-edit:Passives:10')!
  expect(innate).toBeDefined()
  const result = composeModLayers({ baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: update.id, catalogRevisionId: update.revisionId, enabled: true }], links }, [DEFAULT_CATALOG, update])
  expect(result.entities[innate.targetEntityId!]?.kind).toBe('innate')
  expect(result.entities[innate.targetEntityId!]?.name).toBe('Synthetic revised innate')
})
