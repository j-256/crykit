import { describe, expect, it } from 'vitest'
import { previewResearchJson } from './research'

const bytes = (value: string) => new TextEncoder().encode(value)

describe('external research source identity', () => {
  it('does not grant a supplied catalog ID the bundled vanilla namespace', async () => {
    const preview = await previewResearchJson(bytes('{"schema_version":"1.1.0","catalog_id":"crystal-project/vanilla","items":[]}'), 'source.json')
    expect(preview.proposed.catalogs[0]!.id).toMatch(/^crystal-project\/imported\/research1-[a-f0-9]{64}$/)
  })

  it('uses identical content and interpretation for equivalent JSON and keeps the raw archives', async () => {
    const a = await previewResearchJson(bytes('{"schema_version":"1.1.0","catalog_id":"project","items":[]}'), 'a.json')
    const b = await previewResearchJson(bytes('{ "items":[], "catalog_id":"project", "schema_version":"1.1.0" }'), 'b.json')
    expect(a.proposed.catalogs).toEqual(b.proposed.catalogs)
    expect(a.proposed.sources[0]!.digest).not.toBe(b.proposed.sources[0]!.digest)
  })

  it('projects supplemental claims, descriptions, and PP aliases independently of object key order', async () => {
    const source = { schema_version: '1.1.0', catalog_id: 'project', base_equipment: [{ item_id: 'one', item: 'One' }], expansion_stat_components: [{ item_id: 'one', attack: 1, defense: 2 }], passives: [{ id: 'two', name: 'Two', pp: 1, 'pp cost': 2, description: 'First', effect: 'Second' }] }
    const original = JSON.stringify(source)
    const reordered = JSON.stringify(source, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value, 2)
    const a = await previewResearchJson(bytes(original), 'original.json')
    const b = await previewResearchJson(bytes(reordered), 'reordered.json')
    expect(a.proposed.catalogs[0]!.revisionId).toBe(b.proposed.catalogs[0]!.revisionId)
    expect(a.proposed.catalogs).toEqual(b.proposed.catalogs)
    expect(a.proposed.catalogs[0]!.claims).toHaveLength(2)
    expect(a.proposed.catalogs[0]!.entities.two).toMatchObject({ rawDescription: 'First\nSecond', ppCost: { state: 'conflicting', claims: [{ value: 1 }, { value: 2 }] } })
    expect(a.proposed.sources[0]!.digest).not.toBe(b.proposed.sources[0]!.digest)
  })

  it.each([{ alias: 1, state: 'known' }, { alias: null, state: 'unknown' }])('preserves $state PP evidence across overlapping aliases', async ({ alias, state }) => {
    const preview = await previewResearchJson(bytes(JSON.stringify({ schema_version: '1.1.0', passives: [{ id: 'one', name: 'One', pp: 1, 'pp cost': alias }] })), 'aliases.json')
    expect(preview.proposed.catalogs[0]!.entities.one!.ppCost?.state).toBe(state)
  })
})
