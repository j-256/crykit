import { expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { buildDefinitionOptions } from './definitions'
import { resolveDefinition } from '../domain/definitions'
import { modCatalogRevision } from '../domain/mod-layers'
import { createTestLocalData } from '../domain/test-helpers'
import type { CatalogRef } from '../domain/types'
import { resolveEntity } from './model'
import { syntheticCatalog } from '../workspace/test-helpers'

it('never supplies current native facts for missing historical sources or incomplete compositions', () => {
  const data = createTestLocalData(), original = Object.values(data.gameSetups)[0]!
  const source = syntheticCatalog('unavailable-mechanical-layer')
  const setup = { ...original, catalogLock: { [CURRENT_CATALOG.id]: modCatalogRevision(original.id) }, modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] } }
  const localData = { ...data, planningGameSetupRevisionId: setup.id, gameSetups: { ...data.gameSetups, [setup.id]: setup } }
  const before = JSON.stringify(localData)
  for (const id of ['base:equipment:41', 'base:passive:20', 'base:job:2']) {
    const exact: CatalogRef = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: id as CatalogRef['entityId'] }
    expect(resolveDefinition(localData, [CURRENT_CATALOG], exact)).toBe(CURRENT_CATALOG.entities[id])
    for (const revision of ['v999', modCatalogRevision(setup.id)]) {
      const missing = { ...exact, catalogRevisionId: revision as CatalogRef['catalogRevisionId'] }
      expect(resolveDefinition(localData, [CURRENT_CATALOG], missing)).toBeUndefined()
      expect(resolveEntity(localData, [CURRENT_CATALOG], missing)).toBeUndefined()
    }
  }
  const choices = buildDefinitionOptions(localData, [CURRENT_CATALOG])
  expect(choices.some(option => option.ref.kind === 'catalog' && option.ref.catalogRevisionId === modCatalogRevision(setup.id))).toBe(false)
  expect(JSON.stringify(localData)).toBe(before)
})
