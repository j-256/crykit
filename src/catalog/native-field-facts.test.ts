import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { nativeFieldFacts } from './native-field-facts'
import { projectSourceSemantics } from './source-semantics'
import { nativeRecord } from '../domain/native-game'

describe('native reference field facts', () => {
  it('replaces dated flat-stat values without changing stored fields', () => {
    const shoes = DEFAULT_CATALOG.entities['base:equipment:320']!
    const before = JSON.stringify(shoes)
    const facts = nativeFieldFacts(DEFAULT_CATALOG, shoes)
    expect(facts.find(fact => fact.field === 'Stat')).toMatchObject({ original: { value: 'Dexterity +6\nAgility +16' }, value: { state: 'known', value: 'Dexterity: +14\nAgility: +16' }, differs: true })
    expect(facts.find(fact => fact.field === 'Stat bonuses')).toMatchObject({ original: { value: 'Dexterity: +16\nAgility: +16' }, value: { state: 'known', value: 'Dexterity: +14\nAgility: +16' }, differs: true })
    expect(JSON.stringify(shoes)).toBe(before)
  })

  it('resolves the reviewed stew effect while preserving both historical claims', () => {
    const stew = DEFAULT_CATALOG.entities['base:item:132']!
    const fact = nativeFieldFacts(DEFAULT_CATALOG, projectSourceSemantics(stew)).find(entry => entry.field === 'Effect')!
    expect(fact.original.state).toBe('conflicting')
    expect(fact.value).toMatchObject({ state: 'known', value: expect.stringMatching(/missing HP/i) })
    expect(stew.fields.Effect?.state).toBe('conflicting')
  })

  it('does not reinterpret imports, revised catalogs, or edited definitions', () => {
    const shoes = DEFAULT_CATALOG.entities['base:equipment:320']!
    expect(nativeFieldFacts({ ...DEFAULT_CATALOG, checksum: 'changed' }, shoes)).toEqual([])
    expect(nativeFieldFacts({ ...DEFAULT_CATALOG, legacy: { ...(nativeRecord(DEFAULT_CATALOG.legacy) ? DEFAULT_CATALOG.legacy : {}), sourceContentDigest: 'changed' } }, shoes)).toEqual([])
    for (const changes of [{ name: 'Custom shoes' }, { fields: { ...shoes.fields, Dexterity: { state: 'known' as const, value: 90 } } }]) expect(nativeFieldFacts(DEFAULT_CATALOG, { ...shoes, ...changes })).toEqual([])
  })
})
