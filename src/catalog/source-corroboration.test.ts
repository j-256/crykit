import { expect, it } from 'vitest'
import { CURRENT_CATALOG } from './bundled'
import { corroboratedFact } from './source-corroboration'
import type { Knowledge } from '../domain/types'

it('quiets only unchanged native fields from the exact bundled snapshot', () => {
  const entity = CURRENT_CATALOG.entities['base:job:0']!
  const target = { catalog: CURRENT_CATALOG, entity }
  const field = entity.fields['Class command']!
  expect(corroboratedFact(target, 'Class command', field)).toBe(true)
  const changed: Knowledge<unknown> = { state: 'known', value: 'Changed command', sources: [{ sourceId: 'external:synthetic' }] }
  expect(corroboratedFact(target, 'Class command', changed)).toBe(false)
  expect(corroboratedFact({ ...target, catalog: { ...CURRENT_CATALOG, checksum: 'changed' } }, 'Class command', field)).toBe(false)
  expect(corroboratedFact({ ...target, entity: { ...entity, legacy: { native: { database: 'job', databaseId: 1, mode: 'base' } } } }, 'Class command', field)).toBe(false)
  expect(corroboratedFact(undefined, 'Class command', field)).toBe(false)
})
