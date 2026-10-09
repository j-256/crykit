import { buildModRequirements } from '../domain/build-mods'
import { ASSUMED_COMPATIBLE_PC_VERSIONS, resolveGameRules } from '../domain/game-rules'
import { useMemo, useState } from 'react'
import { benchmarkDamage, calculatePCStats, selectedPCStats } from '../domain/pc-stats'
import { PC_LEVEL_CAP, PC_RULES } from '../domain/calculation-rules'
import { changeCalculationLevel, changeGrowthLevels, defaultCalculation, growthAllowance } from '../domain/calculation-plan'
import { calculationGenderLabel } from '../domain/calculation-genders'
import { STAT_LABELS, type CalculatedStat } from '../domain/build-stats'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, LocalData, GameSetupRevision, ObservedStat, SlotDefinition } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { CalculationPicker } from './BuildMechanics'
import { CalculationGenderField } from './CalculationGenderField'
import { CalculationInputs } from './CalculationInputs'
import { CalculationStatus } from './CalculationStatus'
import { downloadBytes, knowledgeLabel, resolveCalculationEntity } from './model'
import { useBuildModSelection } from './BuildModSelectionGate'
import './calculated-stats.css'

const STEPS = [10, 5, 1] as const
const NO_UNKNOWN_INPUTS: readonly string[] = []
const NO_GENDER_BONUS_LABEL = 'No gender bonus'
const format = (value: number | null | undefined) => value == null ? 'Unknown' : value.toLocaleString()
const delta = (value: number | null | undefined, baseline: number | null | undefined) => value == null || baseline == null ? '' : `${value - baseline >= 0 ? '+' : ''}${value - baseline}`
const STAT_NAMES = { ...STAT_LABELS, AP: 'Max AP' }

