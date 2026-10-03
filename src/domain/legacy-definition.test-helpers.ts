import { createId } from './core'
import { definitionLineageRootRef, personalDefinitionRef, resolveDefinition } from './definitions'
import { createPersonalDefinition } from './local-data'
import type { CatalogSnapshot, EntityRef, LocalData, PersonalDefinition, PersonalDefinitionId, Timestamp } from './types'

// Model a saved catalog version from an older backup without exposing catalog cloning in the app
export function savedCatalogVersion(
  localData: LocalData,
  catalogs: readonly CatalogSnapshot[],
  input: { sourceRef: EntityRef; id?: PersonalDefinitionId; name?: string; aliases?: readonly string[]; fields?: PersonalDefinition['fields']; rawDescription?: string; now?: Timestamp | string },
) {
  const source = resolveDefinition(localData, catalogs, input.sourceRef)
  if (!source) throw new Error('Missing synthetic source definition')
  const id = input.id ?? createId<PersonalDefinitionId>('saved-definition')
  const created = createPersonalDefinition(localData, { ...source, id, name: input.name ?? source.name, aliases: input.aliases ?? source.aliases, fields: { ...source.fields, ...input.fields }, rawDescription: input.rawDescription ?? source.rawDescription, now: input.now })
  const definition = {
    ...created.personalDefinitions[id]!,
    revision: 'revision' in source ? source.revision + 1 : 1,
    baseRef: definitionLineageRootRef(localData, input.sourceRef),
    ...(input.sourceRef.kind === 'personal' ? { previousRevision: input.sourceRef } : {}),
  }
  return { localData: { ...created, personalDefinitions: { ...created.personalDefinitions, [id]: definition } }, definition, ref: personalDefinitionRef(definition) }
}
