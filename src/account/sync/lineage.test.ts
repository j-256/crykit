import { expect, it } from 'vitest'
import { createBlankLocalData, createPersonalDefinition, revisePersonalDefinition } from '../../domain/local-data'
import { personalLineageKey, personalLineageChains } from './lineage'
import type { CatalogRef, PersonalDefinitionId } from '../../domain/types'
it('personalLineageGroupsDifferentSuccessorIdsAndKeepsExactCatalogRevisionRoots', () => {
  const base = createPersonalDefinition(createBlankLocalData(), { id: 'root' as PersonalDefinitionId, kind: 'item', name: 'Original' })
  const local = revisePersonalDefinition(base, { sourceRef: { kind: 'personal', definitionId: 'root' as PersonalDefinitionId }, name: 'Local successor' })
  const other = revisePersonalDefinition(base, { sourceRef: { kind: 'personal', definitionId: 'root' as PersonalDefinitionId }, name: 'Remote successor' })
  const a = personalLineageChains(local.localData), b = personalLineageChains(other.localData)
  expect([...a.keys()]).toEqual([...b.keys()])
  expect([...a.values()][0].at(-1)!.id).not.toBe([...b.values()][0].at(-1)!.id)
  const first = { kind: 'catalog', catalogId: 'catalog', catalogRevisionId: 'revision-one', entityId: 'item' } as CatalogRef
  expect(personalLineageKey(first)).not.toBe(personalLineageKey({ ...first, catalogRevisionId: 'revision-two' } as CatalogRef))
  expect(() => personalLineageChains({ ...local.localData, personalDefinitions: { ...local.localData.personalDefinitions, ...other.localData.personalDefinitions } })).toThrow()
})
