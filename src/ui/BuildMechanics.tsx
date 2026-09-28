import { useId, useState } from 'react'
import { logicalEntityKey } from '../domain'
import { analyzeBuildEquipment } from '../domain/build-mechanics'
import { calculateBuildStats, CALCULATED_STATS, physicalHitChance, STAT_LABELS, type StatRange } from '../domain/build-stats'
import { ABILITY_COSTS, estimateAbility } from '../domain/ability-estimates'
import { STAT_KEYS } from '../domain/crystal-edit'
import { GUIDE_LEVEL_CAP } from '../domain/growth'
import { GUIDE_MECHANICS_SOURCE } from '../domain/mechanics-facts'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogEntityKind, CatalogSnapshot, EntityRef, Profile, SlotDefinition } from '../domain/types'
import { BuildDefinitionField, BUILD_DEFINITION_PAGE_SIZE } from './BuildDefinitionField'
import { Button, Field, InlineNotice } from './components'
import { resolveEntity } from './model'
import { SourceSummary } from './KnowledgeValue'
import './build-mechanics.css'

export function formatStatRange(value: StatRange | null): string {
  if (!value) return 'Unknown'
  const format = (number: number) => number.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return value.low === value.high ? format(value.low) : `${format(value.low)} to ${format(value.high)}`
}

