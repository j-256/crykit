import { expect, it } from 'vitest'
import { saveSelectionContext } from './save-context'
import { createSampleLocalData } from '../domain/sample-data'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import type { BuildRevisionContent, PersonalDefinition } from '../domain/types'
it('records exact personal chains without binding unrelated definitions to a native choice', () => {
  const data = createSampleLocalData(DEFAULT_CATALOG, '2026-01-01T00:00:00.000Z')
  const root = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:equipment:0' as never }
  const ref = { kind: 'personal' as const, definitionId: 'personal' as never }
  const definition: PersonalDefinition = { id: ref.definitionId, name: 'Recorded name', baseRef: root, revision: 1, kind: 'item', aliases: [], fields: {}, sources: [], createdAt: data.createdAt, updatedAt: data.createdAt }
  const native: BuildRevisionContent = { primaryClass: null, secondaryClass: null, equipment: { hand: { ref: root } }, passives: [], contextAssumptions: [] }
  const personal = { ...native, equipment: { hand: { ref } } }
  const withDefinition = { ...data, personalDefinitions: { personal: definition } }
  expect(saveSelectionContext(data, native)).toEqual(saveSelectionContext(withDefinition, native))
  const recorded = saveSelectionContext(withDefinition, personal)
  expect(recorded).not.toEqual(saveSelectionContext(data, personal))
  expect(recorded).not.toEqual(saveSelectionContext({ ...withDefinition, personalDefinitions: { personal: { ...definition, name: 'Changed name' } } }, personal))
})
