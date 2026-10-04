import { expect, it } from 'vitest'
import { asId } from '../domain/core'
import type { CatalogEntity, CatalogRevisionId, JsonValue } from '../domain/types'
import type { DefinitionOption } from './definitions'
import { preferredDefinitionChoices } from './definition-preferences'

function choice(id: string, name: string, legacy?: JsonValue): DefinitionOption {
  const record: CatalogEntity = { id: asId(id), kind: 'ability', name, aliases: [], fields: {}, sources: [], ...(legacy ? { legacy } : {}) }
  return { key: id, ref: { kind: 'catalog', catalogId: asId('synthetic'), catalogRevisionId: asId('revision'), entityId: record.id }, kind: record.kind, name, aliases: [], sourceLabel: 'Synthetic source', stockLabel: 'Unknown', preferred: true, record }
}

it('prefers native presentation without merging names or replacing pinned or personal selections', () => {
  const native = choice('native-a', 'Synthetic ability', { native: { database: 'ability', databaseId: 1, mode: 'base' } })
  const repeated = choice('native-b', 'Synthetic ability', { native: { database: 'ability', databaseId: 2, mode: 'base' } })
  const wiki = choice('wiki', 'Synthetic ability', { supplemental: true })
  const patch = choice('patch', 'Synthetic ability', { native: { database: 'ability', databaseId: 1, mode: 'Chaos' } })
  const independent = choice('independent', 'Synthetic ability')
  const unique = choice('wiki-unique', 'Supplemental only', { supplemental: true })
  const personal: DefinitionOption = { ...choice('personal', 'Synthetic ability'), ref: { kind: 'personal', definitionId: asId('personal') } }
  const options = [wiki, patch, independent, native, repeated, unique, personal]
  expect(preferredDefinitionChoices(options).map(option => option.key)).toEqual(['wiki', 'independent', 'native-a', 'native-b', 'wiki-unique', 'personal'])
  expect(preferredDefinitionChoices(options, 'wiki')).toContain(wiki)
  expect(preferredDefinitionChoices(options, 'patch')).toContain(patch)
  expect(options).toHaveLength(7)
})

it('hides only verified alternatives whose exact native counterpart is available, preserving selected originals', () => {
  const native = choice('native', 'Native name')
  const original = { ...choice('source', 'Source name'), nativeReferenceId: 'native' }
  expect(preferredDefinitionChoices([native, original])).toEqual([native])
  expect(preferredDefinitionChoices([original])).toEqual([original])
  expect(preferredDefinitionChoices([native, original], original.key)).toEqual([native, original])
  const otherRevision = { ...native, ref: { ...native.ref, catalogRevisionId: asId<CatalogRevisionId>('different') } }
  expect(preferredDefinitionChoices([otherRevision, original])).toContain(original)
})
