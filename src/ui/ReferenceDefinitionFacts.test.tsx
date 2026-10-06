import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { nativeFieldFacts } from '../catalog/native-field-facts'
import { nativeSourceRecord } from '../domain/native-game'
import type { CatalogEntity, Knowledge } from '../domain/types'
import { ReferenceDefinitionFacts, isTechnicalReferenceFact } from './ReferenceDefinitionFacts'
import { ReferenceDescription } from './ReferenceDescription'

describe('Reference gameplay hierarchy', () => {
  it('keeps usable effects, prices, and restrictions visible while preserving engine data in a closed disclosure', () => {
    const definition = DEFAULT_CATALOG.entities['base:equipment:134']!
    const facts: readonly (readonly [string, Knowledge<unknown>])[] = [
      ['Max mp', { state: 'known', value: 20 }],
      ['Cost', { state: 'known', value: 100 }],
      ['Is Two Handed', { state: 'known', value: false }],
      ['Stat modifiers', { state: 'known', value: [{ Tag: 1, Value1: 20, Value2: 0, Value3: 0 }] }],
      ['Automatic equipment price disabled', { state: 'known', value: true }],
    ]
    const before = JSON.stringify({ definition, facts })
    const html = renderToStaticMarkup(<ReferenceDefinitionFacts definition={definition} facts={facts}/>)
    const [gameplay, technical] = html.split('<details')
    expect(gameplay).toContain('Max MP')
    expect(gameplay).toContain('Two-handed')
    expect(gameplay).toContain('>No</span>')
    expect(gameplay).not.toContain('Stat modifiers')
    expect(technical).toContain('class="reference-technical"')
    expect(technical).not.toMatch(/\bopen(?:=|\s|>)/)
    expect(technical).toContain('Technical facts')
    expect(technical).toContain('Value1')
    expect(technical).toContain('Automatic equipment price disabled')
    expect(JSON.stringify({ definition, facts })).toBe(before)
  })

  it('keeps unresolved and conflicting gameplay facts explicit with their source evidence', () => {
    const definition = DEFAULT_CATALOG.entities['base:equipment:134']!
    const facts: readonly (readonly [string, Knowledge<unknown>])[] = [
      ['Cost', { state: 'unknown', reason: 'Price not recorded', sources: [{ sourceId: 'synthetic-notes', locator: 'Price check' }] }],
      ['Is One Only', { state: 'conflicting', claims: [{ value: true, sources: [{ sourceId: 'synthetic-a' }] }, { value: false, sources: [{ sourceId: 'synthetic-b' }] }] }],
    ]
    const html = renderToStaticMarkup(<ReferenceDefinitionFacts definition={definition} facts={facts}/>)
    const gameplay = html.split('<details')[0]!
    expect(gameplay).toContain('Price not recorded')
    expect(gameplay).toContain('Sources for Cost')
    expect(gameplay).toContain('Sources differ')
    expect(gameplay).toContain('2 differing source values')
  })

  it('keeps learning and item-use flags in gameplay facts without changing their values or uncertainty', () => {
    const definition = DEFAULT_CATALOG.entities['base:equipment:134']!
    const facts: readonly (readonly [string, Knowledge<unknown>])[] = [
      ['Is Learnable', { state: 'known', value: false }],
      ['Is Innate', { state: 'known', value: true }],
      ['Is Sellable', { state: 'unknown', reason: 'Sale permission not recorded' }],
      ['Is Consumable', { state: 'conflicting', claims: [{ value: true, sources: [{ sourceId: 'synthetic-a' }] }, { value: false, sources: [{ sourceId: 'synthetic-b' }] }] }],
      ['Is Combat', { state: 'known', value: false }],
    ]
    const before = JSON.stringify(facts)
    const [gameplay, technical] = renderToStaticMarkup(<ReferenceDefinitionFacts definition={definition} facts={facts}/>).split('<details')
    expect(gameplay).toContain('Learnable</span></span></dt><dd><span>No</span>')
    expect(gameplay).toContain('Innate</span></span></dt><dd><span>Yes</span>')
    expect(gameplay).toContain('Can be sold')
    expect(gameplay).toContain('Sale permission not recorded')
    expect(gameplay).toContain('Consumable')
    expect(gameplay).toContain('2 differing source values')
    expect(gameplay).not.toContain('Is Combat')
    expect(technical).toContain('Is Combat')
    expect(JSON.stringify(facts)).toBe(before)
  })

  it('shows selection costs, restrictions, grants and uncertain contributions before raw engine details', () => {
    const definition: CatalogEntity = {
      ...DEFAULT_CATALOG.entities['base:equipment:134']!,
      kind: 'passive',
      ppCost: { state: 'known', value: 0 },
      requirements: { state: 'conflicting', claims: [{ value: [{ kind: 'permission', permission: 'Synthetic permission A' }], sources: [{ sourceId: 'synthetic-a' }] }, { value: [{ kind: 'permission', permission: 'Synthetic permission B' }], sources: [{ sourceId: 'synthetic-b' }] }] },
      grants: { state: 'unknown', reason: 'Granted permissions not recorded' },
      listedContributions: { Attack: { state: 'unknown', reason: 'Attack contribution not recorded', sources: [{ sourceId: 'synthetic-notes' }] } },
    }
    const before = JSON.stringify(definition)
    const [gameplay, technical] = renderToStaticMarkup(<ReferenceDefinitionFacts definition={definition} facts={[["Native category code", { state: 'known', value: 7 }]]}/>).split('<details')
    expect(gameplay).toContain('aria-label="Planning fields"')
    expect(gameplay).toContain('PP cost')
    expect(gameplay).toContain('<span>0</span>')
    expect(gameplay).toContain('Synthetic permission A')
    expect(gameplay).toContain('Synthetic permission B')
    expect(gameplay).toContain('2 differing source values')
    expect(gameplay).toContain('Granted permissions not recorded')
    expect(gameplay).toContain('Attack contribution not recorded')
    expect(gameplay).toContain('Sources for Attack')
    expect(gameplay).not.toContain('Native category code')
    expect(technical).toContain('Native category code')
    expect(technical).not.toContain('Planning fields')
    expect(technical).not.toMatch(/\bopen(?:=|\s|>)/)
    expect(JSON.stringify(definition)).toBe(before)
  })

  it('shows item slots and exact native contributions without creating an empty technical disclosure', () => {
    const original = DEFAULT_CATALOG.entities['base:equipment:134']!
    const definition: CatalogEntity = { ...original, slotKinds: { state: 'unknown', reason: 'Equipment slot not recorded' } }
    const before = JSON.stringify(definition)
    const html = renderToStaticMarkup(<ReferenceDefinitionFacts definition={definition} facts={[]} planningFacts={nativeFieldFacts(DEFAULT_CATALOG, original)}/>)
    expect(html).toContain('Slot kinds')
    expect(html).toContain('Equipment slot not recorded')
    expect(html).toContain('<dt>Defense</dt>')
    expect(html).toContain('>19<')
    expect(html).toContain('<dt>Resistance</dt>')
    expect(html).toContain('>78<')
    expect(html).not.toContain('Sources for Defense')
    expect(html).not.toContain('Sources for Resistance')
    expect(html).not.toContain('reference-technical')
    expect(JSON.stringify(definition)).toBe(before)
  })

  it('classifies only presentation fields and never turns a generated source inventory into a compact gameplay description', () => {
    expect(isTechnicalReferenceFact('Stat modifiers')).toBe(true)
    expect(isTechnicalReferenceFact('Native category code')).toBe(true)
    expect(isTechnicalReferenceFact('Is Two Handed')).toBe(false)
    expect(isTechnicalReferenceFact('Effect')).toBe(false)
    const definition = Object.values(DEFAULT_CATALOG.entities).find(entity => nativeSourceRecord(entity) && !nativeSourceRecord(entity)?.Description && entity.kind === 'location') as CatalogEntity
    expect(definition).toBeDefined()
    const html = renderToStaticMarkup(<ReferenceDescription compact entity={definition} hideGeneratedSummary fallback="Open for details."/>)
    expect(html).toContain('Open for details.')
    expect(html).not.toContain('base database')
    expect(html).not.toContain('normalized fields')
    const authored = { ...definition, rawDescription: 'Synthetic authored navigation notes', fields: { ...definition.fields, Description: { state: 'known' as const, value: 'Synthetic authored navigation notes' } } }
    expect(renderToStaticMarkup(<ReferenceDescription compact entity={authored} hideGeneratedSummary fallback="Open for details."/>)).toContain('Synthetic authored navigation notes')
  })
})
