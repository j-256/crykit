import { entityDefinitionKey, entityRefKey } from './core'
import type {
  CatalogEntity,
  CatalogSnapshot,
  EntityRef,
  PersonalDefinition,
  PersonalRef,
  Profile,
} from './types'

export type ResolvedDefinition = CatalogEntity | PersonalDefinition

export function personalDefinitionRef(definition: PersonalDefinition): PersonalRef {
  return { kind: 'personal', definitionId: definition.id }
}

export function resolveDefinition(
  profile: Profile,
  catalogs: readonly CatalogSnapshot[],
  ref: EntityRef,
): ResolvedDefinition | undefined {
  if (ref.kind === 'personal') return profile.personalDefinitions[ref.definitionId]
  return catalogs
    .find((catalog) => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)
    ?.entities[ref.entityId]
}

export function definitionLineageRootRef(profile: Profile, ref: EntityRef): EntityRef {
  let current = ref
  const visited = new Set<string>()
  while (current.kind === 'personal') {
    if (visited.has(current.definitionId)) return current
    visited.add(current.definitionId)
    const definition = profile.personalDefinitions[current.definitionId]
    if (!definition?.baseRef) return current
    current = definition.baseRef
  }
  return current
}

export function logicalEntityRef(profile: Profile, ref: EntityRef): EntityRef {
  return definitionLineageRootRef(profile, ref)
}

export function logicalEntityKey(profile: Profile, ref: EntityRef): string {
  return entityRefKey(logicalEntityRef(profile, ref))
}

export function sameLogicalEntity(profile: Profile, left: EntityRef, right: EntityRef): boolean {
  return logicalEntityKey(profile, left) === logicalEntityKey(profile, right)
}

function compareDefinitions(left: PersonalDefinition, right: PersonalDefinition): number {
  return left.revision - right.revision ||
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.id.localeCompare(right.id)
}

export function preferredDefinitionRef(profile: Profile, ref: EntityRef): EntityRef {
  const rootKey = entityDefinitionKey(definitionLineageRootRef(profile, ref))
  let preferred: PersonalDefinition | undefined
  for (const definition of Object.values(profile.personalDefinitions)) {
    const candidateRef = personalDefinitionRef(definition)
    if (entityDefinitionKey(definitionLineageRootRef(profile, candidateRef)) !== rootKey) continue
    if (!preferred || compareDefinitions(preferred, definition) < 0) preferred = definition
  }
  return preferred ? personalDefinitionRef(preferred) : ref
}

export function preferredPersonalDefinitions(profile: Profile): readonly PersonalDefinition[] {
  const preferred = new Map<string, PersonalDefinition>()
  for (const definition of Object.values(profile.personalDefinitions)) {
    const ref = personalDefinitionRef(definition)
    const rootKey = entityDefinitionKey(definitionLineageRootRef(profile, ref))
    const current = preferred.get(rootKey)
    if (!current || compareDefinitions(current, definition) < 0) preferred.set(rootKey, definition)
  }
  return [...preferred.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )
}
