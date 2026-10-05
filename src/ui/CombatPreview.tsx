import { useMemo, useRef, useState } from 'react'
import { ABILITY_COSTS } from '../domain/ability-estimates'
import { defaultBattleCalculation } from '../domain/battle-plan'
import { defaultCalculation } from '../domain/calculation-plan'
import { calculateBuildCombatPreview } from '../domain/combat-preview'
import { compareActiveStatusImpact, listActiveStatusImpactChoices } from '../domain/combat-status-impact'
import { resolveGameRules } from '../domain/game-rules'
import { logicalEntityKey } from '../domain/definitions'
import type { BattleCalculationPlan, BuildCalculationPlan, BuildRevisionContent, CatalogSnapshot, GameSetupRevision, LocalData, SlotDefinition } from '../domain/types'
import { BattleCalculationControls, BattleTargetPicker } from './BattleCalculationControls'
import { CalculationPicker } from './CalculationPicker'
import { CombatAbilitySummary } from './CombatAbilitySummary'
import { CombatStatusImpact } from './CombatStatusImpact'
import { combatPreviewInputAction, type CombatPreviewInputField } from './combat-preview-inputs'
import { Button, InlineNotice } from './components'
import { entityName, resolveCalculationEntity } from './model'
import { Icon } from './icons'
import './combat-preview.css'

const NO_UNKNOWN_INPUTS: readonly string[] = []
const ABILITY_KINDS = ['ability', 'monsterMagic'] as const
const PERIODIC_RESOURCES = ['HP', 'MP', 'AP'] as const
const COST_LABELS = { HP: 'HP cost', MP: 'MP cost', AP: 'AP cost', CT: 'CT delay', CD: 'Cooldown' } as const
const MAX_PERCENT = 100
const numberText = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString(undefined, { maximumFractionDigits: 2 })

interface PreviewValueProps {
  readonly value: number | null
  readonly reasons?: readonly string[]
  readonly suffix?: string
  readonly battle?: BattleCalculationPlan
  readonly recipient?: 'user' | 'target'
  readonly onRequestInput?: (field: CombatPreviewInputField) => void
}

function PreviewValue({ value, reasons, suffix = '', battle, recipient, onRequestInput }: PreviewValueProps) {
  const action = value === null && battle && onRequestInput ? combatPreviewInputAction(reasons, battle, recipient) : undefined
  return <>
    <strong className="combat-value" data-state={value === null ? 'unknown' : 'known'}>{numberText(value)}{value !== null ? suffix : ''}</strong>
    {value === null && reasons?.length ? <small>{reasons.join('; ')}</small> : null}
    {action && <Button tone="quiet" type="button" className="combat-input-action" onClick={() => onRequestInput?.(action.field)}>{action.label}</Button>}
  </>
}

function ChanceMeter({ label, value }: { readonly label: string; readonly value: number | null }) {
  return value !== null && value >= 0 && value <= MAX_PERCENT ? <meter className="combat-chance-meter" aria-label={label} min={0} max={MAX_PERCENT} value={value}>{value}%</meter> : null
}

