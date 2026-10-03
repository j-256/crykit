import { expect, it } from 'vitest'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { completeModLibrary, modLibraryCards, modCardIncludesEntry } from './mod-library'
import { bundledModReplacementLinks, composeModLayers } from './mod-layers'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { asTimestamp } from './core'
import type { CatalogId } from './types'

const imported = async (id: string, extra: object) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: id, Title: 'Synthetic renamed update', Version: 'synthetic-next', EditorVersion: 34, ...extra })), 'synthetic-update.json')).proposed.catalogs[0]!

it('unifies curated catalog names with full sources and includes mods without JSON', async () => {
  const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'equipment-expansion')!
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { Equipment: [{ ID: 9000, Name: 'Synthetic equipment' }] })
  const library = completeModLibrary([update], [bundled])
  const entry = { key: 'original', name: 'Equipment Expansion', sourceIds: [] }
  const entries = [entry, { key: 'updated', projectId: update.id, sourceIds: [] }, { key: 'manual', name: 'Renamed manual item', projectId: update.id, sourceIds: [] }, { key: 'doge', name: 'Doge Shield', sourceIds: [] }]
  const before = JSON.stringify(library)
  const cards = modLibraryCards(library, ['Equipment Expansion', 'Doge Shield', 'Missing mod'], entries)
  expect(cards.find(card => card.project?.id === update.id)).toMatchObject({ title: 'Synthetic renamed update', entryCount: 3 })
  expect(cards.filter(card => card.catalogNames.includes('Equipment Expansion'))).toHaveLength(1)
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
  const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'equipment-expansion')!
  const ambiguous = modLibraryCards(completeModLibrary([], [bundled, { ...bundled, id: 'crystal-edit:synthetic-other' as CatalogId }]), ['Equipment Expansion'], [{ key: 'manual', name: 'Equipment Expansion', sourceIds: [] }])
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
  const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'equipment-expansion')!
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { Equipment: [{ ID: 266, Name: 'Synthetic updated item' }] })
  const library = completeModLibrary([update, DEFAULT_CATALOG], [bundled, { ...bundled, sourceDigest: 'sha256:synthetic-earlier' }])
  expect(library).toHaveLength(1)
  expect(library[0]?.title).toBe('Synthetic renamed update')
  expect(library[0]?.bundled).toHaveLength(2)
  expect(library[0]?.revisions[0]?.catalog).toEqual(update)
  expect(completeModLibrary([], [bundled])[0]?.revisions).toEqual([])
})

it('links updates by verified project, family and ID without relying on names', async () => {
  const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'equipment-expansion')!
  const target = Object.values(DEFAULT_CATALOG.entities).find(entity => entity.legacy && JSON.stringify(entity.legacy).includes('"equipmentExpansion"'))!
  const id = target.fields['Crystal Edit model ID']!
  const family = target.fields['Crystal Edit model type']!
  expect(id.state).toBe('known'); expect(family.state).toBe('known')
  const record = { ID: id.state === 'known' ? id.value : -1, Name: 'Synthetic renamed equipment' }
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { [family.state === 'known' ? String(family.value) : 'Equipment']: [record] })
  const links = bundledModReplacementLinks(DEFAULT_CATALOG, update, BUNDLED_MOD_LIBRARY)
  expect(links).toEqual([{ modelKey: `crystal-edit:${family.state === 'known' ? family.value : ''}:${record.ID}`, targetEntityId: target.id }])
  const before = JSON.stringify(DEFAULT_CATALOG)
  const result = composeModLayers({ baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: update.id, catalogRevisionId: update.revisionId, enabled: true }], links }, [DEFAULT_CATALOG, update])
  expect(result.entities[target.id]?.name).toBe(record.Name)
  expect(JSON.stringify(DEFAULT_CATALOG)).toBe(before)
  expect(bundledModReplacementLinks(DEFAULT_CATALOG, { ...update, id: 'crystal-edit:unrelated' as CatalogId }, BUNDLED_MOD_LIBRARY)).toEqual([])
})

it('preserves innate kinds when replacing exported innate passives and links dated class records', async () => {
  const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'learnable-innates')!
  const update = await imported(bundled.id.replace(/^crystal-edit:/, ''), { Jobs: [{ ID: 0, Name: 'Synthetic revised Warrior' }], Passives: [{ ID: 10, Name: 'Synthetic revised innate', IsInnate: true, PP: 0 }] })
  const links = bundledModReplacementLinks(DEFAULT_CATALOG, update, BUNDLED_MOD_LIBRARY)
  expect(links).toContainEqual({ modelKey: 'crystal-edit:Jobs:0', targetEntityId: 'base:job:0' })
  const innate = links.find(link => link.modelKey === 'crystal-edit:Passives:10')!
  expect(innate).toBeDefined()
  const result = composeModLayers({ baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: update.id, catalogRevisionId: update.revisionId, enabled: true }], links }, [DEFAULT_CATALOG, update])
  expect(result.entities[innate.targetEntityId!]?.kind).toBe('innate')
  expect(result.entities[innate.targetEntityId!]?.name).toBe('Synthetic revised innate')
})
