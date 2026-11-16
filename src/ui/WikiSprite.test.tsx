import { CURRENT_CATALOG } from '../catalog/bundled'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CLASS_FIELDS } from '../domain/crystal-edit'
import type { EntityId } from '../domain/types'
import { CatalogArtwork, CatalogArtworkSource, ClassWorldArtwork, hasExternalCatalogArtwork } from './WikiSprite'
import { FieldIconSources, GameIcon, hasExternalFieldIcons } from './GameIcon'
import { KnowledgeValue } from './KnowledgeValue'

describe('class standing artwork', () => {
  it('preserves compact supplemental glyphs and readable labels alongside native menu icons', () => {
    const fields = { Armor: { state: 'known' as const, value: 'Heavy armor' }, Weapons: { state: 'known' as const, value: 'Swords' } }
    expect(renderToStaticMarkup(<GameIcon iconKey="equipment:heavy armor"/>)).toContain('<img')
    const fallback = renderToStaticMarkup(<KnowledgeValue field="Weapons" value={fields.Weapons}/>)
    expect(fallback).toContain('Swords')
    expect(fallback).toContain('/menu-icon-supplements/')
  })

  it('keeps native glyphs quiet and exposes the exact supplemental credits in Sources', () => {
    const native = { Armor: { state: 'known' as const, value: 'Heavy armor' } }
    const supplemental = { ...native, Weapons: { state: 'known' as const, value: 'Swords' } }
    expect(hasExternalFieldIcons(native)).toBe(false)
    expect(FieldIconSources({ fields: native })).toBeNull()
    expect(hasExternalFieldIcons(supplemental)).toBe(true)
    expect(hasExternalFieldIcons({ [CLASS_FIELDS.command]: { state: 'known', value: 'Battle Skill' }, [CLASS_FIELDS.equipment]: { state: 'known', value: ['Sword', 'Heavy Body'] } })).toBe(true)
    const sources = FieldIconSources({ fields: supplemental })!
    expect(renderToStaticMarkup(sources)).toContain('Sources for menu icons')
    const credits = renderToStaticMarkup(sources.props.children)
    expect(credits).toContain('File%3ASwordAbilityIcon.png?oldid=2786')
    expect(credits).toContain('No reviewed license declaration on the wiki file page')
    expect(credits).toContain('Named weapon glyph')
  })

  it('keeps native artwork quiet and reports missing exact artwork without borrowing community images', () => {
    const props = { catalogId: CURRENT_CATALOG.id }
    const warrior = { id: 'base:job:0' as EntityId, kind: 'class' as const, name: 'Warrior' }
    const unbound = { id: 'base:monster:ref-849' as EntityId, kind: 'monster' as const, name: 'Slime' }
    expect(hasExternalCatalogArtwork(props.catalogId, warrior)).toBe(false)
    expect(hasExternalCatalogArtwork(props.catalogId, unbound)).toBe(false)
    expect(renderToStaticMarkup(<CatalogArtworkSource {...props} entity={warrior}/>)).toBe('')
    expect(renderToStaticMarkup(<CatalogArtworkSource {...props} entity={unbound}/>)).toContain('No exact artwork linked.')
    const fallback = renderToStaticMarkup(<CatalogArtwork {...props} detailed entity={unbound}/>)
    expect(fallback).toContain('Slime artwork placeholder')
    expect(fallback).not.toContain('<img')
  })

  it('preserves the full-body display size while using local native frames', () => {
    const markup = renderToStaticMarkup(<ClassWorldArtwork catalogId={CURRENT_CATALOG.id} detailed entity={{ id: 'base:job:0' as EntityId, kind: 'class', name: 'Warrior' }}/>)
    expect(markup).toContain('data-artwork-source="native"')
    expect(markup).toContain('alt="Warrior game artwork"')
    expect(markup).toContain('width="100"')
    expect(markup).toContain('height="72"')
    expect(markup).not.toContain('/wiki-sprites/')
  })

  it('keeps a placeholder for an unbound class instead of borrowing matching names', () => {
    const markup = renderToStaticMarkup(<ClassWorldArtwork catalogId={CURRENT_CATALOG.id} detailed entity={{ id: 'synthetic:warrior' as EntityId, kind: 'class', name: 'Warrior' }}/>)
    expect(markup).toContain('Warrior artwork placeholder')
    expect(markup).not.toContain('<img')
  })
})
