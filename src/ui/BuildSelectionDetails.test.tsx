import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain'
import { CLASS_FIELDS } from '../domain/crystal-edit'
import { BuildSelectionDetails, BuildSelectionFacts } from './BuildSelectionDetails'
import { buildDefinitionOptions } from './definitions'

const options = buildDefinitionOptions(createBlankLocalData(), [DEFAULT_CATALOG])

describe('selection inspector facts', () => {
  it('shows the granted ability list for a sub-command and quiets its corroborated class evidence', () => {
    const cleric = options.find(option => option.kind === 'class' && option.name === 'Cleric')!
    const before = JSON.stringify(cleric.record)
    const inspector = renderToStaticMarkup(<BuildSelectionDetails catalogs={[DEFAULT_CATALOG]} localData={createBlankLocalData()} option={cleric} showClassPermissions={false}/>)
    expect(inspector).toContain('White Magic')
    expect(inspector).not.toMatch(/growth|stat-ratings|Weapons|Armor|Innate|equipment permissions|Sources for Cleric/)
    expect(inspector).toContain('Cure details')
    expect(inspector).not.toContain('<dt><span>Command</span></dt>')
    const facts = renderToStaticMarkup(<BuildSelectionFacts option={cleric} showClassPermissions={false}/>)
    expect(facts).toContain('Command: White Magic')
    expect(facts).not.toMatch(/Weapons|Armor|Innate/)
    expect(JSON.stringify(cleric.record)).toBe(before)
  })

  it('keeps evidence for changed, uncertain, or imported commands instead of inheriting native trust', () => {
    const cleric = options.find(option => option.kind === 'class' && option.name === 'Cleric')!
    const command = cleric.record.fields[CLASS_FIELDS.command]!
    const native = { sourceId: 'native-game:windows:1.6.9', locator: 'Synthetic changed command' }
    const changed = { state: 'known' as const, value: 'Synthetic command', sources: [native] }
    for (const value of [changed, { state: 'unknown' as const, sources: [native] }, { state: 'conflicting' as const, claims: [{ value: 'Synthetic command', sources: [native] }, { value: 'White Magic', sources: [] }] }]) {
      const option = { ...cleric, record: { ...cleric.record, fields: { ...cleric.record.fields, [CLASS_FIELDS.command]: value } } }
      expect(renderToStaticMarkup(<BuildSelectionDetails catalogs={[DEFAULT_CATALOG]} option={option} showClassPermissions={false}/>)).toContain('Sources for Cleric')
    }
    const unpinned = { ...DEFAULT_CATALOG, checksum: 'synthetic-import-checksum' }
    expect(renderToStaticMarkup(<BuildSelectionDetails catalogs={[unpinned]} option={cleric} showClassPermissions={false}/>)).toContain('Sources for Cleric')
    const unknown = { ...cleric, record: { ...cleric.record, fields: { ...cleric.record.fields, [CLASS_FIELDS.command]: { state: 'unknown' as const } } } }
    const inspector = renderToStaticMarkup(<BuildSelectionDetails catalogs={[DEFAULT_CATALOG]} option={unknown} showClassPermissions={false}/>)
    expect(inspector).toContain('Unknown')
    expect(inspector).not.toContain('White Magic')
    expect(command.state).toBe('known')
  })

  it('keeps native-only facts visible without a marker and retains external or disputed evidence', () => {
    const option = options.find(option => option.name === 'HP Boost')!
    const native = { sourceId: 'native-game:windows:1.6.9', locator: 'Synthetic native passive' }
    const record = { ...option.record, rawDescription: undefined, fields: { Description: { state: 'known' as const, value: 'Synthetic native effect', sources: [native] } }, sources: [native] }
    const onlyNative = { ...option, record, ppCost: { state: 'known' as const, value: 4, sources: [native] } }
    const markup = renderToStaticMarkup(<BuildSelectionDetails option={onlyNative}/>)
    expect(markup).toContain('Synthetic native effect')
    expect(markup).toContain('4 PP')
    expect(markup).not.toContain('aria-label="Sources')
    const external = { ...onlyNative, record: { ...record, sources: [...record.sources, { sourceId: 'https://example.com/wiki', locator: 'Synthetic guide' }] } }
    expect(renderToStaticMarkup(<BuildSelectionDetails option={external}/>)).toContain('Sources for HP Boost')
    expect(renderToStaticMarkup(<BuildSelectionDetails option={{ ...onlyNative, ppCost: { state: 'unknown', sources: [native] } }}/>)).toContain('Sources for HP Boost')
  })

  it('shows passive PP once outside the original-source disclosure', () => {
    const passive = options.find(option => option.name === 'HP Boost')!
    const markup = renderToStaticMarkup(<BuildSelectionDetails option={passive}/>)
    const visible = markup
    expect(visible.match(/4 PP/g)).toHaveLength(1)
    expect(visible).not.toMatch(/PP: 4|Cost: 4/)
    expect(markup).toContain('Sources for HP Boost')
  })

  it('shows supported native numbers and keeps historical attribution behind Sources', () => {
    const shoes = options.find(option => option.name === 'Acrobat Shoes')!
    const markup = renderToStaticMarkup(<BuildSelectionFacts option={shoes}/>)
    expect(markup).toContain('Dexterity: +14')
    expect(markup).not.toMatch(/Dexterity: \+16|Dexterity \+6/)
    expect(markup).not.toContain('Source stat values differ')
    const inspector = renderToStaticMarkup(<BuildSelectionDetails option={shoes}/>)
    expect(inspector).toContain('Sources for Acrobat Shoes')
    expect(inspector).not.toContain('equipment 320')
    const comparison = renderToStaticMarkup(<BuildSelectionDetails comparedWith={options.find(option => option.name === 'Beads of Defense')} option={shoes}/>)
    expect(comparison).toContain('Dexterity: +14')
    expect(comparison).not.toMatch(/Dexterity: \+16|Dexterity \+6/)
  })

  it('shows each passive cost once in its own comparison column', () => {
    const hpBoost = options.find(option => option.name === 'HP Boost')!
    const counter = options.find(option => option.kind === 'passive' && option.name === 'Counter')!
    const visible = renderToStaticMarkup(<BuildSelectionDetails comparedWith={hpBoost} option={counter}/>)
    const columns = [...visible.matchAll(/<td>(.*?)<\/td>/g)].map(match => match[1]!)
    expect(columns).toHaveLength(2)
    expect(columns[0]).toContain('4 PP')
    expect(columns[1]).toContain('3 PP')
    expect(visible.match(/4 PP/g)).toHaveLength(1)
    expect(visible.match(/3 PP/g)).toHaveLength(1)
    expect(visible).not.toMatch(/PP: [34]|Cost: [34]/)
  })
})
