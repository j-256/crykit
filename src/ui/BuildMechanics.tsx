import { calculationModResolver } from '../domain/calculation-mods'
import { resolveGameRules } from '../domain/game-rules'
import { useState } from 'react'
import { logicalEntityKey } from '../domain'
import { analyzeBuildEquipment } from '../domain/build-mechanics'
import { calculateBuildStats, physicalHitChance, type StatRange } from '../domain/build-stats'
import { ABILITY_COSTS, estimateAbility } from '../domain/ability-estimates'
import { nativeStatRecord } from '../domain/pc-stats'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogEntityKind, CatalogSnapshot, EntityRef, LocalData, GameSetupRevision, SlotDefinition } from '../domain/types'
import { BuildDefinitionField, BUILD_DEFINITION_PAGE_SIZE } from './BuildDefinitionField'
import { Field, InlineNotice } from './components'
import { resolveEntity, resolveCalculationEntity } from './model'
import './build-mechanics.css'

export function formatStatRange(value: StatRange | null): string {
  if (!value) return 'Unknown'
  const format = (number: number) => number.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return value.low === value.high ? format(value.low) : `${format(value.low)} to ${format(value.high)}`
}

export function CalculationPicker({ label, kinds, value, gameSetup, onChange }: { gameSetup?: GameSetupRevision; label: string; kinds: readonly CatalogEntityKind[]; value: EntityRef | null; onChange: (ref: EntityRef | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(BUILD_DEFINITION_PAGE_SIZE)
  return <BuildDefinitionField gameSetup={gameSetup} allowedKinds={kinds} label={label} onChange={onChange} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} onInspect={() => undefined} onOpen={() => setOpen(true)} onQueryChange={value => { setOpen(true); setQuery(value); setLimit(BUILD_DEFINITION_PAGE_SIZE) }} onResultLimitChange={setLimit} open={open} query={query} resultLimit={limit} value={value}/>
}

const NO_UNKNOWN_INPUTS: readonly string[] = []

export function BuildMechanics({ content, slots, localData, catalogs, gameSetup, onChange, unknownInputs = NO_UNKNOWN_INPUTS, unknownSecondaryClass = false }: { content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; onChange?: (plan: BuildCalculationPlan | undefined) => void; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean }) {
  const resolve = (ref: EntityRef) => resolveEntity(localData, catalogs, ref)
  const identity = (ref: EntityRef) => logicalEntityKey(localData, ref)
  const equipment = analyzeBuildEquipment(content, slots, resolve, identity)
  const rules = resolveGameRules(gameSetup, catalogs)
  const calculationResolve = (ref: EntityRef) => resolveCalculationEntity(localData, catalogs, ref, gameSetup)
  const estimate = calculateBuildStats(content, slots, calculationResolve, identity, rules, unknownInputs, unknownSecondaryClass)
  const plan = content.calculation
  const abilityScope = calculationModResolver(calculationResolve)
  const abilityDefinition = plan?.ability ? abilityScope.resolve(plan.ability) : undefined
  const ability = abilityDefinition ? estimateAbility(abilityDefinition, estimate.stats, nativeStatRecord(plan!.ability!, 'ability', abilityScope.resolve, rules.mode ?? plan?.pcMode)) : undefined
  const accuracy = estimate.stats.ACC.value
  const hitChance = accuracy && accuracy.low === accuracy.high && plan?.targetEvasion != null ? physicalHitChance(accuracy.low, plan.targetEvasion) : null
  const update = (patch: Partial<BuildCalculationPlan>) => onChange?.({ level: null, growth: [], bonuses: [], statuses: [], ...plan, ...patch })
  const numberInput = (value: string) => value.trim() ? Number(value) : null
  const hasSelections = Object.values(content.equipment).some(Boolean) || content.passives.length > 0
  return <section aria-label="Build mechanics" className="build-mechanics stack">
    <div><h3>Equipment checks</h3><p>Primary-class permissions, selected permission effects, equipment roles, shared copies, and known unique flags. Sub-commands supply equipment permissions only through an explicit effect.</p>
      {equipment.length ? <ul aria-label="Equipment findings" className="mechanics-findings">{equipment.map((issue, index) => <li data-status={issue.status} key={`${issue.code}:${issue.slotId}:${index}`}><strong>{issue.status === 'invalid' ? 'Conflict' : 'Unresolved'}:</strong> {issue.message}</li>)}</ul> : <p role="status">{hasSelections ? 'No conflict found in the supported equipment checks.' : 'Add equipment to check this build.'}</p>}
    </div>
    <p>Native calculated stats and growth are on the Loadout tab.</p>
    <details><summary>Ability and hit-chance preview</summary><div className="stack">{onChange && <CalculationPicker gameSetup={gameSetup} kinds={['ability', 'monsterMagic']} label="Preview ability" onChange={ability => update({ ability })} value={plan?.ability ?? null}/>}
      {abilityScope.issues.size > 0 && <InlineNotice title="Ability preview unresolved">{[...abilityScope.issues].join(' ')}</InlineNotice>}
      {ability && <div aria-label="Ability estimate"><h4>{abilityDefinition?.name}</h4><p><strong>Native coefficient power before battle effects: {formatStatRange(ability.baseAmount)}</strong></p><dl className="definition-list">{ABILITY_COSTS.map(cost => <div className="definition-row" key={cost}><dt>{cost === 'HP' ? 'HP cost (% of max)' : cost === 'CT' ? 'CT delay' : cost === 'CD' ? 'Cooldown' : `${cost} cost`}</dt><dd>{ability.costs[cost] ?? 'Unknown'}</dd></div>)}<div className="definition-row"><dt>Learn cost</dt><dd>{ability.learning ? `${ability.learning.jp} JP; display ${ability.learning.displayedLp} LP; ${ability.learning.requiredWholeLp} whole LP needed` : 'Unknown'}</dd></div></dl><p>Listed native cost parameters exclude cost modifiers. The selected ability is a preview, not a claim that this build can use it. Coefficient power excludes resource-based and contextual power, defense, crits, variance, and targets. Negative power represents healing.</p>{ability.notes.length > 0 && <ul>{ability.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}</div>}
      {onChange && <Field label="Target evasion"><input aria-label="Target evasion" min="0" onChange={event => update({ targetEvasion: numberInput(event.target.value) })} type="number" value={plan?.targetEvasion ?? ''}/></Field>}<p aria-label="Base physical hit chance">Base physical hit chance: {hitChance === null ? 'Unknown' : `${hitChance}%`}</p><p className="field__hint">Native PC 1.6.9.0 accuracy/evasion curve with integer truncation and single-precision interpolation. Zero evasion yields 100%. This stage excludes ability accuracy, hit modifiers, guaranteed overrides, difficulty, Luck, and miss protection; it is not the selected ability's final hit chance.</p>
    </div></details>
  </section>
}