function CalculationPicker({ label, kinds, value, onChange }: { label: string; kinds: readonly CatalogEntityKind[]; value: EntityRef | null; onChange: (ref: EntityRef | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(BUILD_DEFINITION_PAGE_SIZE)
  return <BuildDefinitionField allowedKinds={kinds} label={label} onChange={onChange} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} onInspect={() => undefined} onOpen={() => setOpen(true)} onQueryChange={value => { setQuery(value); setLimit(BUILD_DEFINITION_PAGE_SIZE) }} onResultLimitChange={setLimit} open={open} query={query} resultLimit={limit} value={value}/>
}

export function BuildMechanics({ content, slots, profile, catalogs, onChange }: { content: BuildRevisionContent; slots: readonly SlotDefinition[]; profile: Profile; catalogs: readonly CatalogSnapshot[]; onChange: (plan: BuildCalculationPlan | undefined) => void }) {
  const id = useId()
  const resolve = (ref: EntityRef) => resolveEntity(profile, catalogs, ref)
  const identity = (ref: EntityRef) => logicalEntityKey(profile, ref)
  const equipment = analyzeBuildEquipment(content, slots, resolve, identity)
  const estimate = calculateBuildStats(content, slots, resolve, identity)
  const plan = content.calculation
  const abilityDefinition = plan?.ability ? resolve(plan.ability) : undefined
  const ability = abilityDefinition ? estimateAbility(abilityDefinition, estimate.stats) : undefined
  const accuracy = estimate.stats.ACC.value
  const hitChance = accuracy && accuracy.low === accuracy.high && plan?.targetEvasion != null ? physicalHitChance(accuracy.low, plan.targetEvasion) : null
  const update = (patch: Partial<BuildCalculationPlan>) => onChange({ level: null, growth: [], bonuses: [], statuses: [], ...plan, ...patch })
  const numberInput = (value: string) => value.trim() ? Number(value) : null
  const hasSelections = Object.values(content.equipment).some(Boolean) || content.passives.length > 0
  return <section aria-label="Build mechanics" className="build-mechanics stack">
    <div><h3>Equipment checks</h3><p>Primary-class permissions, selected permission effects, equipment roles, shared copies, and known unique flags. Sub-commands supply equipment permissions only through an explicit effect.</p>
      {equipment.length ? <ul aria-label="Equipment findings" className="mechanics-findings">{equipment.map((issue, index) => <li data-status={issue.status} key={`${issue.code}:${issue.slotId}:${index}`}><strong>{issue.status === 'invalid' ? 'Conflict' : 'Unresolved'}:</strong> {issue.message}</li>)}</ul> : <p role="status">{hasSelections ? 'No conflict found in the supported equipment checks.' : 'Add equipment to check this build.'}</p>}
    </div>
    <details className="build-calculation"><summary>Stats & combat estimates{plan ? ` · level ${plan.level ?? 'unknown'}` : ''}</summary><div className="stack">
      <p>Plan growth explicitly. These inputs are saved with the build checkpoint and do not change recorded character stats.</p>
      <div className="cluster"><Field label="Planned level"><input aria-label="Planned level" max={GUIDE_LEVEL_CAP} min="1" onChange={event => update({ level: numberInput(event.target.value) })} type="number" value={plan?.level ?? ''}/></Field><Button disabled={!content.primaryClass || !plan?.level} onClick={() => update({ growth: [{ classRef: content.primaryClass, levels: plan?.level ?? null }] })} tone="secondary" type="button">Use primary class for all growth</Button></div>
      {(plan?.growth ?? []).map((row, index) => <div className="mechanics-growth-row" key={index}>
        <CalculationPicker kinds={['class']} label={`Planned growth class ${index + 1}`} onChange={classRef => update({ growth: plan!.growth.map((current, position) => position === index ? { ...current, classRef } : current) })} value={row.classRef}/>
        <Field label={`Planned growth levels ${index + 1}`}><input aria-label={`Planned growth levels ${index + 1}`} max={GUIDE_LEVEL_CAP} min="0" onChange={event => update({ growth: plan!.growth.map((current, position) => position === index ? { ...current, levels: numberInput(event.target.value) } : current) })} type="number" value={row.levels ?? ''}/></Field>
        <Button onClick={() => update({ growth: plan!.growth.filter((_, position) => position !== index) })} tone="quiet" type="button">Remove growth {index + 1}</Button>
      </div>)}
      <Button disabled={(plan?.growth.length ?? 0) >= GUIDE_LEVEL_CAP} onClick={() => update({ growth: [...(plan?.growth ?? []), { classRef: null, levels: null }] })} tone="secondary" type="button">Add planned growth class</Button>
      <details><summary>Optional stat bonuses</summary><p>The guide's per-stat gender bonuses. Choose only the bonuses to include in this plan.</p><div className="cluster">{STAT_KEYS.map(stat => <label className="check-row" htmlFor={`${id}-${stat}`} key={stat}><input checked={plan?.bonuses.includes(stat) ?? false} id={`${id}-${stat}`} onChange={event => update({ bonuses: event.target.checked ? [...(plan?.bonuses ?? []), stat] : plan!.bonuses.filter(value => value !== stat) })} type="checkbox"/>{stat}</label>)}</div></details>
      <details><summary>Planned active statuses</summary><p>Selected statuses are calculation assumptions. Conditional triggers, timing, damage multipliers, and reactions remain listed as excluded effects.</p>{(plan?.statuses ?? []).map((ref, index) => <div className="mechanics-status-row" key={identity(ref)}><span>{resolve(ref)?.name ?? 'Unresolved status'}</span><Button onClick={() => update({ statuses: plan!.statuses.filter((_, position) => position !== index) })} tone="quiet" type="button">Remove status {index + 1}</Button></div>)}<CalculationPicker kinds={['status']} label="Add planned status" onChange={ref => { if (ref && !plan?.statuses.some(current => identity(current) === identity(ref))) update({ statuses: [...(plan?.statuses ?? []), ref] }) }} value={null}/></details>
      {estimate.issues.length > 0 && <InlineNotice title="Calculation notes"><ul>{estimate.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
      <div className="structured-value__table"><table aria-label="Build stat estimates"><thead><tr><th>Stat</th><th>Supported estimate</th><th>Base</th><th>Flat additions</th><th>Additive %</th></tr></thead><tbody>{CALCULATED_STATS.map(stat => <tr key={stat}><th scope="row">{STAT_LABELS[stat]}</th><td>{formatStatRange(estimate.stats[stat].value)}</td><td>{formatStatRange(estimate.stats[stat].base)}</td><td>{estimate.stats[stat].flat || '-'}</td><td>{estimate.stats[stat].percent ? `${estimate.stats[stat].percent}%` : '-'}</td></tr>)}</tbody></table></div>
      <p className="field__hint">Estimates include the supported contributions below, even when equipment conflicts exist. Ranges compare flat-before-percent and flat-after-percent ordering; they are not guaranteed game bounds. Fractions are retained before display. Crit bonus damage is the extra percentage added by a critical hit. Final damage, game rounding, and caps are not simulated.</p>
      <details><summary>Ability and hit-chance preview</summary><div className="stack"><CalculationPicker kinds={['ability', 'monsterMagic']} label="Preview ability" onChange={ability => update({ ability })} value={plan?.ability ?? null}/>
        {ability && <div aria-label="Ability estimate"><p><strong>Base amount before defense and other effects: {formatStatRange(ability.baseAmount)}</strong></p>{ability.formula && <p>Documented coefficients: {ability.formula}</p>}<dl className="definition-list">{ABILITY_COSTS.map(cost => <div className="definition-row" key={cost}><dt>{cost === 'HP' ? 'HP cost (% of max)' : cost === 'CT' ? 'CT delay' : cost === 'CD' ? 'Cooldown' : `${cost} cost`}</dt><dd>{ability.costs[cost] ?? 'Unknown'}{cost === 'CD' && ability.costs.CD != null && ability.costs.CD > 0 ? ` (${ability.costs.CD + 1} turns including the casting turn)` : ''}</dd></div>)}{ability.learning && <div className="definition-row"><dt>Learn cost</dt><dd>{ability.learning.jp} JP; display {ability.learning.displayedLp} LP; {ability.learning.requiredWholeLp} whole LP needed</dd></div>}</dl><p>Listed costs exclude cost modifiers. The selected ability is a preview, not a claim that this build can use it. Defense, crits, variance, targets, and conditional effects are not applied.</p>{ability.notes.length > 0 && <ul>{ability.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}</div>}
        <Field label="Target evasion"><input aria-label="Target evasion" min="0" onChange={event => update({ targetEvasion: numberInput(event.target.value) })} type="number" value={plan?.targetEvasion ?? ''}/></Field><p aria-label="Base physical hit chance">Base physical hit chance: {hitChance === null ? 'Unknown' : `${hitChance}%`}</p><p className="field__hint">Uses the guide's accuracy/evasion steps before ability and passive overrides. Missing curve intervals and zero target evasion remain unknown.</p>
      </div></details>
      <details><summary>Included contributions ({estimate.contributions.length})</summary>{estimate.contributions.length ? <ul>{estimate.contributions.map((entry, index) => <li key={index}>{entry.label}: {entry.value > 0 ? '+' : ''}{entry.value}{entry.kind === 'percent' ? '%' : ''} {STAT_LABELS[entry.stat]}</li>)}</ul> : <p>No supported numeric contributions selected.</p>}</details>
      <details open={estimate.excluded.length > 0}><summary>Effects outside this estimate ({estimate.excluded.length})</summary>{estimate.excluded.length ? <ul>{estimate.excluded.map(effect => <li key={effect}>{effect}</li>)}</ul> : <p>No additional effects were found in the supplied fields. Missing source data can still affect totals.</p>}</details>
      <SourceSummary source={GUIDE_MECHANICS_SOURCE}/>
      {plan && <Button onClick={() => onChange(undefined)} tone="quiet" type="button">Clear calculation inputs</Button>}
    </div></details>
  </section>
}
