import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { corroboratedFact } from './source-corroboration'
import { DefinitionFactsPanel } from '../ui/DefinitionDetailSections'
import { SourceReferences } from '../ui/KnowledgeValue'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { CatalogEntity, CatalogSnapshot, Knowledge } from '../domain/types'

const WARRIOR_ID = 'base:job:0'
const WARRIOR = DEFAULT_CATALOG.entities[WARRIOR_ID]!
const target = { catalog: DEFAULT_CATALOG, entity: WARRIOR }

describe('game-code field corroboration', () => {
  it('suppresses complete corroborated facts while preserving acquisition evidence and attribution', () => {
    for (const field of ['Weapons', 'Armor', 'Command', 'Stat growth', 'Crystal Edit growth ratings']) expect(corroboratedFact(target, field, WARRIOR.fields[field]!)).toBe(true)
    for (const field of ['Initial equipment', 'Master', 'Section: Master']) expect(corroboratedFact(target, field, WARRIOR.fields[field]!)).toBe(false)
    const markup = renderToStaticMarkup(createElement(DefinitionFactsPanel, { corroboration: target, facts: [['Weapons', WARRIOR.fields.Weapons!], ['Master', WARRIOR.fields.Master!]] }))
    expect(markup.match(/sources-trigger/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Sources for Master"')
    expect(markup).not.toContain('Community wiki')
    const master = WARRIOR.fields.Master!
    expect(renderToStaticMarkup(createElement(SourceReferences, { sources: master.state === 'known' ? master.sources ?? [] : [] }))).toContain('Community wiki')
    expect(WARRIOR.fields.Weapons!.state === 'known' && WARRIOR.fields.Weapons!.sources?.length).toBeGreaterThan(0)
  })

  it('does not grant verification to changed values, sources, identity, catalog content or imports', () => {
    const field = WARRIOR.fields.Weapons!
    const changed: Knowledge<unknown>[] = [
      { state: 'known', value: 'Swords' },
      { state: 'known', value: field.state === 'known' ? field.value : '', sources: [{ sourceId: 'synthetic-new-source' }] },
      { state: 'unknown', reason: 'Synthetic unknown' },
      { state: 'conflicting', claims: [{ value: 'Swords', sources: [] }, { value: 'Axes', sources: [] }] },
    ]
    for (const value of changed) expect(corroboratedFact(target, 'Weapons', value)).toBe(false)
    expect(corroboratedFact(undefined, 'Weapons', field)).toBe(false)
    expect(corroboratedFact({ ...target, entity: { ...WARRIOR, legacy: { native: { database: 'job', databaseId: 1, mode: 'base' } } } }, 'Weapons', field)).toBe(false)
    expect(corroboratedFact({ ...target, catalog: { ...DEFAULT_CATALOG, checksum: 'synthetic-changed-checksum' } }, 'Weapons', field)).toBe(false)
    const imported = { ...DEFAULT_CATALOG, id: 'synthetic-import' } as CatalogSnapshot
    expect(corroboratedFact({ ...target, catalog: imported }, 'Weapons', field)).toBe(false)
  })

  it('requires an unchanged native fact before suppressing its disclosure', () => {
    const field = WARRIOR.fields['Class command']!
    expect(corroboratedFact(target, 'Class command', field)).toBe(true)
    const changed = { ...field, value: 'Synthetic command' } as Knowledge<unknown>
    expect(corroboratedFact(target, 'Class command', changed)).toBe(false)
    const entity = { ...WARRIOR, fields: { ...WARRIOR.fields, 'Class command': changed } } as CatalogEntity
    const markup = renderToStaticMarkup(createElement(DefinitionFactsPanel, { corroboration: { catalog: DEFAULT_CATALOG, entity }, facts: [['Class command', changed]] }))
    expect(markup).toContain('aria-label="Sources for Class command"')
    expect(markup).not.toContain('class="source-summary"')
    expect(renderToStaticMarkup(createElement(SourceReferences, { includeGameExports: true, sources: changed.state === 'known' ? changed.sources ?? [] : [] }))).toContain('class="source-summary"')
  })

  it('keeps partial and conflicting mechanic descriptions visible', () => {
    const full = DEFAULT_CATALOG.entities['base:mechanic:stat:ref-464']!
    const partial = DEFAULT_CATALOG.entities['base:mechanic:stat:ref-631']!
    expect(corroboratedFact({ catalog: DEFAULT_CATALOG, entity: full }, 'Description', full.fields.Description!)).toBe(true)
    expect(corroboratedFact({ catalog: DEFAULT_CATALOG, entity: partial }, 'Description', partial.fields.Description!)).toBe(false)
    const conflicting = DEFAULT_CATALOG.entities['base:mechanic:ability:ref-385']!
    expect(corroboratedFact({ catalog: DEFAULT_CATALOG, entity: conflicting }, 'Description', conflicting.fields.Description!)).toBe(false)
  })
})
