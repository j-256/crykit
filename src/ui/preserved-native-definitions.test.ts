import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { buildDefinitionOptions, definitionOptionsForSetup } from './definitions'
import { asId } from '../domain/core'
import { resolveDefinition } from '../domain/definitions'
import { MOD_CATALOG_SCHEMA, modCatalogRevision } from '../domain/mod-layers'
import { createTestLocalData } from '../domain/test-helpers'
import type { BuildRevisionContent, CatalogRef, CatalogSnapshot, CatalogId, CatalogRevisionId, EntityId } from '../domain/types'
import { HISTORICAL_BUNDLED_CATALOG } from '../domain/withdrawn-catalogs'
import { resolveEntity } from './model'
import { nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import receipts from '../catalog/preserved-native-definitions.json' with { type: 'json' }
import factReceipts from '../catalog/native-mod-fact-receipts.json' with { type: 'json' }
import { CLASS_FIELDS } from '../domain/crystal-edit'
import { validateBuildContent } from '../domain/build-validity'
import { collectEffectiveModifiers } from '../domain/effective-modifiers'
import { innateEffects } from '../domain/build-mechanics'
import { previewAbilityGroups } from './preview-ability-groups'

function fixture() {
  const data = createTestLocalData()
  const original = Object.values(data.gameSetups)[0]!
  const sourceId = asId<CatalogId>('crystal-edit:synthetic-native-replacement')
  const checksum = `sha256:${'0'.repeat(64)}`
  const sourceRevision = asId<CatalogRevisionId>(`${checksum}:rules-v2:library-v2`)
  const setup = { ...original, catalogLock: { [CURRENT_CATALOG.id]: modCatalogRevision(original.id) }, modComposition: { version: 2 as const, baseline: { catalogId: HISTORICAL_BUNDLED_CATALOG.id, catalogRevisionId: HISTORICAL_BUNDLED_CATALOG.revisionId }, layers: [{ catalogId: sourceId, catalogRevisionId: sourceRevision, enabled: true }], links: [{ modelKey: 'crystal-edit:Passives:20', targetEntityId: asId<EntityId>('base:innate:ref-53') }] }, modSourceReceipts: [{ catalogId: sourceId, catalogRevisionId: sourceRevision, checksum, title: 'Synthetic Native Replacement' }] }
  const localData = { ...data, planningGameSetupRevisionId: setup.id, gameSetups: { ...data.gameSetups, [setup.id]: setup } }
  const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: modCatalogRevision(setup.id), entityId: asId<EntityId>(id) })
  return { localData, setup, ref }
}

