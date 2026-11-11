import { useMemo, useState } from 'react'
import { withoutRetainedMechanics } from '../domain/retained-selections'
import { calculationModResolver } from '../domain/calculation-mods'
import { resolveGameRules } from '../domain/game-rules'
import { logicalEntityKey } from '../domain'
import { analyzeBuildEquipment } from '../domain/build-mechanics'
import { calculateBuildStats, physicalHitChance, type StatRange } from '../domain/build-stats'
import { estimateAbility } from '../domain/ability-estimates'
import { nativeStatRecord } from '../domain/pc-stats'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, EntityRef, LocalData, GameSetupRevision, SlotDefinition } from '../domain/types'
import { DefinitionProvider } from './definitions'
import { CombatPreview } from './CombatPreview'
import { AbilityFormulaReference } from './AbilityFormulaReference'
import { BuildDisclosure } from './BuildDisclosure'
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

type BuildMechanicsProps = { content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; onChange?: (plan: BuildCalculationPlan | undefined) => void; onReviewIssues?: () => void; onReviewGameSetup?: () => void; onUploadMod?: () => void; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean }

const rejectPreviewDefinitionSave = async (): Promise<EntityRef> => { throw new Error('Definitions cannot be changed from this preview') }

export function BuildMechanics(props: BuildMechanicsProps) {
  const [preview, setPreview] = useState<{ source: BuildRevisionContent; setup?: GameSetupRevision; plan?: BuildCalculationPlan }>()
  // Read-only sheets keep experiments in component state; a different source or setup invalidates them
  const changed = !props.onChange && preview?.source === props.content && preview?.setup === props.gameSetup
  const content = changed ? { ...props.content, calculation: preview.plan } : props.content
  const onChange = props.onChange ?? ((plan: BuildCalculationPlan | undefined) => setPreview({ source: props.content, setup: props.gameSetup, plan }))
  const scopedData = useMemo(() => props.gameSetup ? { ...props.localData, planningGameSetupRevisionId: props.gameSetup.id, gameSetups: { ...props.localData.gameSetups, [props.gameSetup.id]: props.gameSetup } } : props.localData, [props.localData, props.gameSetup])
  const mechanics = <BuildMechanicsContent {...props} content={content} onChange={onChange} temporaryPreview={!props.onChange} onResetPreview={changed ? () => setPreview(undefined) : undefined}/>
  // Shared projections may use a different catalog pin than the viewer's active planning setup
  // Keep their pickers inside the same source scope as the calculations, without library writes
  return props.onChange ? mechanics : <DefinitionProvider localData={scopedData} catalogs={props.catalogs} onSaveDefinition={rejectPreviewDefinitionSave}>{mechanics}</DefinitionProvider>
}

function BuildMechanicsContent({ content, slots, localData, catalogs, gameSetup, onChange, onReviewIssues, onReviewGameSetup, onUploadMod, unknownInputs = NO_UNKNOWN_INPUTS, unknownSecondaryClass = false, temporaryPreview, onResetPreview }: BuildMechanicsProps & { temporaryPreview: boolean; onResetPreview?: () => void }) {
  const resolve = withoutRetainedMechanics(content, (ref: EntityRef) => resolveEntity(localData, catalogs, ref))
  const identity = (ref: EntityRef) => logicalEntityKey(localData, ref)
  const equipment = analyzeBuildEquipment(content, slots, resolve, identity)
  const rules = resolveGameRules(gameSetup, catalogs)
  const calculationResolve = withoutRetainedMechanics(content, (ref: EntityRef) => resolveCalculationEntity(localData, catalogs, ref, gameSetup))
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
    <div className="build-mechanics__equipment"><div className="build-mechanics__heading"><h3>Equipment checks</h3>{!equipment.length && <p role="status"><Icon name={hasSelections ? 'check' : 'info'}/>{hasSelections ? 'No known equipment conflicts.' : 'Add equipment to check this build.'}</p>}</div>
      {equipment.length > 0 && <><ul aria-label="Equipment findings" className="mechanics-findings">{equipment.map((issue, index) => <li data-status={issue.status} key={`${issue.code}:${issue.slotId}:${index}`}><strong>{issue.status === 'invalid' ? 'Conflict' : 'Unresolved'}:</strong> {issue.message}<p className="field__hint">{buildValidityGuidance(issue).message}</p></li>)}</ul>{onReviewIssues && <Button onClick={onReviewIssues} tone="secondary" type="button">Review solutions</Button>}</>}
      <BuildDisclosure className="equipment-check-coverage" label="What these checks cover"><p>Checks class permissions, equipment slots, shared copies, and unique items. Sub-commands grant permissions only through an explicit effect.</p></BuildDisclosure>
    </div>
    <BuildDisclosure label="Ability and hit-chance preview"><div className="stack">
      {temporaryPreview && <div className="split build-preview-tools"><p className="field__hint">Try abilities and battle conditions here. Changes are not saved.</p>{onResetPreview && <Button tone="quiet" onClick={onResetPreview} type="button">Reset preview</Button>}</div>}
      <CombatPreview temporaryPreview={temporaryPreview} onUploadMod={onUploadMod} content={content} slots={slots} localData={localData} catalogs={catalogs} gameSetup={gameSetup} onChange={onChange} unknownInputs={unknownInputs} unknownSecondaryClass={unknownSecondaryClass}/>
      <BuildDisclosure className="combat-reference" label="Formula reference"><div className="stack">
        {abilityScope.issues.size > 0 && <InlineNotice title="Ability preview unresolved">{[...abilityScope.issues].join(' ')} Review enabled mods and their source revisions in Game Setup.{onReviewGameSetup && <Button onClick={onReviewGameSetup} tone="secondary" type="button">Review Game Setup</Button>}</InlineNotice>}
        {ability ? <AbilityFormulaReference ability={ability} abilityName={abilityDefinition?.name ?? 'Selected ability'} definition={abilityDefinition} numericRecord={abilityRecord}/> : <p className="field__hint">Choose an ability to see its base power and learning costs.</p>}
      </div></BuildDisclosure>
      <BuildDisclosure className="hit-chance-calculator" label="Base hit-chance calculator"><div className="stack">
        <p className="field__hint">Compare this Build's accuracy with an evasion value. This does not change the battle target.</p>
        <div className="hit-chance-calculator__flow">
          <div className="hit-chance-calculator__accuracy"><span>Build accuracy</span><strong>{formatStatRange(accuracy)}</strong></div>
          <Field label="Target evasion">{onChange ? <input aria-label="Target evasion" min="0" onChange={event => update({ targetEvasion: numberInput(event.target.value) })} type="number" value={plan?.targetEvasion ?? ''}/> : <strong>{plan?.targetEvasion ?? 'Unknown'}</strong>}</Field>
          <div className="hit-chance-calculator__result" aria-label="Base physical hit chance"><span><Icon name="compass"/>Base physical hit chance: </span><strong>{hitChance === null ? 'Unknown' : `${hitChance}%`}</strong></div>
        </div>
        <p className="field__hint">Zero evasion gives 100%. This estimate excludes ability accuracy, hit modifiers, guaranteed hits or misses, difficulty, Luck, and miss protection. Use the battle preview for a specific target.</p>
      </div></BuildDisclosure>
    </div></BuildDisclosure>
  </section>
}
