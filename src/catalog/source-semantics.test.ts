import { describe, expect, it } from 'vitest'
import type { CatalogEntity, EntityId, Knowledge } from '../domain/types'
import { coalesceEquivalentSourceClaims, projectSourceSemantics } from './source-semantics'

const tableSource = { sourceId: 'https://example.com/table', locator: 'Accessories/table > Acrobat Shoes' }
const detailSource = { sourceId: 'https://example.com/detail', locator: 'Acrobat Shoes' }

describe('source claim semantics', () => {
  it('coalesces structured and prose chest locations with all source attribution', () => {
    expect(coalesceEquivalentSourceClaims('Location', { state: 'conflicting', claims: [
      { value: 'Chest: Shoudu Province', sources: [tableSource] },
      { value: 'It can be found in a chest, in Shoudu Province', sources: [detailSource] },
    ] })).toEqual({ state: 'known', value: 'Chest: Shoudu Province', sources: [tableSource, detailSource] })
  })

  it('keeps additional detail, other fields, and claim notes unresolved', () => {
    const details: Knowledge<string> = { state: 'conflicting', claims: [
      { value: 'Chest: Beaurior Rock', sources: [tableSource] },
      { value: 'It can be found in a chest in Beaurior Rock, north of a bridge', sources: [detailSource] },
    ] }
    const notes: Knowledge<string> = { state: 'conflicting', claims: [
      { value: 'Chest: Shoudu Province', sources: [tableSource], note: 'Table summary' },
      { value: 'It can be found in a chest, in Shoudu Province', sources: [detailSource] },
    ] }
    expect(coalesceEquivalentSourceClaims('Location', details)).toBe(details)
    expect(coalesceEquivalentSourceClaims('Description', notes)).toBe(notes)
    expect(coalesceEquivalentSourceClaims('Location', notes)).toBe(notes)
  })

  it('projects reconciled fields without changing the source entity', () => {
    const location: Knowledge<string> = { state: 'conflicting', claims: [
      { value: 'Can be found in a chest in The Sequoia.', sources: [detailSource] },
      { value: 'Chest: The Sequoia', sources: [tableSource] },
    ] }
    const entity: CatalogEntity = { id: 'item' as EntityId, kind: 'item', name: 'Item', aliases: [], fields: { Location: location }, sources: [] }
    expect(projectSourceSemantics(entity).fields.Location).toMatchObject({ state: 'known', value: 'Chest: The Sequoia' })
    expect(entity.fields.Location).toBe(location)
  })
})
