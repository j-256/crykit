import { savedCatalogVersion } from '../domain/legacy-definition.test-helpers'
import { expect, it } from 'vitest'
import { asTimestamp } from '../domain/core'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { createBlankLocalData } from '../interchange/util'
import { buildDefinitionOptions } from './definitions'
import { buildModLibraryCards } from './mod-library-data'

it('keeps personal observations linked to an earlier project source while browsing its updated catalog', async () => {
  const source = (name: string) => new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-manual-lineage', Title: 'Synthetic lineage mod', EditorVersion: 34, Equipment: [{ ID: 9000, Name: name }] }))
  const earlier = { ...(await previewCrystalEdit(source('Synthetic earlier item'), 'earlier.json')).proposed.catalogs[0]!, importedAt: asTimestamp('2026-01-01T00:00:00Z') }
  const latest = { ...(await previewCrystalEdit(source('Synthetic updated item'), 'latest.json')).proposed.catalogs[0]!, importedAt: asTimestamp('2026-01-02T00:00:00Z') }
  const ref = { kind: 'catalog' as const, catalogId: earlier.id, catalogRevisionId: earlier.revisionId, entityId: Object.values(earlier.entities)[0]!.id }
  const observation = savedCatalogVersion(createBlankLocalData('Synthetic observations'), [earlier], { sourceRef: ref, name: 'Synthetic observed item' })
  const before = JSON.stringify(observation.localData)
  const catalogs = [earlier, latest]
  const cards = buildModLibraryCards(catalogs, buildDefinitionOptions(observation.localData, catalogs), observation.localData)
  expect(cards.find(card => card.project?.id === latest.id)?.entryCount).toBe(2)
  const temporaryCards = buildModLibraryCards(catalogs, buildDefinitionOptions(observation.localData, [latest]), observation.localData)
  expect(temporaryCards.find(card => card.project?.id === latest.id)?.entryCount).toBe(2)
  expect(JSON.stringify(observation.localData)).toBe(before)
})
