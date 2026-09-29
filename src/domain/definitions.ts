import { entityDefinitionKey, entityRefKey } from './core'
import type {
  CatalogEntity,
  CatalogSnapshot,
  EntityRef,
  PersonalDefinition,
  PersonalRef,
  LocalData,
} from './types'

export type ResolvedDefinition = CatalogEntity | PersonalDefinition

export function personalDefinitionRef(definition: PersonalDefinition): PersonalRef {
  return { kind: 'personal', definitionId: definition.id }
}

export function resolveDefinition(
  localData: LocalData,
  catalogs: readonly CatalogSnapshot[],
  ref: EntityRef,
): ResolvedDefinition | undefined {
  if (ref.kind === 'personal') return localData.personalDefinitions[ref.definitionId]
  return catalogs
    .find((catalog) => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)
    ?.entities[ref.entityId]
}

export function definitionLineageRootRef(localData: LocalData, ref: EntityRef): EntityRef {
  let current = ref
  const visited = new Set<string>()
  while (current.kind === 'personal') {
    if (visited.has(current.definitionId)) return current
    visited.add(current.definitionId)
    const definition = localData.personalDefinitions[current.definitionId]
    if (!definition?.baseRef) return current
    current = definition.baseRef
  }
  return current
}

export function logicalEntityRef(localData: LocalData, ref: EntityRef): EntityRef {
  return definitionLineageRootRef(localData, ref)
}

export function logicalEntityKey(localData: LocalData, ref: EntityRef): string {
  return entityRefKey(logicalEntityRef(localData, ref))
}

export function sameLogicalEntity(localData: LocalData, left: EntityRef, right: EntityRef): boolean {
  return logicalEntityKey(localData, left) === logicalEntityKey(localData, right)
}

function compareDefinitions(left: PersonalDefinition, right: PersonalDefinition): number {
  return left.revision - right.revision ||
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.id.localeCompare(right.id)
}

export function preferredDefinitionRef(localData: LocalData, ref: EntityRef): EntityRef {
  const rootKey = entityDefinitionKey(definitionLineageRootRef(localData, ref))
  let preferred: PersonalDefinition | undefined
  for (const definition of Object.values(localData.personalDefinitions)) {
    const candidateRef = personalDefinitionRef(definition)
    if (entityDefinitionKey(definitionLineageRootRef(localData, candidateRef)) !== rootKey) continue
    if (!preferred || compareDefinitions(preferred, definition) < 0) preferred = definition
  }
  return preferred ? personalDefinitionRef(preferred) : ref
}

export function preferredPersonalDefinitions(localData: LocalData): readonly PersonalDefinition[] {
  const preferred = new Map<string, PersonalDefinition>()
  for (const definition of Object.values(localData.personalDefinitions)) {
    const ref = personalDefinitionRef(definition)
    const rootKey = entityDefinitionKey(definitionLineageRootRef(localData, ref))
    const current = preferred.get(rootKey)
    if (!current || compareDefinitions(current, definition) < 0) preferred.set(rootKey, definition)
  }
  return [...preferred.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )
}
