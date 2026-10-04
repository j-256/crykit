import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createBlankLocalData, createPersonalDefinition } from '../domain'
import { personalRef, TEST_NOW } from '../domain/test-helpers'
import { BuildLoadoutSummary, PassiveCapacityMeter, buildPpSummary } from './BuildLoadoutSummary'

describe('passive capacity meter', () => {
  it('lights only known PP and keeps unresolved costs explicit', () => {
    const pp = { knownSubtotal: 9, unresolvedCosts: 1, limit: { state: 'known' as const, value: 10 }, status: 'undetermined' as const }
    const markup = renderToStaticMarkup(<PassiveCapacityMeter pp={pp}/>)

    expect(markup.match(/<svg/g)).toHaveLength(10)
    expect(markup.match(/class="is-lit"/g)).toHaveLength(9)
    expect(markup).toContain('aria-label="Passive capacity: 9 + 1 unresolved of 10 PP used across passives"')
    expect(buildPpSummary(pp)).toBe('9 + 1 unresolved of 10 PP used across passives')
  })

  it('does not invent crystals for an unknown limit', () => {
    const pp = { knownSubtotal: 2, unresolvedCosts: 0, limit: { state: 'unknown' as const }, status: 'undetermined' as const }
    const markup = renderToStaticMarkup(<PassiveCapacityMeter pp={pp}/>)

    expect(markup).not.toContain('passive-capacity__crystals')
    expect(buildPpSummary(pp)).toBe('2 PP used / unknown shared limit')
  })

  it('keeps very large imported limits as text without allocating one icon per point', () => {
    const pp = { knownSubtotal: 2, unresolvedCosts: 0, limit: { state: 'known' as const, value: Number.MAX_SAFE_INTEGER }, status: 'valid' as const }
    const markup = renderToStaticMarkup(<PassiveCapacityMeter pp={pp}/>)
    expect(markup).not.toContain('passive-capacity__crystals')
    expect(markup).toContain(`2 / ${Number.MAX_SAFE_INTEGER} PP`)
  })
})

describe('loadout selection summaries', () => {
  it('shows the sourced command with its class and exposes equipment as keyboard controls', () => {
    const localData = createPersonalDefinition(createBlankLocalData(), { id: personalRef('Synthetic class').definitionId, name: 'Synthetic class', kind: 'class', fields: { Command: { state: 'known', value: 'Synthetic command' }, Weapons: { state: 'known', value: 'Swords' }, Armor: { state: 'known', value: 'Heavy armor' } }, now: TEST_NOW })
    const markup = renderToStaticMarkup(<BuildLoadoutSummary localData={localData} catalogs={[]} equipmentNames content={{ primaryClass: null, secondaryClass: personalRef('Synthetic class'), equipment: {}, passives: [], contextAssumptions: [] }}/>)
    expect(markup).toContain('aria-label="Sub-command: Synthetic command (Synthetic class)"')
    expect(markup.match(/<button/g)).toHaveLength(6)
    expect(markup).toContain('class="build-card__equipment" data-show-names="true"')
    expect(markup).toContain('class="build-card__selection-name">Empty</span>')
    expect(markup).not.toContain('class="sr-only">Empty</span>')
    expect(markup).toContain('Class equipment permissions are not granted by the sub-command.')
    expect(markup).not.toContain('Weapons:')
    expect(markup).not.toContain('Armor:')
    const primaryMarkup = renderToStaticMarkup(<BuildLoadoutSummary localData={localData} catalogs={[]} content={{ primaryClass: personalRef('Synthetic class'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }}/>)
    expect(primaryMarkup).toContain('Weapons: Swords')
    expect(primaryMarkup).toContain('Armor: Heavy armor')
  })

  it('preserves unknown command metadata instead of presenting the class name as a command', () => {
    const localData = createPersonalDefinition(createBlankLocalData(), { id: personalRef('Synthetic class').definitionId, name: 'Synthetic class', kind: 'class', fields: { Command: { state: 'unknown' } }, now: TEST_NOW })
    const markup = renderToStaticMarkup(<BuildLoadoutSummary localData={localData} catalogs={[]} content={{ primaryClass: null, secondaryClass: personalRef('Synthetic class'), equipment: {}, passives: [], contextAssumptions: [] }}/>)
    expect(markup).toContain('Sub-command: Unknown command (Synthetic class)')
  })
})
