import type { ActiveStatusImpact, ActiveStatusImpactChoice, StatusImpactValues } from '../domain/combat-status-impact'
import { Field } from './components'

interface ImpactMetric {
  readonly key: string
  readonly label: string
  readonly before: number | null
  readonly after: number | null
  readonly reasons: readonly string[]
  readonly unit?: 'chance' | 'amount'
}

const CHANCE_METRICS = { hitChance: 'Hit chance', criticalChance: 'Critical chance' } as const
const COST_METRICS = { HP: 'HP cost', MP: 'MP cost', AP: 'AP cost', CT: 'CT delay', CD: 'Cooldown' } as const
const formatNumber = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })
const signedNumber = (value: number) => `${value > 0 ? '+' : ''}${formatNumber(value)}`

function impactMetrics(before: StatusImpactValues, after: StatusImpactValues): readonly ImpactMetric[] {
  const reasons = (key: string) => [...new Set([...(before.unavailable[key] ?? []), ...(after.unavailable[key] ?? [])])]
  return [
    { key: 'damage', label: 'Damage', before: before.damage, after: after.damage, reasons: reasons('Damage'), unit: 'amount' },
    { key: 'criticalDamage', label: 'Critical damage', before: before.criticalDamage, after: after.criticalDamage, reasons: reasons('Critical damage'), unit: 'amount' },
    ...Object.entries(CHANCE_METRICS).map(([key, label]) => ({ key, label, before: before[key as keyof typeof CHANCE_METRICS], after: after[key as keyof typeof CHANCE_METRICS], reasons: reasons(label), unit: 'chance' as const })),
    ...Object.entries(COST_METRICS).map(([key, label]) => ({ key, label, before: before.costs[key as keyof typeof COST_METRICS], after: after.costs[key as keyof typeof COST_METRICS], reasons: reasons(`${key} cost`) })),
  ]
}

function ImpactRow({ metric, name, automatic }: { readonly metric: ImpactMetric; readonly name: string; readonly automatic: boolean }) {
  const { before, after } = metric
  const healing = metric.unit === 'amount' && (before !== null && before < 0 || after !== null && after < 0)
  const mixed = healing && (before !== null && before > 0 || after !== null && after > 0)
  const label = mixed ? metric.label.replace('damage', 'damage / healing').replace('Damage', 'Damage / healing') : healing ? metric.label.replace('damage', 'healing').replace('Damage', 'Healing') : metric.label
  const valueText = (value: number | null) => value === null ? 'Unknown' : `${formatNumber(metric.unit === 'amount' ? Math.abs(value) : value)}${metric.unit === 'chance' ? '%' : ''}${mixed ? value < 0 ? ' healing' : ' damage' : ''}`
  const delta = before === null || after === null ? null : healing ? Math.abs(after) - Math.abs(before) : after - before
  return <div className="combat-impact__metric" data-metric={metric.key}>
    <dt>{label}</dt>
    <dd>
      <div className="combat-impact__flow">
        <div><span className="combat-impact__value-label">{automatic ? 'Without selection' : `Without ${name}`}</span><strong>{valueText(before)}</strong></div>
        <span className="combat-impact__arrow" aria-hidden="true">{'\u2192'}</span>
        <div><span className="combat-impact__value-label">{automatic ? 'Current scenario' : `With ${name}`}</span><strong>{valueText(after)}</strong></div>
        {delta !== null && !mixed && <span className="combat-impact__delta">{signedNumber(delta)}{metric.unit === 'chance' ? ' pp' : ''}</span>}
      </div>
      {(before === null || after === null) && <small>{metric.reasons.join('; ') || 'The comparison needs more known inputs.'}</small>}
    </dd>
  </div>
}

export function CombatStatusImpact({ choices, selected, impact, onSelect }: {
  readonly choices: readonly ActiveStatusImpactChoice[]
  readonly selected: ActiveStatusImpactChoice
  readonly impact: ActiveStatusImpact
  readonly onSelect: (key: string) => void
}) {
  const metrics = impactMetrics(impact.without, impact.current)
  const changed = metrics.filter(metric => metric.before !== metric.after)
  const unknown = metrics.some(metric => metric.before === null || metric.after === null)
  return <section className="combat-impact" aria-label="Status impact">
    <div className="combat-impact__heading"><h5>Status impact</h5><span>{selected.recipient === 'user' ? 'Your character' : 'Target'}</span></div>
    {choices.length > 1 ? <Field label="Compare active status"><select value={selected.key} onChange={event => onSelect(event.target.value)}>{choices.map(choice => <option value={choice.key} key={choice.key}>{choice.name} ({choice.recipient === 'user' ? 'your character' : 'target'})</option>)}</select></Field> : <strong className="combat-impact__name">{selected.name}</strong>}
    {changed.length > 0 ? <dl className="combat-impact__metrics">{changed.map(metric => <ImpactRow metric={metric} name={selected.name} automatic={impact.automaticStatus !== 'none'} key={metric.key}/>)}</dl> : <p className="field__hint">{unknown ? 'No known change to this ability\'s damage, chances, or costs. Some outcomes are unresolved.' : 'No change to this ability\'s damage, chances, or costs.'}</p>}
    {impact.notes.map(note => <p className="field__hint" key={note}>{note}</p>)}
    <p className="field__hint">Removes one status at a time, keeping other conditions the same. The differences do not add together.</p>
  </section>
}
