import { describe, expect, it } from 'vitest'
import { definitionFactIsWide, definitionFactLabel, sourceDisplay, visibleDefinitionFacts, visibleSources } from './source-display'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import type { CatalogEntity } from '../domain/types'

describe('sourceDisplay', () => {
  it('uses the public provenance label while retaining the source host', () => {
    const display = sourceDisplay('https://crystal-project.fandom.com/wiki/Aegis')
    expect(display).toEqual({ label: 'Community wiki · Aegis', detail: 'crystal-project.fandom.com' })
  })

  it('keeps unknown URLs and plain identifiers identifiable', () => {
    expect(sourceDisplay('https://example.test/source/long-id')).toEqual({ label: 'example.test', detail: 'https://example.test/source/long-id' })
    expect(sourceDisplay('https://www.example.test/source')).toEqual({ label: 'example.test', detail: 'https://www.example.test/source' })
    expect(sourceDisplay('local-pack')).toEqual({ label: 'local-pack' })
  })

  it('omits routine export evidence without losing community attribution', () => {
    const community = { sourceId: 'https://crystal-project.fandom.com/wiki/Warrior' }
    const imported = { sourceId: 'synthetic-archive', snapshot: 'Crystal Edit 34; project version synthetic', locator: '/Jobs/0' }
    expect(visibleSources([{ sourceId: 'native-game:windows:base:job' }, { sourceId: 'game-export:windows:classes' }, { sourceId: 'crystal-edit:vanilla-class-copy' }, { sourceId: 'crystal-project:pc-class-tree-identities' }, { sourceId: 'crystal-edit-export:synthetic' }, imported, community])).toEqual([community])
  })

  it('shows one preferred growth fact and keeps all fields available to editing', () => {
    const entity: Pick<CatalogEntity, 'fields'> = { fields: {
      [CLASS_FIELDS.ratings]: { state: 'known', value: { HP: 80 } },
      [CRYSTAL_EDIT_FIELDS.ratings]: { state: 'known', value: { HP: 70 } },
      'Stat growth': { state: 'known', value: { Health: 4 } },
      'Crystal Edit copied job ID': { state: 'known', value: 24 },
      Unknown: { state: 'unknown' },
    } }
    expect(visibleDefinitionFacts(entity).map(([field]) => field)).toEqual([CLASS_FIELDS.ratings, 'Unknown'])
    expect(visibleDefinitionFacts(entity, true)).toEqual(Object.entries(entity.fields))
  })

  it('uses the full native catalog growth field and omits routine record metadata', () => {
    const nativeSource = { sourceId: 'native-game:windows:base:job' }
    const entity: Pick<CatalogEntity, 'fields'> = { fields: {
      [CLASS_FIELDS.ratings]: { state: 'known', value: { HP: 90 }, sources: [nativeSource] },
      'Growth ratings': { state: 'known', value: { HPRating: 90 }, sources: [nativeSource] },
      [CRYSTAL_EDIT_FIELDS.ratings]: { state: 'known', value: { HP: 70 } },
      [CLASS_FIELDS.tree]: { state: 'known', value: [] },
      'Native source record': { state: 'known', value: {} },
      'Game version': { state: 'known', value: '1.6.9', sources: [nativeSource] },
    } }
    expect(visibleDefinitionFacts(entity).map(([field]) => field)).toEqual([CLASS_FIELDS.ratings])
    expect(visibleDefinitionFacts(entity, true)).toEqual(Object.entries(entity.fields))
  })

  it('displays native class equipment and commands ahead of their editor and raw copies', () => {
    const entity: Pick<CatalogEntity, 'fields'> = { fields: {
      [CLASS_FIELDS.equipment]: { state: 'known', value: ['Sword'] },
      [CRYSTAL_EDIT_FIELDS.equipment]: { state: 'known', value: ['Staff'] },
      'Equipment Types': { state: 'known', value: [0] },
      [CLASS_FIELDS.command]: { state: 'known', value: 'Synthetic command' },
      [CRYSTAL_EDIT_FIELDS.command]: { state: 'known', value: 'Copied command' },
      'Abilities Name': { state: 'known', value: 'Synthetic command' },
    } }
    expect(visibleDefinitionFacts(entity).map(([field]) => field)).toEqual([CLASS_FIELDS.equipment, CLASS_FIELDS.command])
    expect(visibleDefinitionFacts(entity, true)).toEqual(Object.entries(entity.fields))
    expect(visibleDefinitionFacts({ fields: { ...entity.fields, [CLASS_FIELDS.equipment]: { state: 'unknown' } } }).map(([field]) => field)).toContain(CRYSTAL_EDIT_FIELDS.equipment)
  })

  it('removes import prefixes and proven table counters while preserving meaningful numbered titles', () => {
    const value = { state: 'known' as const, value: [], sources: [{ sourceId: 'community', locator: 'Warrior > Passives' }] }
    expect(definitionFactLabel('Table: Passives 2', value)).toBe('Passives')
    expect(definitionFactLabel('Table: Battle Skill', value)).toBe('Battle Skill')
    expect(definitionFactLabel('Section: Master', value)).toBe('Master')
    expect(definitionFactLabel('Table: Area 2', value)).toBe('Area 2')
    expect(definitionFactLabel('Table: Penguin Pen 2', { ...value, sources: [{ sourceId: 'community', locator: 'Capital Sequoia > Penguin Pen' }] }, ['Table: Penguin Pen', 'Table: Penguin Pen 2'])).toBe('Penguin Pen 2')
    expect(definitionFactLabel('Table: Passives 2', { state: 'unknown' })).toBe('Passives 2')
    expect(definitionFactLabel('Table: Passives 2', { state: 'unknown', sources: value.sources })).toBe('Passives')
  })

  it('gives structured facts, narratives, and conflicting claims the full row', () => {
    expect(definitionFactIsWide('Skills', { state: 'known', value: [{ Name: 'Synthetic skill', Cost: '2 LP' }] })).toBe(true)
    expect(definitionFactIsWide('Growth ratings', { state: 'known', value: { HP: 80 } })).toBe(true)
    expect(definitionFactIsWide('Section: Master', { state: 'known', value: 'Synthetic town' })).toBe(true)
    expect(definitionFactIsWide('Description', { state: 'known', value: 'First line\nSecond line' })).toBe(true)
    expect(definitionFactIsWide('Location', { state: 'conflicting', claims: [] })).toBe(true)
    expect(definitionFactIsWide('Weapons', { state: 'known', value: ['Sword', 'Axe'] })).toBe(false)
    expect(definitionFactIsWide('Attack', { state: 'known', value: 80 })).toBe(false)
    expect(definitionFactIsWide('Attack', { state: 'unknown' })).toBe(false)
  })
})
