import { useMemo } from 'react'
import { resolveGameRules } from '../domain/game-rules'
import { logicalEntityKey } from '../domain'
import { STAT_KEYS } from '../domain/crystal-edit'
import { STAT_LABELS } from '../domain/build-stats'
import { CALCULATION_GENDERS, CALCULATION_GENDER_LABELS } from '../domain/calculation-plan'
import { calculateStatBreakdown, STAT_BREAKDOWN_COLUMNS } from '../domain/stat-breakdown'
import { classRatingField } from '../domain/stat-ratings'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, GameSetupRevision, LocalData, SlotDefinition } from '../domain/types'
import { formatStatRange } from './BuildMechanics'
import { Field } from './components'
import { DefinitionArtwork } from './GameIcon'
import { resolveEntity, resolveCalculationEntity } from './model'
import { Icon } from './icons'
import { KnowledgeValue } from './KnowledgeValue'

const NO_UNKNOWN_INPUTS: readonly string[] = []
const COLUMN_LABELS = Object.freeze({ base: 'Base', equipment: 'Equipment', level: 'Level', gender: 'Gender', total: 'Total' })

export function BuildStatsOverview({ content, slots, localData, catalogs, gameSetup, onCalculationChange, usesDefaultLevel = false, unknownPrimaryClass = false, unknownInputs = NO_UNKNOWN_INPUTS, unknownSecondaryClass = false }: { content: BuildRevisionContent; slots: readonly SlotDefinition[]; localData: LocalData; catalogs: readonly CatalogSnapshot[]; gameSetup?: GameSetupRevision; onCalculationChange?: (plan: BuildCalculationPlan | undefined) => void; usesDefaultLevel?: boolean; unknownPrimaryClass?: boolean; unknownInputs?: readonly string[]; unknownSecondaryClass?: boolean }) {
  const rules = useMemo(() => resolveGameRules(gameSetup, catalogs), [gameSetup, catalogs])
  const breakdown = useMemo(() => calculateStatBreakdown(content, slots, ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup), ref => logicalEntityKey(localData, ref), unknownInputs, unknownSecondaryClass, rules), [content, slots, localData, catalogs, unknownInputs, unknownSecondaryClass, rules, gameSetup])
  const primary = content.primaryClass ? resolveEntity(localData, catalogs, content.primaryClass) : undefined
  if (!primary) return <section aria-label="Class stats" className="build-stat-overview"><h3><Icon name="character"/>Class stats</h3><p>{unknownPrimaryClass ? 'Primary class is unknown. Numeric stats need a recorded class.' : 'No primary class selected. Numeric stats need a primary class.'}</p></section>
  const plan = content.calculation
  const [ratingField, ratings] = classRatingField(primary)
  const genderLabel = plan?.gender ? CALCULATION_GENDER_LABELS[plan.gender] : 'Not specified (no bonus preview)'
  return <section aria-label="Class stats" className="build-stat-overview">
    <header><div className="icon-label"><DefinitionArtwork catalogs={catalogs} localData={localData} value={content.primaryClass}/><h3>{primary.name} stats</h3></div><span className="field__hint">Primary class</span></header>
    <div className="build-stat-overview__sections">
      <section aria-label="Class growth ratings"><h4>Class growth ratings</h4><KnowledgeValue field={ratingField} value={ratings}/><p className="field__hint">Fixed class ratings for base-stat scaling and growth.</p></section>
      <section aria-label="Stats at selected level">
        <h4>Level {plan?.level ?? 'unknown'} stats</h4>
        {usesDefaultLevel && <p className="field__hint">Level {plan?.level} assumed for preview.</p>}
        {plan && onCalculationChange ? <Field label="Calculation gender"><select aria-label="Calculation gender" onChange={event => onCalculationChange({ ...plan, gender: event.target.value ? event.target.value as BuildCalculationPlan['gender'] : undefined })} value={plan.gender ?? ''}><option value="">Not specified (no bonus preview)</option>{CALCULATION_GENDERS.map(gender => <option key={gender} value={gender}>{CALCULATION_GENDER_LABELS[gender]}</option>)}</select></Field> : <p className="field__hint">Gender: {genderLabel}</p>}
        {plan ? <>
          <div className="structured-value__table"><table aria-label="Planned build stats" className="stat-breakdown"><thead><tr><th scope="col">Stat</th>{STAT_BREAKDOWN_COLUMNS.map(column => <th className={`stat-breakdown__${column}`} key={column} scope="col">{COLUMN_LABELS[column]}</th>)}</tr></thead><tbody>{STAT_KEYS.map(stat => <tr key={stat}><th scope="row"><abbr aria-hidden="true" title={STAT_LABELS[stat]}>{stat}</abbr><span className="sr-only">{STAT_LABELS[stat]}</span></th>{STAT_BREAKDOWN_COLUMNS.map(column => {
            const value = breakdown[stat][column]
            const text = formatStatRange(value)
            const displayed = value && column !== 'base' && column !== 'total' && value.low >= 0 && value.high > 0 ? `+${text}` : text
            return <td className={`stat-breakdown__${column}`} key={column}>{column === 'total' ? <strong>{displayed}</strong> : displayed}</td>
          })}</tr>)}</tbody></table></div>
          <p className="field__hint">Base: level 1 in the primary class, before equipment and gender. Level: the selected level and growth history. Equipment: the loadout's net effect, including passives. Gender: its effect after modifiers and rounding. {plan.model ? 'Columns add up to Total.' : 'Guide estimates retain their ranges and saved per-stat gender bonuses.'}</p>
        </> : <p className="field__hint">No calculation inputs saved. Base and equipped totals remain unknown.</p>}
      </section>
    </div>
  </section>
}
