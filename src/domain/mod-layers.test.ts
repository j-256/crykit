import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { syntheticModLayers } from './mod-layers.test-helpers'
import { addGameSetupRevision, createBlankLocalData } from './local-data'
import { composeModCatalog, composeModLayers, expandModCatalogs, modEntity } from './mod-layers'
import { growthRatings, CRYSTAL_EDIT_FIELDS } from './crystal-edit'
import { resolveDefinition } from './definitions'
import { innateEffects } from './build-mechanics'
import { effectText } from './mechanics-facts'
import { validateBuildContent } from './build-validity'
import type { BuildRevisionContent, EntityId } from './types'

describe('ordered mod composition', () => {
  it('replaces whole records by native identity without inheriting omitted fields or merging lists', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    const before = JSON.stringify(catalogs)
    const result = composeModLayers(composition, catalogs)
    const warrior = result.entities['base:class:warrior']!
    expect(warrior.name).toBe('Second Fighter')
    expect(growthRatings(warrior)).toEqual({ HP: 0 })
    expect(warrior.fields[CRYSTAL_EDIT_FIELDS.equipment]?.state).toBe('unknown')
    expect(warrior.fields[CRYSTAL_EDIT_FIELDS.abilities]).toMatchObject({ value: [] })
    expect(result.changes.find(value => value.modelKey === 'crystal-edit:Jobs:0')?.superseded).toEqual(['Warrior (bundled)', 'Layer A'])
    expect(result.unresolvedReferences).toEqual([])
    expect(result.entities['crystal-edit:Equipment:50']?.name).toBe('First Sword')
    expect(result.entities['crystal-edit:Items:50']?.name).toBe('Different family')
    expect(JSON.stringify(catalogs)).toBe(before)
  })

  it('supports reordering, disabling, and cross-layer native references without guessing bundled targets', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    const reversed = composeModLayers({ ...composition, layers: [...composition.layers].reverse() }, catalogs)
    expect(reversed.entities['base:class:warrior']?.name).toBe('First Fighter')
    expect(reversed.unresolvedReferences).toEqual([])
    const disabled = composeModLayers({ ...composition, layers: composition.layers.map(layer => ({ ...layer, enabled: layer.catalogId === 'crystal-edit:layer-a' })) }, catalogs)
    expect(disabled.unresolvedReferences).toEqual(['Abilities #8', 'Passives #2'])
    const separate = composeModLayers({ ...composition, links: [] }, catalogs)
    expect(separate.entities['base:class:warrior']?.name).toBe('Warrior')
    expect(separate.changes.find(value => value.modelKey === 'crystal-edit:Jobs:0')?.targetState).toBe('unresolved')
  })

  it('pins effective revisions and resolves linked native aliases through the composed catalog', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    const local = addGameSetupRevision(createBlankLocalData(), { label: 'Layered setup', modComposition: composition })
    const setup = local.gameSetups[local.planningGameSetupRevisionId!]!
    const effective = expandModCatalogs([...catalogs, composeModCatalog(setup, catalogs)!]).at(-1)!
    expect(setup.catalogLock[DEFAULT_CATALOG.id]).toBe(effective.revisionId)
    expect(modEntity(effective, 'crystal-edit:Jobs:0')?.id).toBe('base:class:warrior')
    expect(modEntity(effective, 'crystal-edit:Passives:2')?.name).toBe('Shared Passive')
    expect(effective.entities['base:class:wizard']).toEqual(DEFAULT_CATALOG.entities['base:class:wizard'])
  })

  it('rejects missing revisions, duplicate projects, wrong-kind targets, and ambiguous bundled replacements', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    expect(() => composeModLayers({ ...composition, layers: [composition.layers[0]!, composition.layers[0]!] }, catalogs)).toThrow(/one revision/)
    expect(() => composeModLayers(composition, catalogs.slice(0, 2))).toThrow(/unavailable/)
    expect(() => composeModLayers({ ...composition, links: [{ modelKey: 'crystal-edit:Equipment:50', targetEntityId: 'base:class:warrior' as EntityId }] }, catalogs)).toThrow(/same definition kind/)
    expect(() => composeModLayers({ ...composition, links: [{ modelKey: 'crystal-edit:Jobs:0', targetEntityId: 'missing' as EntityId }] }, catalogs)).toThrow(/must exist/)
    const itemTarget = Object.values(DEFAULT_CATALOG.entities).find(value => value.kind === 'item')!.id
    expect(() => composeModLayers({ ...composition, links: [{ modelKey: 'crystal-edit:Equipment:50', targetEntityId: itemTarget }, { modelKey: 'crystal-edit:Items:50', targetEntityId: itemTarget }] }, catalogs)).toThrow(/same bundled definition/)
  })

  it('uses cross-layer innate descriptions and native PP costs through effective references', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    const local = addGameSetupRevision(createBlankLocalData(), { label: 'Layered setup', modComposition: composition, ppLimit: { state: 'known', value: 1 } })
    const setup = local.gameSetups[local.planningGameSetupRevisionId!]!
    const effectiveCatalogs = expandModCatalogs([...catalogs, composeModCatalog(setup, catalogs)!])
    const ref = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: setup.catalogLock[DEFAULT_CATALOG.id]! }
    const content: BuildRevisionContent = { primaryClass: { ...ref, entityId: 'base:class:warrior' as EntityId }, secondaryClass: null, equipment: {}, passives: [{ ref: { ...ref, entityId: 'crystal-edit:Passives:2' as EntityId } }], contextAssumptions: [] }
    const resolve = (value: Parameters<typeof resolveDefinition>[2]) => resolveDefinition(local, effectiveCatalogs, value)
    expect(innateEffects(content, resolve)).toMatchObject([{ text: 'Equip anything regardless of current Class.', name: 'Second Fighter: Shared Passive' }])
    const innate = innateEffects(content, resolve)[0]!.definition
    expect(effectText({ ...innate, fields: { ...innate.fields, Description: { state: 'unknown' } } })).toBeUndefined()
    expect(validateBuildContent(content, setup, [], resolve)).toMatchObject({ status: 'invalid', pp: { knownSubtotal: 2, unresolvedCosts: 0 }, issues: expect.arrayContaining([expect.objectContaining({ code: 'PP_LIMIT_EXCEEDED' })]) })
  })
})