export function CalculatedStats({ content, slots, localData, catalogs, gameSetup, onChange, onReviewGameSetup, onUploadMod, unknownInputs = NO_UNKNOWN_INPUTS, unknownSecondaryClass = false, recorded }: { content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; onChange?: (plan: BuildCalculationPlan | undefined) => void; onReviewGameSetup?: () => void; onUploadMod?: () => void; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean; recorded?: Readonly<Record<string, ObservedStat>> }) {
  const plan = content.calculation
  const rules = useMemo(() => resolveGameRules(gameSetup, catalogs), [gameSetup, catalogs])
  const modSelection = useBuildModSelection()
  const requiredMod = useMemo(() => buildModRequirements(content, localData, catalogs, gameSetup).find(requirement => requirement.state !== 'enabled'), [content, localData, catalogs, gameSetup])
  const estimate = useMemo(() => calculatePCStats(content, slots, ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup), unknownInputs, unknownSecondaryClass, rules), [content, slots, localData, catalogs, unknownInputs, unknownSecondaryClass, rules, gameSetup])
  const allocated = plan?.growth.reduce((total, row) => total + (row.levels ?? 0), 0) ?? 0
  const baseline = useMemo(() => plan ? calculatePCStats({ ...content, calculation: { ...plan, growth: [{ classRef: content.primaryClass, levels: plan.level }] } }, slots, ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup), unknownInputs, unknownSecondaryClass, rules) : undefined, [content, plan, slots, localData, catalogs, unknownInputs, unknownSecondaryClass, rules, gameSetup])
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string>()
  const exportRules = async () => {
    setExporting(true)
    setExportError(undefined)
    try {
      const { calculationPackage } = await import('../domain/calculation-package')
      const data = calculationPackage()
      downloadBytes(new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n'), `crystal-project-calculations-${data.id}.json`, 'application/json')
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Unable to export the calculation package')
    } finally {
      setExporting(false)
    }
  }
  if (!plan) return <section aria-label="Calculated stats" className="calculated-stats"><h3>Calculated stats</h3><p>Set calculation inputs to see stats.</p>{onChange && <Button onClick={() => onChange(defaultCalculation(content.primaryClass))} type="button">Estimate stats at level 60</Button>}</section>
  const update = (patch: Partial<BuildCalculationPlan>) => onChange?.({ ...plan, ...patch })
  const total = selectedPCStats(estimate, plan.gender, plan.genderSelection)
  const hasResults = Object.values(total).some(value => value !== null)
  const version = gameSetup?.gameVersion.state === 'known' ? gameSetup.gameVersion.value : undefined
  const assumedCompatible = version !== undefined && (ASSUMED_COMPATIBLE_PC_VERSIONS as readonly string[]).includes(version)
  const allPrimary = baseline ? selectedPCStats(baseline, plan.gender, plan.genderSelection) : undefined
  const genderLabel = plan.gender || plan.genderSelection ? calculationGenderLabel(plan, rules.genders) : NO_GENDER_BONUS_LABEL
  const maleLabel = calculationGenderLabel({ gender: 'male' }, rules.genders)
  const femaleLabel = calculationGenderLabel({ gender: 'female' }, rules.genders)
  const recordedStat = (stat: string) => {
    const labels = [stat, STAT_NAMES[stat as CalculatedStat], stat === 'HP' ? 'HP' : stat === 'MP' ? 'MP' : undefined].filter(Boolean).map(value => value!.toLowerCase())
    return Object.entries(recorded ?? {}).find(([key]) => labels.includes(key.toLowerCase()))?.[1]
  }
  const availableRecorded = Object.keys(PC_RULES.stats).filter(stat => recordedStat(stat)?.value.state === 'known')
  return <section aria-label="Calculated stats" className="calculated-stats stack">
    <h3>Calculated stats</h3>
    {/* Current assumptions belong beside the totals they affect, even when source details stay closed */}
    <div aria-label="Calculation context" role="group">
      <p className="field__hint">{plan.battle ? 'Includes active statuses and elapsed turns from Checks & notes.' : 'Resting stats, without active statuses or turn effects.'}</p>
      <p className="field__hint">Balance mode: {rules.mode ?? plan.pcMode ?? 'standard'} · {rules.mode ? 'from Game Setup' : 'calculation assumption; choose Game mode in Game Setup to confirm'}</p>
      {assumedCompatible && <p className="field__hint">Uses PC 1.6.9.0 calculation rules for this version.</p>}
    </div>
    {exportError && <InlineNotice title="Calculation export failed"><p role="alert">{exportError}</p><p>Save your edits, reconnect, and reload before retrying. Preparing offline use also downloads the calculation package.</p></InlineNotice>}
    {onChange ? <><div className="cluster"><Field label="Calculation level"><input aria-label="Calculation level" max={PC_LEVEL_CAP} min="1" onChange={event => onChange?.(changeCalculationLevel(plan, event.target.value === '' ? null : Math.max(1, Math.min(PC_LEVEL_CAP, Math.trunc(Number(event.target.value)))), content.primaryClass))} type="number" value={plan.level ?? ''}/></Field><CalculationGenderField genders={rules.genders} onChange={onChange} plan={plan}/></div>
    <details className="growth-controls"><summary>Level-up growth · {allocated}/{plan.level ?? '?'}{plan.growthMode === 'primary' ? ' · follows primary class' : ' · manually allocated'}</summary><div className="stack">
      <p>Assign a class to every level, including level 1. Manual allocations stop following class and level changes. Lowering the level keeps them for you to redistribute.</p>
      {plan.growth.map((row, index) => <div className="growth-control" key={index}>
        <CalculationPicker gameSetup={gameSetup} kinds={['class']} label={`Growth class ${index + 1}`} onChange={classRef => update({ growthMode: 'manual', growth: plan.growth.map((current, position) => position === index ? { ...current, classRef } : current) })} value={row.classRef}/>
        <div className="growth-control__amount"><div className="growth-control__steps">{STEPS.map(step => <Button aria-label={`Decrease growth ${index + 1} by ${step}`} disabled={row.levels === null || row.levels <= 0} key={step} onClick={() => onChange?.(changeGrowthLevels(plan, index, (row.levels ?? 0) - step))} tone="quiet" type="button">-{step}</Button>)}</div><Field label={`Growth levels ${index + 1}`}><input aria-label={`Growth levels ${index + 1}`} max={Math.max(row.levels ?? 0, growthAllowance(plan, index))} min="0" onChange={event => onChange?.(changeGrowthLevels(plan, index, event.target.value === '' ? null : Number(event.target.value)))} type="number" value={row.levels ?? ''}/></Field><div className="growth-control__steps">{[...STEPS].reverse().map(step => <Button aria-label={`Increase growth ${index + 1} by ${step}`} disabled={row.levels === null || row.levels >= growthAllowance(plan, index)} key={step} onClick={() => onChange?.(changeGrowthLevels(plan, index, (row.levels ?? 0) + step))} tone="quiet" type="button">+{step}</Button>)}</div></div>
        <input aria-label={`Growth slider ${index + 1}`} aria-valuemax={plan.level ?? PC_LEVEL_CAP} disabled={plan.level === null || row.levels === null} max={plan.level ?? PC_LEVEL_CAP} min="0" onChange={event => onChange?.(changeGrowthLevels(plan, index, Number(event.target.value)))} step="1" type="range" value={row.levels ?? 0}/>
        <div className="split"><small>Available for this class: {growthAllowance(plan, index)}</small><Button onClick={() => update({ growthMode: 'manual', growth: plan.growth.filter((_, position) => position !== index) })} tone="quiet" type="button">Remove growth {index + 1}</Button></div>
      </div>)}
      <div className="cluster"><Button disabled={plan.growth.length >= PC_LEVEL_CAP} onClick={() => update({ growthMode: 'manual', growth: [...plan.growth, { classRef: null, levels: 0 }] })} tone="secondary" type="button">Add growth class</Button><Button onClick={() => update({ growthMode: 'primary', growth: [{ classRef: content.primaryClass, levels: plan.level }] })} tone="quiet" type="button">Follow primary class for all growth</Button></div>
    </div></details></> : <details className="growth-controls"><summary>Level-up growth · {allocated}/{plan.level ?? '?'}</summary><CalculationInputs catalogs={catalogs} localData={localData} plan={plan} genders={rules.genders}/></details>}
    {(plan.statuses.length > 0 && !plan.battle || plan.bonuses.length > 0) && <InlineNotice title="Additional saved assumptions"><p>Use a battle scenario in Checks & notes to calculate saved status effects. Custom stat bonuses are unsupported.</p>{onChange && <Button onClick={() => update({ statuses: [], bonuses: [] })} tone="quiet" type="button">Clear saved statuses and custom bonuses</Button>}</InlineNotice>}
    {!hasResults && (!content.primaryClass ? <p>Choose a primary class to calculate stats.</p> : <CalculationStatus onUploadMod={onUploadMod} issues={estimate.issues} requiredMod={modSelection ? requiredMod : undefined} onReviewGameSetup={requiredMod && modSelection ? () => modSelection.enable(requiredMod) : rules.issues.length || requiredMod ? onReviewGameSetup : undefined}/>)}
    {hasResults && Object.values(total).some(value => value === null) && onUploadMod && <CalculationStatus onUploadMod={onUploadMod} issues={estimate.issues} partial/>}
    {hasResults && (!onUploadMod || Object.values(total).every(value => value !== null)) && estimate.issues.length > 0 && <InlineNotice title="Some calculation values unavailable" tone="warning"><ul>{estimate.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
    {!hasResults && availableRecorded.length > 0 && <div className="calculated-stats__table"><table aria-label="Recorded character stats"><thead><tr><th>Stat</th><th>Recorded</th></tr></thead><tbody>{availableRecorded.map(stat => <tr key={stat}><th scope="row">{STAT_NAMES[stat as CalculatedStat] ?? stat}</th><td>{knowledgeLabel(recordedStat(stat)!.value)} {recordedStat(stat)!.unit ?? ''}</td></tr>)}</tbody></table></div>}
    {hasResults && <>
    {/* Keep one selected total visible; alternative gender totals are comparisons, not additional results */}
    <div className="calculated-stats__table calculated-stats__table--totals"><table aria-label="Calculated character stats"><thead><tr><th>Stat</th><th className="stat-breakdown__total">Total <small>{genderLabel}</small></th>{recorded && <th>Recorded</th>}</tr></thead><tbody>{Object.keys(PC_RULES.stats).map(stat => <tr key={stat}><th scope="row">{STAT_NAMES[stat as keyof typeof STAT_NAMES] ?? stat}</th><td className="stat-breakdown__total"><strong>{format(total[stat])}</strong></td>{recorded && <td>{recordedStat(stat) ? knowledgeLabel(recordedStat(stat)!.value) : 'Not recorded'}</td>}</tr>)}</tbody></table></div>
    <details className="calculation-gender-comparison"><summary>Compare gender bonuses</summary><div className="calculated-stats__table"><table aria-label="Gender stat comparison"><thead><tr><th>Stat</th><th>{NO_GENDER_BONUS_LABEL}</th><th>{maleLabel} total <small>(difference)</small></th><th>{femaleLabel} total <small>(difference)</small></th></tr></thead><tbody>{Object.keys(PC_RULES.stats).map(stat => <tr key={stat}><th scope="row">{STAT_NAMES[stat as keyof typeof STAT_NAMES] ?? stat}</th><td>{format(estimate.neutral[stat])}</td>{[estimate.male, estimate.female].map((values, index) => <td key={index}>{format(values[stat])}{values[stat] != null && <small>({delta(values[stat], estimate.neutral[stat])})</small>}</td>)}</tr>)}</tbody></table></div></details>
    <details><summary>Growth and loadout breakdown</summary><p>Compares your growth with leveling only in the primary class, using the same gender. Base before gear excludes gender bonuses.</p><div className="calculated-stats__table"><table aria-label="Growth stat differences"><thead><tr><th>Stat</th><th>Base before gear</th><th>All-primary total</th><th>Growth difference</th></tr></thead><tbody>{PC_RULES.coreStats.map(stat => <tr key={stat}><th scope="row">{stat}</th><td>{format(estimate.base[stat])}</td><td>{format(allPrimary?.[stat])}</td><td>{delta(total[stat], allPrimary?.[stat]) || 'Unknown'}</td></tr>)}</tbody></table></div></details>
    <details><summary>Sample damage calculations</summary><p>Synthetic benchmarks with {PC_RULES.benchmarks[0]!.targetMain} target VIT/SPI and {PC_RULES.benchmarks[0]!.defense} DEF/RES. Physical uses ATK + ATK × STR / 100; magic uses 100 + MND. Game integer steps and defense reduction apply. Uses the selected stats, including active scenario modifiers. Excludes further damage modifiers, crits, variance, elements, and reactions.</p><div className="calculated-stats__table"><table aria-label="Damage benchmarks"><thead><tr><th>Benchmark</th><th className="stat-breakdown__total">Total <small>{genderLabel}</small></th><th>{NO_GENDER_BONUS_LABEL}</th><th>{maleLabel}</th><th>{femaleLabel}</th></tr></thead><tbody>{PC_RULES.benchmarks.map(benchmark => <tr key={benchmark.id}><th scope="row">{benchmark.label}</th><td className="stat-breakdown__total"><strong>{format(benchmarkDamage(total, benchmark.id))}</strong></td>{[estimate.neutral, estimate.male, estimate.female].map((stats, index) => <td key={index}>{format(benchmarkDamage(stats, benchmark.id))}</td>)}</tr>)}</tbody></table></div></details>
    </>}
    <details className="calculation-coverage"><summary>Calculation sources and coverage</summary><p className="field__hint">Uses PC 1.6.9.0 formulas and supported mods from this Game Setup.</p>
      <Button disabled={exporting} icon="download" onClick={exportRules} tone="quiet" type="button">{exporting ? 'Preparing calculation package...' : 'Export calculation package'}</Button></details>
    {estimate.effects.length > 0 && <details><summary>Additional loadout effects</summary><ul>{estimate.effects.map(effect => <li key={effect}>{effect}</li>)}</ul></details>}
  </section>
}
