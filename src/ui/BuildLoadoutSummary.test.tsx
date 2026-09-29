import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PassiveCapacityMeter, buildPpSummary } from './BuildLoadoutSummary'

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
})
