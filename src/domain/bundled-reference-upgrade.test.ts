import { expect, it } from 'vitest'
import { BUNDLED_SOURCE_ENTITY_IDS, DEFAULT_CATALOG, compileBundledSourceId } from '../catalog/bundled'
import { createPersonalDefinition } from './local-data'
import { createSampleLocalData } from './sample-data'
import { upgradeBundledReferences } from './bundled-reference-upgrade'
import type { EntityId, LocalData } from './types'

it('retains opaque source fields, original notes, unknown values, and unrelated catalog pins', () => {
  const data = createPersonalDefinition(createSampleLocalData(DEFAULT_CATALOG), { name: 'Synthetic unknown definition', kind: 'item' })
  const definitionId = Object.keys(data.personalDefinitions)[0]!
  const definition = data.personalDefinitions[definitionId]!
  const oldRef = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:class:warrior' as EntityId }
  const revisionId = Object.keys(data.buildRevisions)[0]!
  const revision = data.buildRevisions[revisionId]!
  const historical: LocalData = { ...data, personalDefinitions: { ...data.personalDefinitions, [definitionId]: { ...definition, fields: { 'Synthetic source field': { state: 'known', value: oldRef } } } }, buildRevisions: { ...data.buildRevisions, [revisionId]: { ...revision, note: 'base:class:warrior', content: { ...revision.content, primaryClass: oldRef, calculation: { level: null, growth: [{ classRef: oldRef, levels: null }], bonuses: [], statuses: [] } } } } }
  const result = upgradeBundledReferences(historical, DEFAULT_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)
  expect(result.personalDefinitions).toBe(historical.personalDefinitions)
  expect(result.buildRevisions[revisionId]!.note).toBe('base:class:warrior')
  expect(result.buildRevisions[revisionId]!.content.primaryClass).toEqual({ ...oldRef, entityId: compileBundledSourceId(oldRef.entityId) })
  expect(result.buildRevisions[revisionId]!.content.calculation?.growth).toEqual([{ classRef: result.buildRevisions[revisionId]!.content.primaryClass, levels: null }])
  const imported = { ...historical, buildRevisions: { ...historical.buildRevisions, [revisionId]: { ...historical.buildRevisions[revisionId]!, content: { ...historical.buildRevisions[revisionId]!.content, primaryClass: { ...oldRef, catalogId: 'synthetic:independent' as typeof oldRef.catalogId }, calculation: undefined } } } }
  expect(upgradeBundledReferences(imported, DEFAULT_CATALOG, BUNDLED_SOURCE_ENTITY_IDS).buildRevisions[revisionId]!.content.primaryClass).toBe(imported.buildRevisions[revisionId]!.content.primaryClass)
  expect(upgradeBundledReferences(data, DEFAULT_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)).toBe(data)
})

it('rejects character record key collisions without dropping either observation', () => {
  const data = createSampleLocalData(DEFAULT_CATALOG)
  const playthroughId = data.selectedPlaythroughId!
  const playthrough = data.playthroughs[playthroughId]!
  const characterId = Object.keys(playthrough.characters)[0]!
  const character = playthrough.characters[characterId]!
  const progress = Object.values(character.classProgress)[0]!
  const oldRef = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:class:warrior' as EntityId }
  const historical = { ...data, playthroughs: { ...data.playthroughs, [playthroughId]: { ...playthrough, characters: { ...playthrough.characters, [characterId]: { ...character, classProgress: { ...character.classProgress, historical: { ...progress, classRef: oldRef } } } } } } }
  expect(() => upgradeBundledReferences(historical, DEFAULT_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)).toThrow('merge distinct character records')
  expect(historical.playthroughs[playthroughId]!.characters[characterId]!.classProgress.historical).toEqual({ ...progress, classRef: oldRef })
})

it('upgrades reviewed composition targets only for the exact bundled baseline', () => {
  const data = createSampleLocalData(DEFAULT_CATALOG)
  const setupId = data.planningGameSetupRevisionId!
  const setup = data.gameSetups[setupId]!
  const sourceId = 'base:class:warrior' as EntityId
  const composition = { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [], links: [{ modelKey: 'crystal-edit:Jobs:0', targetEntityId: sourceId }, { modelKey: 'crystal-edit:Jobs:9000', targetEntityId: null }] }
  const historical = { ...data, gameSetups: { ...data.gameSetups, [setupId]: { ...setup, modComposition: composition } } }
  const upgraded = upgradeBundledReferences(historical, DEFAULT_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)
  expect(upgraded.gameSetups[setupId]!.modComposition).toEqual({ ...composition, links: [{ ...composition.links[0], targetEntityId: compileBundledSourceId(sourceId) }, composition.links[1]] })
  expect(historical.gameSetups[setupId]!.modComposition).toBe(composition)
  const independent = { ...historical, gameSetups: { ...historical.gameSetups, [setupId]: { ...setup, modComposition: { ...composition, baseline: { ...composition.baseline, catalogRevisionId: 'synthetic:independent' as typeof DEFAULT_CATALOG.revisionId } } } } }
  expect(upgradeBundledReferences(independent, DEFAULT_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)).toBe(independent)
})
