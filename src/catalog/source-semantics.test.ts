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

  it('coalesces acquisition summaries with compatible prose detail', () => {
    expect(coalesceEquivalentSourceClaims('Location', { state: 'conflicting', claims: [
      { value: 'Obtained as a drop from Anubis boss in the Ancient Labyrinth.', sources: [detailSource] },
      { value: 'Drop: Anubis in the Ancient Labyrinth', sources: [tableSource] },
    ] })).toEqual({ state: 'known', value: 'Drop: Anubis in the Ancient Labyrinth', sources: [detailSource, tableSource] })
    expect(coalesceEquivalentSourceClaims('Location', { state: 'conflicting', claims: [
      { value: 'Chest: Beaurior Rock', sources: [tableSource] },
      { value: 'It can be found in a chest in Beaurior Rock, north of a bridge', sources: [detailSource] },
    ] })).toEqual({ state: 'known', value: 'Chest: Beaurior Rock', sources: [tableSource, detailSource] })
    expect(coalesceEquivalentSourceClaims('Location', { state: 'conflicting', claims: [
      { value: 'Obtained via Crafting.', sources: [detailSource] },
      { value: 'Craft: Diamond Ore', sources: [tableSource] },
    ] })).toEqual({ state: 'known', value: 'Craft: Diamond Ore', sources: [detailSource, tableSource] })
    expect(coalesceEquivalentSourceClaims('Location', { state: 'conflicting', claims: [
      { value: 'Drop: Gourmet, grown from a Gourmet Seed', sources: [tableSource] },
      { value: 'Drops from Gourmet in Capital Sequoia garden.', sources: [detailSource] },
    ] })).toEqual({ state: 'known', value: 'Drop: Gourmet, grown from a Gourmet Seed', sources: [tableSource, detailSource] })
    expect(coalesceEquivalentSourceClaims('Location', { state: 'conflicting', claims: [
      { value: 'Given to you by Reid in The Pale Grotto\nShop: Delende Camp Armor Shop, Armor "4" All', sources: [tableSource] },
      { value: 'Can be purchased from Delende Camp Armor Shop and Armor "4" All. Reid will gift you one in The Pale Grotto.', sources: [detailSource] },
    ] })).toEqual({ state: 'known', value: 'Given to you by Reid in The Pale Grotto\nShop: Delende Camp Armor Shop, Armor "4" All', sources: [tableSource, detailSource] })
  })

  it('coalesces source formatting without erasing meaningful words', () => {
    expect(coalesceEquivalentSourceClaims('Cost', { state: 'conflicting', claims: [
      { value: '2 50', sources: [tableSource] },
      { value: '2 Silver 50 Copper', sources: [detailSource] },
    ] })).toEqual({ state: 'known', value: '2 Silver 50 Copper', sources: [tableSource, detailSource] })
    expect(coalesceEquivalentSourceClaims('Effect', { state: 'conflicting', claims: [
      { value: 'Single target. Recovery 10 MP.', sources: [tableSource] },
      { value: 'Single target.\nRecovery: 10 MP', sources: [detailSource] },
    ] })).toEqual({ state: 'known', value: 'Single target. Recovery 10 MP.', sources: [tableSource, detailSource] })
    const missingMeaning: Knowledge<string> = { state: 'conflicting', claims: [
      { value: 'Multi-target. Recovery 100% Missing MP.', sources: [tableSource] },
      { value: 'Multi Target\nRecovery: 100% MP', sources: [detailSource] },
    ] }
    expect(coalesceEquivalentSourceClaims('Effect', missingMeaning)).toBe(missingMeaning)
  })

  it('keeps weak matches, other fields, and claim notes unresolved', () => {
    const differentPlaces: Knowledge<string> = { state: 'conflicting', claims: [
      { value: 'Reward: Master Assassin in Shoudu Province', sources: [tableSource] },
      { value: 'The Assassin Master is found in Capital Sequoia.', sources: [detailSource] },
    ] }
    const notes: Knowledge<string> = { state: 'conflicting', claims: [
      { value: 'Chest: Shoudu Province', sources: [tableSource], note: 'Table summary' },
      { value: 'It can be found in a chest, in Shoudu Province', sources: [detailSource] },
    ] }
    expect(coalesceEquivalentSourceClaims('Location', differentPlaces)).toBe(differentPlaces)
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
