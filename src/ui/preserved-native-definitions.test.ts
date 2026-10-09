import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { buildDefinitionOptions, definitionOptionsForSetup } from './definitions'
import { asId } from '../domain/core'
import { resolveDefinition } from '../domain/definitions'
import { MOD_CATALOG_SCHEMA, modCatalogRevision } from '../domain/mod-layers'
import { createTestLocalData } from '../domain/test-helpers'
import type { CatalogRef, CatalogSnapshot, CatalogId, CatalogRevisionId, EntityId } from '../domain/types'
import { HISTORICAL_BUNDLED_CATALOG } from '../domain/withdrawn-catalogs'
import { resolveEntity } from './model'
import { nativeIdentity } from '../domain/native-game'
import receipts from '../catalog/preserved-native-definitions.json' with { type: 'json' }

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
    // Rogue's old baseline contains mod changes and was not admitted by the complete-record comparison
    expect(resolveDefinition(localData, [CURRENT_CATALOG], ref('base:job:2'))).toBeUndefined()
    expect(JSON.stringify(localData)).toBe(before)
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
