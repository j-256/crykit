import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EntityId } from '../domain/types'
import { CatalogArtworkSource, ClassWorldArtwork, hasExternalCatalogArtwork } from './WikiSprite'
import { FieldIconSources, GameIcon, hasExternalFieldIcons } from './GameIcon'

describe('class standing artwork', () => {
  it('renders native menu icons without credits and keeps credits for wiki glyphs', () => {
    const native = { Armor: { state: 'known' as const, value: 'Heavy armor' } }
    expect(hasExternalFieldIcons(native)).toBe(false)
    expect(hasExternalFieldIcons({ ...native, Weapons: { state: 'known', value: 'Swords' } })).toBe(true)
    expect(renderToStaticMarkup(<GameIcon iconKey="equipment:heavy armor"/>)).toContain('<img')
    expect(renderToStaticMarkup(<FieldIconSources fields={native}/>)).toBe('')
    expect(renderToStaticMarkup(<FieldIconSources fields={{ ...native, Weapons: { state: 'known', value: 'Swords' } }}/>)).toContain('Sources for menu icons')
  })

  it('keeps native artwork quiet while retaining wiki credits and missing-image diagnostics', () => {
    const props = { catalogId: 'crystal-project-public-starter' }
    expect(hasExternalCatalogArtwork(props.catalogId, { id: 'base:job:0' as EntityId, kind: 'class', name: 'Warrior' })).toBe(false)
    expect(hasExternalCatalogArtwork(props.catalogId, { id: 'base:monster:ref-849' as EntityId, kind: 'monster', name: 'Slime' })).toBe(true)
    expect(hasExternalCatalogArtwork(props.catalogId, { id: 'synthetic:missing' as EntityId, kind: 'class', name: 'Missing' })).toBe(false)
    expect(renderToStaticMarkup(<CatalogArtworkSource {...props} entity={{ id: 'base:job:0' as EntityId, kind: 'class', name: 'Warrior' }}/>)).toBe('')
    expect(renderToStaticMarkup(<CatalogArtworkSource {...props} entity={{ id: 'base:monster:ref-849' as EntityId, kind: 'monster', name: 'Slime' }}/>)).toContain('Sources for Slime artwork')
    expect(renderToStaticMarkup(<CatalogArtworkSource {...props} entity={{ id: 'synthetic:missing' as EntityId, kind: 'class', name: 'Missing' }}/>)).toContain('No exact artwork linked.')
  })

  it('preserves the full-body display size while using local native frames', () => {
    const markup = renderToStaticMarkup(<ClassWorldArtwork catalogId="crystal-project-public-starter" detailed entity={{ id: 'base:job:0' as EntityId, kind: 'class', name: 'Warrior' }}/>)
    expect(markup).toContain('data-artwork-source="native"')
    expect(markup).toContain('alt="Warrior game artwork"')
    expect(markup).toContain('width="100"')
    expect(markup).toContain('height="72"')
    expect(markup).not.toContain('/wiki-sprites/')
  })

  it('keeps a placeholder for an unbound class instead of borrowing matching names', () => {
    const markup = renderToStaticMarkup(<ClassWorldArtwork catalogId="crystal-project-public-starter" detailed entity={{ id: 'synthetic:warrior' as EntityId, kind: 'class', name: 'Warrior' }}/>)
    expect(markup).toContain('Warrior artwork placeholder')
    expect(markup).not.toContain('<img')
  })
})
