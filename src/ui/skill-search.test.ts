import { describe, expect, it } from 'vitest'
import { STARTER_CATALOG } from '../catalog/starter'
import { buildReferenceSearchItems, partitionPersonalDefinitionOptions, partitionReferenceItems } from './search'

const filters = { query: '', kinds: [], categories: [], sources: [], weapon: 'Dagger' as const }

describe('weapon skill search', () => {
  const items = buildReferenceSearchItems([STARTER_CATALOG])

  it('finds dagger skills across classes plus any-weapon skills without spells or equipment', () => {
    const results = partitionReferenceItems(items, filters)
    const names = results.confirmed.map(item => item.entity.name)
    for (const name of ['Eye Gouge', 'Backstab', 'Rupture', 'Avid Assault', 'Fire Seal', 'Power Break']) expect(names).toContain(name)
    for (const name of ['Fire', 'Taunt', 'Beat Down', 'Equip Dagger', 'Dagger']) expect(names).not.toContain(name)
    expect(results.confirmed.every(item => item.entity.kind === 'ability' || item.entity.kind === 'monsterMagic')).toBe(true)
    expect(results.possible.length).toBeGreaterThan(0)
    expect(results.possible.every(item => item.weaponRule.state === 'unknown' || item.weaponRule.state === 'conflicting')).toBe(true)
    const unrestricted = partitionReferenceItems(items, { ...filters, unrestrictedWeaponSkills: 'enabled' })
    expect(unrestricted.confirmed.map(item => item.entity.name)).toContain('Beat Down')
    expect(unrestricted.confirmed.map(item => item.entity.name)).not.toContain('Fire')
  })

  it('uses exact personal definitions and preserves unspecified requirements as possible matches', () => {
    const options = [
      { kind: 'ability' as const, name: 'Private strike', aliases: [], sourceLabel: 'Personal', record: { kind: 'ability' as const, fields: { Type: { state: 'known' as const, value: 'Single target Dagger skill' } } } },
      { kind: 'ability' as const, name: 'Unspecified strike', aliases: [], sourceLabel: 'Personal' },
      { kind: 'item' as const, name: 'Dagger', aliases: [], sourceLabel: 'Personal' },
    ]
    const results = partitionPersonalDefinitionOptions(options, filters)
    expect(results.confirmed.map(option => option.name)).toEqual(['Private strike'])
    expect(results.possible.map(option => option.name)).toEqual(['Unspecified strike'])
    expect(results.excluded.map(option => option.name)).toEqual(['Dagger'])
  })
})