describe('preserved native definitions', () => {
  it('binds the reviewed entry identities to available native bytes and the withdrawn baseline receipt', () => {
    expect(receipts.source).toEqual(HISTORICAL_BUNDLED_CATALOG)
    expect(receipts.equivalent).toEqual({ id: CURRENT_CATALOG.id, revisionId: CURRENT_CATALOG.revisionId, checksum: CURRENT_CATALOG.checksum })
    expect(new Set(receipts.entityIds).size).toBe(receipts.entityIds.length)
    for (const id of receipts.entityIds) expect(nativeIdentity(CURRENT_CATALOG.entities[id]!)?.mode).toBe('base')
  })

  it('resolves reviewed unchanged entries without rewriting saved pins or substituting mod replacements', () => {
    const { localData, ref } = fixture()
    const before = JSON.stringify(localData)
    for (const id of ['base:equipment:41', 'base:equipment:481', 'base:passive:54', 'base:passive:44']) {
      expect(resolveDefinition(localData, [CURRENT_CATALOG], ref(id))).toBe(CURRENT_CATALOG.entities[id])
      expect(resolveEntity(localData, [CURRENT_CATALOG], ref(id))).toBe(CURRENT_CATALOG.entities[id])
    }
    // The linked innate alias and native passive share an identity, so both require the missing source
    expect(resolveDefinition(localData, [CURRENT_CATALOG], ref('base:passive:20'))).toBeUndefined()
    expect(resolveDefinition(localData, [CURRENT_CATALOG], ref('base:innate:ref-53'))).toBeUndefined()
    // Auxiliary mod learning annotations do not change the baseline's native class facts
    expect(resolveDefinition(localData, [CURRENT_CATALOG], ref('base:job:2'))?.name).toBe('Rogue')
    expect(JSON.stringify(localData)).toBe(before)
  })

  function learningFixture() {
    const { localData, setup, ref } = fixture()
    const source = factReceipts.sources.find(source => Object.hasOwn(source.records, 'crystal-edit:Jobs:2'))!
    const catalogId = asId<CatalogId>(source.catalogId)
    const catalogRevisionId = asId<CatalogRevisionId>(`${source.checksum}:${source.interpretations[0]}`)
    const next = { ...setup, modComposition: { ...setup.modComposition, layers: [{ catalogId, catalogRevisionId, enabled: true }], links: [{ modelKey: 'crystal-edit:Jobs:2', targetEntityId: ref('base:job:2').entityId }, { modelKey: 'crystal-edit:Passives:17', targetEntityId: ref('base:passive:17').entityId }] }, modSourceReceipts: [{ catalogId, catalogRevisionId, checksum: source.checksum, title: 'Learnable Innate Skills' }] }
    const data = { ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: next } }
    const resolve = (value: Parameters<typeof resolveDefinition>[2]) => resolveDefinition(data, [CURRENT_CATALOG], value)
    const content: BuildRevisionContent = { primaryClass: null, secondaryClass: ref('base:job:2'), equipment: {}, passives: [], contextAssumptions: [] }
    return { localData: data, setup: next, ref, resolve, content }
  }

  it('binds partial fact receipts to exact native bytes without retaining mod values', () => {
    expect(factReceipts.source).toEqual(receipts.source)
    expect(factReceipts.equivalent).toEqual(receipts.equivalent)
    for (const id of factReceipts.nativeRecordEntityIds) expect(nativeIdentity(CURRENT_CATALOG.entities[id]!)?.mode).toBe('base')
    for (const source of factReceipts.sources) for (const [modelKey, fields] of Object.entries(source.records)) {
      const [, family, id] = modelKey.split(':')
      const database = ({ Jobs: 'job', Passives: 'passive', Equipment: 'equipment' } as Record<string, string>)[family!]
      const entity = Object.values(CURRENT_CATALOG.entities).find(entity => { const identity = nativeIdentity(entity); return identity?.mode === 'base' && identity.database === database && identity.databaseId === Number(id) })!
      for (const field of fields) expect(Object.hasOwn(nativeSourceRecord(entity)!, field)).toBe(true)
    }
  })

  it('uses unchanged sub-command facts and command children without requiring its modded learning tree', () => {
    const { localData, setup, ref, resolve, content } = learningFixture()
    const before = JSON.stringify(localData)
    const rogue = resolve(ref('base:job:2'))!
    expect(rogue.name).toBe('Rogue')
    for (const key of ['ratings', 'equipment', 'abilities', 'passives', 'command'] as const) expect(rogue.fields[CLASS_FIELDS[key]]).toMatchObject({ state: 'known' })
    expect(rogue.fields[CLASS_FIELDS.tree]?.state).toBe('unknown')
    expect(nativeSourceRecord(rogue)).not.toHaveProperty('LearnTree')
    expect(validateBuildContent(content, setup, [], resolve).issues).toEqual([])
    const groups = previewAbilityGroups(content, localData, [CURRENT_CATALOG], setup)
    expect(groups.map(group => group.label)).toEqual(['Subclass: Rogue'])
    expect(groups[0]!.refs.map(value => resolve(value)?.name)).toContain('Steal')
    expect(groups[0]!.refs).toHaveLength((nativeSourceRecord(rogue)!.AbilityIDs as number[]).length)
    const choices = definitionOptionsForSetup(buildDefinitionOptions(localData, [CURRENT_CATALOG]), [CURRENT_CATALOG], setup)
    expect(choices).toContainEqual(expect.objectContaining({ ref: ref('base:job:2'), record: expect.objectContaining({ name: 'Rogue' }) }))
    expect(JSON.stringify(localData)).toBe(before)
  })

  it('checks an innate as an active child without making its changed learnability a class dependency', () => {
    const { setup, ref, resolve, content } = learningFixture()
    const primary = { ...content, primaryClass: content.secondaryClass, secondaryClass: null }
    expect(innateEffects(primary, resolve).map(effect => effect.definition.name)).toEqual(['Pinpoint'])
    expect(validateBuildContent(primary, setup, [], resolve).issues).toEqual([])
    const equipped = { ...content, passives: [{ ref: ref('base:passive:17') }] }
    expect(validateBuildContent(equipped, setup, [], resolve).issues).toEqual([expect.objectContaining({ code: 'PASSIVE_LEARNABILITY_UNKNOWN', message: expect.stringContaining('Pinpoint') })])
    expect(nativeSourceRecord(resolve(ref('base:passive:17'))!)).not.toHaveProperty('IsLearnable')
  })

  it('leaves unproven innate effects unknown only when that innate is active', () => {
    const { localData, setup, ref } = learningFixture()
    const next = { ...setup, modComposition: { ...setup.modComposition, links: [{ modelKey: 'crystal-edit:Jobs:14', targetEntityId: ref('base:job:14').entityId }, { modelKey: 'crystal-edit:Passives:74', targetEntityId: ref('base:passive:74').entityId }] } }
    const data = { ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: next } }
    const resolve = (value: Parameters<typeof resolveDefinition>[2]) => resolveDefinition(data, [CURRENT_CATALOG], value)
    const content: BuildRevisionContent = { primaryClass: ref('base:job:14'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }
    expect(resolve(content.primaryClass!)?.name).toBe('Warlock')
    expect(resolve(ref('base:passive:74'))?.fields['Stat modifiers']?.state).toBe('unknown')
    expect(validateBuildContent(content, next, [], resolve).issues).toEqual([expect.objectContaining({ code: 'CLASS_INNATE_DEFINITION' })])
    expect(collectEffectiveModifiers(content, [], resolve).unknownFields.has('*')).toBe(true)
    const secondary = { ...content, primaryClass: null, secondaryClass: content.primaryClass }
    expect(validateBuildContent(secondary, next, [], resolve).issues).toEqual([])
    expect(collectEffectiveModifiers(secondary, [], resolve).unknownFields.has('*')).toBe(false)
  })

  it('keeps an unavailable active child unknown in validity and numeric effects while leaving the sub-command usable', () => {
    const { localData, setup, ref } = fixture()
    const next = { ...setup, modComposition: { ...setup.modComposition, links: [{ modelKey: 'crystal-edit:Passives:17', targetEntityId: ref('base:passive:17').entityId }] } }
    const data = { ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: next } }
    const resolve = (value: Parameters<typeof resolveDefinition>[2]) => resolveDefinition(data, [CURRENT_CATALOG], value)
    const content: BuildRevisionContent = { primaryClass: ref('base:job:2'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }
    expect(resolve(content.primaryClass!)?.name).toBe('Rogue')
    expect(validateBuildContent(content, next, [], resolve).issues).toContainEqual(expect.objectContaining({ code: 'CLASS_INNATE_DEFINITION' }))
    expect(collectEffectiveModifiers(content, [], resolve).unknownFields.has('*')).toBe(true)
    const secondary = { ...content, primaryClass: null, secondaryClass: content.primaryClass }
    expect(validateBuildContent(secondary, next, [], resolve).issues).toEqual([])
    expect(collectEffectiveModifiers(secondary, [], resolve).unknownFields.has('*')).toBe(false)
  })

  it('does not accept an unreviewed source revision and respects whole-record override priority', () => {
    const { localData, setup, ref } = learningFixture()
    const unknown = { catalogId: asId<CatalogId>('crystal-edit:synthetic-unknown-class'), catalogRevisionId: asId<CatalogRevisionId>('synthetic-unreviewed'), enabled: true }
    const recover = (layers: typeof setup.modComposition.layers) => resolveDefinition({ ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: { ...setup, modComposition: { ...setup.modComposition, layers } } } }, [CURRENT_CATALOG], ref('base:job:2'))
    expect(recover([unknown, ...setup.modComposition.layers])?.name).toBe('Rogue')
    expect(recover([...setup.modComposition.layers, unknown])).toBeUndefined()
    expect(recover(setup.modComposition.layers.map(layer => ({ ...layer, catalogRevisionId: unknown.catalogRevisionId })))).toBeUndefined()
  })

  it('checks unavailable command children independently of the known native class', () => {
    const { localData, setup, ref } = fixture()
    const next = { ...setup, modComposition: { ...setup.modComposition, links: [{ modelKey: 'crystal-edit:Abilities:37', targetEntityId: ref('base:ability:37').entityId }] } }
    const data = { ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: next } }
    const resolve = (value: Parameters<typeof resolveDefinition>[2]) => resolveDefinition(data, [CURRENT_CATALOG], value)
    const content: BuildRevisionContent = { primaryClass: null, secondaryClass: ref('base:job:2'), equipment: {}, passives: [], contextAssumptions: [] }
    expect(resolve(content.secondaryClass!)?.name).toBe('Rogue')
    expect(validateBuildContent(content, next, [], resolve).issues).toEqual([expect.objectContaining({ code: 'CLASS_COMMAND_DEFINITION', slotId: 'secondary-class' })])
    const groups = previewAbilityGroups(content, data, [CURRENT_CATALOG], next)
    expect(groups.flatMap(group => group.refs).map(value => resolve(value)?.name)).not.toContain('Steal')
  })

  it('exposes the same retained pins to editor choices and excludes unresolved replacements', () => {
    const { localData, setup, ref } = fixture()
    const choices = definitionOptionsForSetup(buildDefinitionOptions(localData, [CURRENT_CATALOG]), [CURRENT_CATALOG], setup)
    for (const id of ['base:equipment:41', 'base:equipment:481', 'base:passive:54', 'base:passive:44']) expect(choices).toContainEqual(expect.objectContaining({ ref: ref(id), record: CURRENT_CATALOG.entities[id] }))
    expect(choices.some(choice => choice.ref.kind === 'catalog' && choice.ref.entityId === 'base:passive:20')).toBe(false)
  })

  it('does not infer revision equivalence or fill a missing entity in an available complete snapshot', () => {
    const { localData, ref } = fixture()
    const selection = ref('base:equipment:41')
    expect(resolveDefinition(localData, [{ ...CURRENT_CATALOG, checksum: 'synthetic-unreviewed' }], selection)).toBeUndefined()
    expect(resolveDefinition(localData, [CURRENT_CATALOG], { ...selection, catalogRevisionId: asId<CatalogRevisionId>('synthetic-unknown-revision') })).toBeUndefined()
    const exact: CatalogSnapshot = { ...CURRENT_CATALOG, revisionId: selection.catalogRevisionId, entities: {} }
    expect(resolveDefinition(localData, [CURRENT_CATALOG, exact], selection)).toBeUndefined()
    const override = { ...CURRENT_CATALOG.entities[selection.entityId]!, name: 'Synthetic exact override' }
    expect(resolveDefinition(localData, [CURRENT_CATALOG, { ...exact, schemaVersion: MOD_CATALOG_SCHEMA, entities: { [override.id]: override } }], selection)).toBe(override)
  })

  it('retains native entries for disabled or explicitly separate replacements but blocks direct targets', () => {
    const { localData, setup, ref } = fixture()
    const separate = { ...setup, modComposition: { ...setup.modComposition, links: [{ ...setup.modComposition.links[0]!, targetEntityId: null }] } }
    expect(resolveDefinition({ ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: separate } }, [CURRENT_CATALOG], ref('base:passive:20'))).toBe(CURRENT_CATALOG.entities['base:passive:20'])
    const disabled = { ...setup, modComposition: { ...setup.modComposition, layers: setup.modComposition.layers.map(layer => ({ ...layer, enabled: false })) } }
    expect(resolveDefinition({ ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: disabled } }, [CURRENT_CATALOG], ref('base:passive:20'))).toBe(CURRENT_CATALOG.entities['base:passive:20'])
    const replaced = { ...setup, modComposition: { ...setup.modComposition, links: [{ modelKey: 'crystal-edit:Equipment:99', targetEntityId: ref('base:equipment:41').entityId }] } }
    expect(resolveDefinition({ ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: replaced } }, [CURRENT_CATALOG], ref('base:equipment:41'))).toBeUndefined()
  })
})
