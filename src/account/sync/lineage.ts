import { entityDefinitionKey } from '../../domain/core'
import { definitionLineageRootRef } from '../../domain/definitions'
import type { EntityRef, LocalData, PersonalDefinition } from '../../domain/types'
import { SyncError } from './client'

export const personalLineageKey = (root: EntityRef): string => JSON.stringify(['personal-lineage', entityDefinitionKey(root)])

// Distinct immutable leaf IDs are alternatives in one native lineage, never independent additions
export function personalLineageChains(localData: LocalData): ReadonlyMap<string, readonly PersonalDefinition[]> {
  const groups = new Map<string, PersonalDefinition[]>()
  for (const definition of Object.values(localData.personalDefinitions)) {
    const root = definitionLineageRootRef(localData, { kind: 'personal', definitionId: definition.id })
    const key = personalLineageKey(root)
    const group = groups.get(key) ?? []
    group.push(definition); groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.revision - b.revision)
    for (let index = 0; index < group.length; index++) {
      const item = group[index], previous = group[index - 1]
      if (previous ? item.previousRevision?.definitionId !== previous.id || item.revision !== previous.revision + 1 || item.kind !== previous.kind : item.previousRevision !== undefined || (item.baseRef?.kind === 'catalog' ? item.revision !== 1 : item.baseRef !== undefined)) throw new SyncError('INTEGRITY_FAILED')
    }
  }
  return groups
}
