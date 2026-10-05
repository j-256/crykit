import { buildModRequirements } from '../domain/build-mods'
import { useMemo } from 'react'
import { resolveGameRules } from '../domain/game-rules'
import { logicalEntityKey } from '../domain'
import { STAT_KEYS } from '../domain/crystal-edit'
import { STAT_LABELS } from '../domain/build-stats'
import { calculationGenderLabel } from '../domain/calculation-genders'
import { calculateStatBreakdownResult, STAT_BREAKDOWN_COLUMNS } from '../domain/stat-breakdown'
import { classRatingField } from '../domain/stat-ratings'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, GameSetupRevision, LocalData, SlotDefinition } from '../domain/types'
import { formatStatRange } from './BuildMechanics'
import { CalculationGenderField } from './CalculationGenderField'
import { DefinitionArtwork } from './GameIcon'
import { resolveEntity, resolveCalculationEntity } from './model'
import { Icon } from './icons'
import { KnowledgeValue } from './KnowledgeValue'
import { CalculationStatus } from './CalculationStatus'
import { useBuildModSelection } from './BuildModSelectionGate'

const NO_UNKNOWN_INPUTS: readonly string[] = []
const COLUMN_LABELS = Object.freeze({ base: 'Base', equipment: 'Equipment', level: 'Level', gender: 'Gender', total: 'Total' })

export function BuildStatsOverview({ content, slots, localData, catalogs, gameSetup, onCalculationChange, onReviewGameSetup, unknownPrimaryClass = false, unknownInputs = NO_UNKNOWN_INPUTS, unknownSecondaryClass = false }: { content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; onCalculationChange?: (plan: BuildCalculationPlan | undefined) => void; onReviewGameSetup?: () => void; unknownPrimaryClass?: boolean; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean }) {
  const rules = useMemo(() => resolveGameRules(gameSetup, catalogs), [gameSetup, catalogs])
  const modSelection = useBuildModSelection()
  const requiredMod = useMemo(() => buildModRequirements(content, localData, catalogs, gameSetup).find(requirement => requirement.state !== 'enabled'), [content, localData, catalogs, gameSetup])
  const result = useMemo(() => calculateStatBreakdownResult(content, slots, ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup), ref => logicalEntityKey(localData, ref), unknownInputs, unknownSecondaryClass, rules), [content, slots, localData, catalogs, unknownInputs, unknownSecondaryClass, rules, gameSetup])
  const breakdown = result.stats
  const columns = STAT_BREAKDOWN_COLUMNS.filter(column => STAT_KEYS.some(stat => breakdown[stat][column] !== null))
  const hasTotals = STAT_KEYS.some(stat => breakdown[stat].total !== null)
  const primary = content.primaryClass ? resolveEntity(localData, catalogs, content.primaryClass) : undefined
  if (!primary) return <section aria-label="Class stats" className="build-stat-overview"><h3><Icon name="character"/>Class stats</h3><p>{unknownPrimaryClass ? 'Primary class is unknown. Numeric stats need a recorded class.' : 'No primary class selected. Numeric stats need a primary class.'}</p></section>
  const plan = content.calculation
  const [ratingField, ratings] = classRatingField(primary)
  const genderLabel = calculationGenderLabel(plan, rules.genders)
  return <section aria-label="Class stats" className="build-stat-overview">
    <header><div className="icon-label"><DefinitionArtwork catalogs={catalogs} localData={localData} value={content.primaryClass}/><h3>{primary.name} stats</h3></div><span className="field__hint">{plan?.battle ? 'Battle scenario stats' : 'Resting stat preview'}</span></header>
    <div className="build-stat-overview__sections">
      <section aria-label="Class growth ratings"><h4>Class growth ratings</h4><KnowledgeValue field={ratingField} value={ratings}/><p className="field__hint">Fixed class ratings for base-stat scaling and growth.</p></section>
      <section aria-label="Stats at selected level">
        <h4>Level {plan?.level ?? 'unknown'} stats</h4>
        {plan && onCalculationChange ? <CalculationGenderField genders={rules.genders} plan={plan} onChange={onCalculationChange}/> : <p className="field__hint">Gender: {genderLabel}</p>}
        {plan ? <>
          {!hasTotals && <CalculationStatus issues={result.issues} partial={columns.length > 0} requiredMod={modSelection ? requiredMod : undefined} onReviewGameSetup={requiredMod && modSelection ? () => modSelection.enable(requiredMod) : rules.issues.length || requiredMod ? onReviewGameSetup : undefined}/>}
          {columns.length > 0 && <><div className="structured-value__table"><table aria-label="Planned build stats" className="stat-breakdown"><thead><tr><th scope="col">Stat</th>{columns.map(column => <th className={`stat-breakdown__${column}`} key={column} scope="col">{column === 'equipment' && plan?.battle ? 'Equipment + statuses' : COLUMN_LABELS[column]}</th>)}</tr></thead><tbody>{STAT_KEYS.map(stat => <tr key={stat}><th scope="row"><abbr aria-hidden="true" title={STAT_LABELS[stat]}>{stat}</abbr><span className="sr-only">{STAT_LABELS[stat]}</span></th>{columns.map(column => {
            const value = breakdown[stat][column]
            const text = formatStatRange(value)
            const displayed = value && column !== 'base' && column !== 'total' && value.low >= 0 && value.high > 0 ? `+${text}` : text
            return <td className={`stat-breakdown__${column}`} key={column}>{column === 'total' ? <strong>{displayed}</strong> : displayed}</td>
          })}</tr>)}</tbody></table></div>
          <p className="field__hint">Base: level 1 in the primary class, before equipment and gender. Level: the selected level and growth history. Equipment: the loadout's net effect, including passives{plan?.battle ? ', active scenario statuses, and elapsed-turn effects' : ''}. Gender: its effect after modifiers and rounding. {hasTotals ? 'Native integer stages and caps apply. Columns add up to Total.' : 'Unavailable columns are omitted until their inputs can be resolved.'}</p></>}
        </> : <p className="field__hint">No calculation inputs saved. Base and equipped totals remain unknown.</p>}
      </section>
    </div>
  </section>
}
