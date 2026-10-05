import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ActiveStatusImpact, ActiveStatusImpactChoice, StatusImpactValues } from '../domain/combat-status-impact'
import type { CatalogRef } from '../domain/types'
import { CombatStatusImpact } from './CombatStatusImpact'

const selected: ActiveStatusImpactChoice = {
  key: 'user:power-up', name: 'Power Up', recipient: 'user',
  ref: { kind: 'catalog', catalogId: 'synthetic', catalogRevisionId: 'synthetic-revision', entityId: 'synthetic-power-up' } as CatalogRef,
}
const values = (patch: Partial<StatusImpactValues> = {}): StatusImpactValues => ({ damage: 947, criticalDamage: 1429, hitChance: 100, criticalChance: 0, costs: { HP: 0, MP: 0, AP: 12, CT: 25, CD: 0 }, unavailable: {}, ...patch })
const impact = (patch: Partial<ActiveStatusImpact> = {}): ActiveStatusImpact => ({ without: values(), current: values({ damage: 1278, criticalDamage: 1929 }), automaticStatus: 'none', notes: [], ...patch })
const render = (comparison = impact(), choices: readonly ActiveStatusImpactChoice[] = [selected]) => renderToStaticMarkup(<CombatStatusImpact choices={choices} selected={selected} impact={comparison} onSelect={() => undefined}/>)
const metric = (markup: string, key: string) => markup.match(new RegExp(`data-metric="${key}"[\\s\\S]*?</dd>`))?.[0] ?? ''

describe('combat status impact', () => {
  it('shows changed outcomes with named before and after values while omitting unchanged metrics', () => {
    const markup = render()
    expect(markup).toContain('aria-label="Status impact"')
    expect(markup).toContain('Your character')
    expect(markup).not.toContain('<select')
    expect(metric(markup, 'damage')).toContain('Without Power Up')
    expect(metric(markup, 'damage')).toContain('<strong>947</strong>')
    expect(metric(markup, 'damage')).toContain('With Power Up')
    expect(metric(markup, 'damage')).toContain('<strong>1,278</strong>')
    expect(metric(markup, 'damage')).toContain('>+331</span>')
    expect(metric(markup, 'criticalDamage')).toContain('<strong>1,429</strong>')
    expect(metric(markup, 'criticalDamage')).toContain('<strong>1,929</strong>')
    expect(metric(markup, 'criticalDamage')).toContain('>+500</span>')
    expect(markup).not.toContain('data-metric="hitChance"')
    expect(markup).not.toContain('data-metric="AP"')
    expect(markup).toContain('differences are not additive')
  })

  it('labels healing as positive magnitudes and shows the change in healing amount', () => {
    const markup = render(impact({ without: values({ damage: -100, criticalDamage: -150 }), current: values({ damage: -160, criticalDamage: -240 }) }))
    expect(metric(markup, 'damage')).toContain('<dt>Healing</dt>')
    expect(metric(markup, 'damage')).toContain('<strong>100</strong>')
    expect(metric(markup, 'damage')).toContain('<strong>160</strong>')
    expect(metric(markup, 'damage')).toContain('>+60</span>')
    expect(metric(markup, 'criticalDamage')).toContain('<dt>Critical healing</dt>')
    expect(metric(markup, 'criticalDamage')).toContain('>+90</span>')
    expect(markup).not.toContain('>-100<')
  })

  it('distinguishes damage from healing when the sign changes without displaying a misleading delta', () => {
    const markup = render(impact({ without: values({ damage: 100, criticalDamage: 200 }), current: values({ damage: -100, criticalDamage: -300 }) }))
    expect(metric(markup, 'damage')).toContain('<dt>Damage / healing</dt>')
    expect(metric(markup, 'damage')).toContain('<strong>100 damage</strong>')
    expect(metric(markup, 'damage')).toContain('<strong>100 healing</strong>')
    expect(metric(markup, 'criticalDamage')).toContain('<dt>Critical damage / healing</dt>')
    expect(markup).not.toContain('combat-impact__delta')
  })

  it('keeps an unknown side and its reason visible without inventing a difference', () => {
    const markup = render(impact({ current: values({ damage: null, unavailable: { Damage: ['Actor current HP is unknown'] } }) }))
    expect(metric(markup, 'damage')).toContain('<strong>947</strong>')
    expect(metric(markup, 'damage')).toContain('<strong>Unknown</strong>')
    expect(metric(markup, 'damage')).toContain('Actor current HP is unknown')
    expect(metric(markup, 'damage')).not.toContain('combat-impact__delta')
  })

  it('distinguishes unchanged known outcomes from a comparison with unresolved outcomes', () => {
    const unchanged = render(impact({ current: values() }))
    expect(unchanged).toContain('No change to this ability')
    expect(unchanged).not.toContain('data-metric=')
    expect(unchanged).not.toContain('unresolved')
    const unknown = values({ damage: null, criticalDamage: null })
    const unresolved = render(impact({ without: unknown, current: unknown }))
    expect(unresolved).toContain('No known change to this ability')
    expect(unresolved).toContain('Some outcomes are unresolved.')
  })

  it.each(['retained', 'uncertain', 'unknown'] as const)('uses selection labels when automatic status presence is %s', automaticStatus => {
    const note = `Automatic status presence is ${automaticStatus}.`
    const markup = render(impact({ automaticStatus, notes: [note] }))
    expect(markup).toContain('Without selection')
    expect(markup).toContain('Current scenario')
    expect(markup).not.toContain('Without Power Up')
    expect(markup).not.toContain('With Power Up')
    expect(markup).toContain(note)
  })

  it('labels percentage-point changes and signed cost changes separately', () => {
    const markup = render(impact({ current: values({ hitChance: 85, costs: { ...values().costs, AP: 8 } }) }))
    expect(metric(markup, 'hitChance')).toContain('<strong>100%</strong>')
    expect(metric(markup, 'hitChance')).toContain('<strong>85%</strong>')
    expect(metric(markup, 'hitChance')).toContain('>-15 pp</span>')
    expect(metric(markup, 'AP')).toContain('<dt>AP cost</dt>')
    expect(metric(markup, 'AP')).toContain('>-4</span>')
  })

  it('offers explicitly labeled actor and target choices when several statuses are present', () => {
    const target: ActiveStatusImpactChoice = { ...selected, key: 'target:power-up', recipient: 'target' }
    const markup = render(impact(), [selected, target])
    expect(markup).toContain('Compare active status')
    expect(markup).toContain('<select')
    expect(markup).toContain('value="user:power-up" selected=""')
    expect(markup).toContain('Power Up (your character)')
    expect(markup).toContain('Power Up (target)')
  })
})
