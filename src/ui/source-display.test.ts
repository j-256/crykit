import { describe, expect, it } from 'vitest'
import { sourceDisplay, visibleDefinitionFacts, visibleSources } from './source-display'
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
    expect(visibleSources([{ sourceId: 'native-game:windows:base:job' }, { sourceId: 'game-export:windows:classes' }, { sourceId: 'crystal-edit:vanilla-class-copy' }, { sourceId: 'crystal-edit-export:synthetic' }, imported, community])).toEqual([community])
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
      [CRYSTAL_EDIT_FIELDS.ratings]: { state: 'known', value: { HP: 70 } },
      [CLASS_FIELDS.tree]: { state: 'known', value: [] },
      'Native source record': { state: 'known', value: {} },
      'Game version': { state: 'known', value: '1.6.9', sources: [nativeSource] },
    } }
    expect(visibleDefinitionFacts(entity).map(([field]) => field)).toEqual([CLASS_FIELDS.ratings])
    expect(visibleDefinitionFacts(entity, true)).toEqual(Object.entries(entity.fields))
  })

})
