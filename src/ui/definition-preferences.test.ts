import { expect, it } from 'vitest'
import { asId } from '../domain/core'
import type { CatalogEntity, JsonValue } from '../domain/types'
import type { DefinitionOption } from './definitions'
import { preferredDefinitionChoices } from './definition-preferences'

function choice(id: string, name: string, legacy?: JsonValue): DefinitionOption {
  const record: CatalogEntity = { id: asId(id), kind: 'ability', name, aliases: [], fields: {}, sources: [], ...(legacy ? { legacy } : {}) }
  return { key: id, ref: { kind: 'catalog', catalogId: asId('synthetic'), catalogRevisionId: asId('revision'), entityId: record.id }, kind: record.kind, name, aliases: [], sourceLabel: 'Synthetic source', stockLabel: 'Unknown', preferred: true, record }
}

it('shows base native records and preserves selected modes and independent definitions', () => {
  const native = choice('native-a', 'Synthetic ability', { native: { database: 'ability', databaseId: 1, mode: 'base' } })
  const repeated = choice('native-b', 'Synthetic ability', { native: { database: 'ability', databaseId: 2, mode: 'base' } })
  const imported = choice('imported', 'Synthetic ability')
  const patch = choice('patch', 'Synthetic ability', { native: { database: 'ability', databaseId: 1, mode: 'Chaos' } })
  const independent = choice('independent', 'Synthetic ability')
  const unique = choice('imported-unique', 'Imported only')
  const personal: DefinitionOption = { ...choice('personal', 'Synthetic ability'), ref: { kind: 'personal', definitionId: asId('personal') } }
  const options = [imported, patch, independent, native, repeated, unique, personal]
  expect(preferredDefinitionChoices(options).map(option => option.key)).toEqual(['imported', 'independent', 'native-a', 'native-b', 'imported-unique', 'personal'])
  expect(preferredDefinitionChoices(options, 'imported')).toContain(imported)
  expect(preferredDefinitionChoices(options, 'patch')).toContain(patch)
  expect(options).toHaveLength(7)
})

it('preserves independent definitions with the same name and separate pinned identities', () => {
  const left = choice('left', 'Same name')
  const right = choice('right', 'Same name')
  expect(preferredDefinitionChoices([left, right])).toEqual([left, right])
  expect(preferredDefinitionChoices([right], right.key)).toEqual([right])
})