export function CombatPreview({ content, slots, localData, catalogs, gameSetup, onChange, unknownInputs = NO_UNKNOWN_INPUTS, unknownSecondaryClass = false }: {
  readonly content: BuildRevisionContent; readonly slots: readonly SlotDefinition[]; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly gameSetup?: GameSetupRevision; readonly onChange?: (plan: BuildCalculationPlan | undefined) => void; readonly unknownInputs?: readonly string[]; readonly unknownSecondaryClass?: boolean
}) {
  const section = useRef<HTMLElement>(null)
  const plan = content.calculation
  const battle = plan?.battle
  const preview = useMemo(() => calculateBuildCombatPreview(content, slots, ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup), resolveGameRules(gameSetup, catalogs), unknownInputs, unknownSecondaryClass), [content, slots, localData, catalogs, gameSetup, unknownInputs, unknownSecondaryClass])
  const [comparedStatusKey, setComparedStatusKey] = useState('')
  const statusChoices = useMemo(() => listActiveStatusImpactChoices(content, ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup), resolveGameRules(gameSetup, catalogs)), [content, localData, catalogs, gameSetup])
  const comparedStatus = statusChoices.find(choice => choice.key === comparedStatusKey) ?? statusChoices[0]
  const statusImpact = useMemo(() => comparedStatus && content.calculation?.ability ? compareActiveStatusImpact(content, slots, ref => resolveCalculationEntity(localData, catalogs, ref, gameSetup), comparedStatus, resolveGameRules(gameSetup, catalogs), unknownInputs, unknownSecondaryClass, preview) : undefined, [content, slots, localData, catalogs, gameSetup, unknownInputs, unknownSecondaryClass, comparedStatus, preview])
  const update = (patch: Partial<BuildCalculationPlan>) => onChange?.({ ...plan ?? defaultCalculation(content.primaryClass), ...patch })
  const damageLabel = preview.damage !== null && preview.damage < 0 ? 'Healing before variance' : 'Damage before variance'
  const noResourceCost = preview.costs.HP === 0 && preview.costs.MP === 0 && preview.costs.AP === 0
  const requestInput = (field: CombatPreviewInputField) => {
    const control = section.current?.querySelector<HTMLElement>(`[data-battle-field="${field}"]`)
    if (!control) return
    let ancestor = control.parentElement
    while (ancestor && ancestor !== section.current) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
      ancestor = ancestor.parentElement
    }
    if (control.tagName === 'SUMMARY' && control.parentElement instanceof HTMLDetailsElement) control.parentElement.open = true
    control.focus({ preventScroll: true })
    control.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  const valueContext = { battle, onRequestInput: onChange ? requestInput : undefined }
  const includeRetainedStatuses = () => {
    if (!battle || !plan) return
    const seen = new Set(battle.statuses.map(row => logicalEntityKey(localData, row.ref)))
    const added = plan.statuses.flatMap(ref => {
      const key = logicalEntityKey(localData, ref)
      if (seen.has(key)) return []
      seen.add(key)
      return [{ ref, count: null }]
    })
    update({ battle: { ...battle, statuses: [...battle.statuses, ...added] } })
  }
  return <section ref={section} aria-label="Combat preview" className="combat-preview stack">
    <div className="combat-heading">
      <div><h4>{battle ? 'Battle scenario' : 'Ability preview'}</h4><p className="field__hint">{battle ? 'Choose an ability and target. Adjust optional conditions only when they affect your result.' : 'Choose an ability to see its costs with this Build. Add a scenario for damage, healing or active statuses.'}</p></div>
      {onChange && <Button tone="quiet" type="button" onClick={() => update({ battle: battle ? undefined : defaultBattleCalculation() })}>{battle ? 'Use resting stats' : 'Add battle scenario'}</Button>}
    </div>
    <div className="combat-selection">
      <div className="combat-selection__ability">{onChange && <CalculationPicker showSelectionDetails={false} gameSetup={gameSetup} kinds={ABILITY_KINDS} label="Preview ability" onChange={ability => update({ ability })} value={plan?.ability ?? null}/>}
        <CombatAbilitySummary abilityRef={plan?.ability ?? null} localData={localData} catalogs={catalogs} gameSetup={gameSetup} pcMode={plan?.pcMode}/>
      </div>
      {battle && <BattleTargetPicker context={{ localData, catalogs, gameSetup }} battle={battle} onChange={onChange ? battle => update({ battle }) : undefined}/>}
    </div>
    {plan?.ability && <div className="combat-costs"><div className="combat-heading"><h5>Effective ability costs</h5>{noResourceCost && <span className="combat-free-cost"><Icon name="check"/>No resource cost</span>}</div>
      <dl aria-label="Effective ability costs" className="definition-list combat-cost-grid">{ABILITY_COSTS.map(cost => <div className="definition-row" data-resource={cost} data-state={preview.costs[cost] === 0 ? 'zero' : preview.costs[cost] === null ? 'unknown' : 'active'} key={cost}><dt>{COST_LABELS[cost]}</dt><dd><PreviewValue {...valueContext} value={preview.costs[cost]} reasons={preview.unavailable[`${cost} cost`]}/></dd></div>)}</dl>
      <details className="combat-base-costs"><summary>Base ability costs</summary><p className="field__hint">Listed parameters before equipment, passive and status adjustments. Base HP cost is a percentage of maximum HP.</p><dl aria-label="Base ability costs" className="definition-list">{ABILITY_COSTS.map(cost => <div className="definition-row" key={cost}><dt>{COST_LABELS[cost]}</dt><dd>{numberText(preview.baseCosts[cost])}{cost === 'HP' ? '% of max HP' : ''}</dd></div>)}</dl></details>
    </div>}
    {battle && <>
      <div className="combat-results"><div className="combat-heading"><h4>Ability outcome</h4><span className="combat-caption">Before random rolls</span></div>
        {!plan?.ability && <p className="combat-empty">Choose a preview ability to calculate its outcome.</p>}
        {plan?.ability && <div className="combat-outcome" aria-label="Battle ability outcome"><dl className="definition-list combat-outcome-grid">
          <div className="definition-row combat-outcome-primary" data-effect={preview.damage !== null && preview.damage < 0 ? 'healing' : 'damage'}><dt><Icon name={preview.damage !== null && preview.damage < 0 ? 'plus' : 'sword'}/>{damageLabel}</dt><dd><PreviewValue {...valueContext} value={preview.damage === null ? null : Math.abs(preview.damage)} reasons={preview.unavailable.Damage}/><span className="combat-result-target">Target: {battle.target === 'self' ? 'Self' : entityName(localData, catalogs, battle.target, 'Not selected')}</span></dd></div>
          <div className="definition-row combat-outcome-chance"><dt><Icon name="compass"/>Hit chance before luck</dt><dd><PreviewValue {...valueContext} value={preview.hitChance} reasons={preview.unavailable['Hit chance']} suffix="%"/><ChanceMeter label="Hit chance before luck" value={preview.hitChance}/></dd></div>
          <div className="definition-row combat-outcome-chance combat-outcome-critical"><dt><Icon name="spark"/>Critical chance before luck</dt><dd><PreviewValue {...valueContext} value={preview.criticalChance} reasons={preview.unavailable['Critical chance']} suffix="%"/><ChanceMeter label="Critical chance before luck" value={preview.criticalChance}/></dd></div>
        </dl>
        {comparedStatus && statusImpact && <CombatStatusImpact choices={statusChoices} selected={comparedStatus} impact={statusImpact} onSelect={setComparedStatusKey}/>}
        <details className="combat-damage-breakdown"><summary>Damage breakdown</summary><dl className="definition-list">
          <div className="definition-row"><dt>Critical amount before variance</dt><dd><PreviewValue {...valueContext} value={preview.criticalDamage === null ? null : Math.abs(preview.criticalDamage)} reasons={preview.unavailable['Critical damage']}/></dd></div>
          <div className="definition-row"><dt>Variance amplitude</dt><dd><PreviewValue {...valueContext} value={preview.variance === null ? null : Math.abs(preview.variance)} reasons={preview.unavailable.Variance}/></dd></div>
          <div className="definition-row"><dt>Critical variance amplitude</dt><dd><PreviewValue {...valueContext} value={preview.criticalVariance === null ? null : Math.abs(preview.criticalVariance)} reasons={preview.unavailable['Critical variance']}/></dd></div>
        </dl></details></div>}
        <p className="field__hint">Uses your Build, Game Setup and selected target. Unknown inputs only block the results that need them.</p>
        <details className="combat-secondary-results"><summary>Periodic and status effects</summary><div className="stack">
          <div><h5>Actor periodic effects</h5><dl className="definition-list combat-periodic-grid" aria-label="Periodic battle effects">{PERIODIC_RESOURCES.map(resource => <div className="definition-row" key={resource}><dt>{resource} per tick</dt><dd><PreviewValue {...valueContext} value={preview.periodic[resource]} reasons={preview.unavailable[`${resource} per turn`]}/></dd></div>)}</dl><p className="field__hint">Positive amounts are lost; negative amounts are recovered.</p></div>
          {preview.statuses.length > 0 && <div><h5>Ability status effects</h5><ul className="combat-status-results">{preview.statuses.map((status, index) => <li key={`${status.recipient}:${status.name}:${index}`}><strong>{status.name}</strong><span>{status.recipient === 'user' ? 'Actor' : 'Target'} · Chance: <PreviewValue {...valueContext} recipient={status.recipient} value={status.chance} reasons={preview.unavailable[`${status.name} chance (${status.recipient})`]} suffix="%"/> · Duration: <PreviewValue {...valueContext} recipient={status.recipient} value={status.duration} reasons={preview.unavailable[`${status.name} duration (${status.recipient})`]}/>{status.condition && <small>{status.condition}</small>}</span></li>)}</ul></div>}
        </div></details>
      </div>
      <div className="combat-assumptions-heading"><h4>Optional battle conditions</h4><p className="field__hint">Saved with this plan. These assumptions do not change recorded character observations.</p></div>
      <BattleCalculationControls battle={battle} maxima={preview.maxima} localData={localData} catalogs={catalogs} gameSetup={gameSetup} onChange={onChange ? battle => update({ battle }) : undefined}/>
      {plan.statuses.length > 0 && onChange && <InlineNotice title="Retained status assumptions"><p>Older status selections are preserved separately. Add them to this scenario to calculate their effects.</p><Button tone="quiet" type="button" onClick={includeRetainedStatuses}>Use retained statuses in scenario</Button></InlineNotice>}
    </>}
    {preview.issues.length > 0 && <InlineNotice title="Some battle inputs need attention" tone="warning"><ul>{preview.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
    {battle && <details className="combat-scope"><summary>Calculation scope</summary><p>Effective costs include supported equipment, passive and scenario status modifiers. HP cost is the amount paid; its base parameter is a percentage. Outcomes do not establish action legality or target selection rules.</p><ul>{preview.notes.map(note => <li key={note}>{note}</li>)}</ul></details>}
  </section>
}
