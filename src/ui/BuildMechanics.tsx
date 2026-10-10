import { calculationModResolver } from '../domain/calculation-mods'
import { resolveGameRules } from '../domain/game-rules'
import { logicalEntityKey } from '../domain'
import { analyzeBuildEquipment } from '../domain/build-mechanics'
import { calculateBuildStats, physicalHitChance, type StatRange } from '../domain/build-stats'
import { estimateAbility } from '../domain/ability-estimates'
import { nativeStatRecord } from '../domain/pc-stats'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, EntityRef, LocalData, GameSetupRevision, SlotDefinition } from '../domain/types'
import { CombatPreview } from './CombatPreview'
import { AbilityFormulaReference } from './AbilityFormulaReference'
import { Icon } from './icons'
export { CalculationPicker } from './CalculationPicker'
import { Button, Field, InlineNotice } from './components'
import { buildValidityGuidance } from './build-validity-guidance'
import { resolveEntity, resolveCalculationEntity } from './model'
import './build-mechanics.css'

export function formatStatRange(value: StatRange | null): string {
  if (!value) return 'Unknown'
  const format = (number: number) => number.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return value.low === value.high ? format(value.low) : `${format(value.low)} to ${format(value.high)}`
}

const NO_UNKNOWN_INPUTS: readonly string[] = []

export function BuildMechanics({ content, slots, localData, catalogs, gameSetup, onChange, onReviewIssues, onReviewGameSetup, onUploadMod, unknownInputs = NO_UNKNOWN_INPUTS, unknownSecondaryClass = false }: { content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; onChange?: (plan: BuildCalculationPlan | undefined) => void; onReviewIssues?: () => void; onReviewGameSetup?: () => void; onUploadMod?: () => void; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean }) {
  const resolve = (ref: EntityRef) => resolveEntity(localData, catalogs, ref)
  const identity = (ref: EntityRef) => logicalEntityKey(localData, ref)
  const equipment = analyzeBuildEquipment(content, slots, resolve, identity)
  const rules = resolveGameRules(gameSetup, catalogs)
  const calculationResolve = (ref: EntityRef) => resolveCalculationEntity(localData, catalogs, ref, gameSetup)
  const estimate = calculateBuildStats(content, slots, calculationResolve, identity, rules, unknownInputs, unknownSecondaryClass)
  const plan = content.calculation
  const abilityScope = calculationModResolver(calculationResolve)
  const abilityDefinition = plan?.ability ? abilityScope.resolve(plan.ability) : undefined
  const abilityRecord = plan?.ability ? nativeStatRecord(plan.ability, 'ability', abilityScope.resolve, rules.mode ?? plan.pcMode) : undefined
  const ability = abilityDefinition ? estimateAbility(abilityDefinition, estimate.stats, abilityRecord) : undefined
  const accuracy = estimate.stats.ACC.value
  const hitChance = accuracy && accuracy.low === accuracy.high && plan?.targetEvasion != null ? physicalHitChance(accuracy.low, plan.targetEvasion) : null
  const update = (patch: Partial<BuildCalculationPlan>) => onChange?.({ level: null, growth: [], bonuses: [], statuses: [], ...plan, ...patch })
  const numberInput = (value: string) => value.trim() ? Number(value) : null
  const hasSelections = Object.values(content.equipment).some(Boolean) || content.passives.length > 0
  return <section aria-label="Build mechanics" className="build-mechanics stack">
    <div><h3>Equipment checks</h3><details className="equipment-check-coverage"><summary>What these checks cover</summary><p>Checks class permissions, equipment slots, shared copies, and unique items. Sub-commands grant permissions only through an explicit effect.</p></details>
      {equipment.length ? <><ul aria-label="Equipment findings" className="mechanics-findings">{equipment.map((issue, index) => <li data-status={issue.status} key={`${issue.code}:${issue.slotId}:${index}`}><strong>{issue.status === 'invalid' ? 'Conflict' : 'Unresolved'}:</strong> {issue.message}<p className="field__hint">{buildValidityGuidance(issue).message}</p></li>)}</ul>{onReviewIssues && <Button onClick={onReviewIssues} tone="secondary" type="button">Review solutions</Button>}</> : <p role="status">{hasSelections ? 'No known equipment conflicts.' : 'Add equipment to check this build.'}</p>}
    </div>
    <details><summary>Ability and hit-chance preview</summary><div className="stack">
      <CombatPreview onUploadMod={onUploadMod} content={content} slots={slots} localData={localData} catalogs={catalogs} gameSetup={gameSetup} onChange={onChange} unknownInputs={unknownInputs} unknownSecondaryClass={unknownSecondaryClass}/>
      <details className="combat-reference"><summary>Formula reference</summary><div className="stack">
        {abilityScope.issues.size > 0 && <InlineNotice title="Ability preview unresolved">{[...abilityScope.issues].join(' ')} Review enabled mods and their source revisions in Game Setup.{onReviewGameSetup && <Button onClick={onReviewGameSetup} tone="secondary" type="button">Review Game Setup</Button>}</InlineNotice>}
        {ability ? <AbilityFormulaReference ability={ability} abilityName={abilityDefinition?.name ?? 'Selected ability'} definition={abilityDefinition} numericRecord={abilityRecord}/> : <p className="field__hint">Choose an ability to see its base power and learning costs.</p>}
      </div></details>
      <details className="hit-chance-calculator"><summary>Base hit-chance calculator</summary><div className="stack">
        <p className="field__hint">Compare this Build's accuracy with an evasion value. This does not change the battle target.</p>
        <div className="hit-chance-calculator__flow">
          <div className="hit-chance-calculator__accuracy"><span>Build accuracy</span><strong>{formatStatRange(accuracy)}</strong></div>
          <Field label="Target evasion">{onChange ? <input aria-label="Target evasion" min="0" onChange={event => update({ targetEvasion: numberInput(event.target.value) })} type="number" value={plan?.targetEvasion ?? ''}/> : <strong>{plan?.targetEvasion ?? 'Unknown'}</strong>}</Field>
          <div className="hit-chance-calculator__result" aria-label="Base physical hit chance"><span><Icon name="compass"/>Base physical hit chance: </span><strong>{hitChance === null ? 'Unknown' : `${hitChance}%`}</strong></div>
        </div>
        <p className="field__hint">Zero evasion gives 100%. This estimate excludes ability accuracy, hit modifiers, guaranteed hits or misses, difficulty, Luck, and miss protection. Use the battle preview for a specific target.</p>
      </div></details>
    </div></details>
  </section>
}
