import { useState } from 'react'
import { BATTLE_RESOURCES, PERMANENT_STATUS_COUNT } from '../domain/battle-plan'
import { logicalEntityKey } from '../domain/definitions'
import { entityDefinitionKey } from '../domain/core'
import { MAX_NATIVE_INTEGER } from '../domain/native-number'
import type { BattleCalculationPlan, BattleResourceInputs, BattleStatusInput, CatalogSnapshot, EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import { CalculationPicker } from './CalculationPicker'
import { Button, Field } from './components'
import { entityName } from './model'

const STATUS_KINDS = ['status'] as const
const MONSTER_KINDS = ['monster'] as const
const conditionLabels = {
  bottomThreat: 'Actor has lowest threat',
  topThreat: 'Actor has highest threat',
  targetIsThreatTarget: 'Target is the actor\'s threat target',
  targetCharging: 'Target is charging',
} as const
const amount = (text: string, minimum = 0) => text.trim() === '' ? null : Math.max(minimum, Math.min(MAX_NATIVE_INTEGER, Math.trunc(Number(text))))
const knownBoolean = (value: string): boolean | null => value === '' ? null : value === 'true'
const numberText = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString()

interface DefinitionContext {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly gameSetup?: GameSetupRevision
}

export function BattleTargetPicker({ context, battle, onChange }: {
  readonly context: DefinitionContext
  readonly battle: BattleCalculationPlan
  readonly onChange?: (battle: BattleCalculationPlan) => void
}) {
  const [choosingMonster, setChoosingMonster] = useState(false)
  const targetMode = battle.target === 'self' ? 'self' : battle.target || choosingMonster ? 'monster' : ''
  return <div className="battle-target">
    <Field label="Battle target">
      {onChange ? <select
        aria-label="Battle target"
        data-battle-field="target"
        value={targetMode}
        onChange={event => {
          const mode = event.target.value
          setChoosingMonster(mode === 'monster')
          const target = mode === 'self' ? 'self' : mode === 'monster' && battle.target !== 'self' ? battle.target : null
          onChange({ ...battle, target })
        }}
      >
        <option value="">Choose a target</option>
        <option value="self">Self</option>
        <option value="monster">Monster</option>
      </select> : <span>{battle.target === 'self' ? 'Self' : entityName(context.localData, context.catalogs, battle.target, 'Unknown')}</span>}
    </Field>
    {onChange && battle.target !== 'self' && <CalculationPicker
      gameSetup={context.gameSetup}
      kinds={MONSTER_KINDS}
      label="Target monster"
      value={battle.target}
      onChange={target => {
        setChoosingMonster(true)
        onChange({ ...battle, target })
      }}
    />}
  </div>
}

function StatusInputs({ label, rows, onChange, ...context }: DefinitionContext & {
  readonly label: string
  readonly rows: readonly BattleStatusInput[]
  readonly onChange?: (rows: readonly BattleStatusInput[]) => void
}) {
  const name = (ref: EntityRef) => entityName(context.localData, context.catalogs, ref)
  const add = (ref: EntityRef | null) => {
    if (ref && !rows.some(row => logicalEntityKey(context.localData, row.ref) === logicalEntityKey(context.localData, ref))) onChange?.([...rows, { ref, count: null }])
  }
  return <div className="stack battle-statuses">
    {rows.length === 0 && <p className="field__hint">None selected.</p>}
    {rows.map((row, index) => <div className="battle-status-row" key={entityDefinitionKey(row.ref)}>
      <span>{name(row.ref)}</span>
      {onChange ? <>
        <Field label={`${label}: ${name(row.ref)} duration`}>
          <input
            aria-label={`${label}: ${name(row.ref)} duration`}
            min="1"
            max={MAX_NATIVE_INTEGER}
            type="number"
            value={row.count ?? ''}
            placeholder="Unknown"
            onChange={event => onChange(rows.map((current, position) => position === index ? { ...row, count: amount(event.target.value, 1) } : current))}
          />
        </Field>
        <Button aria-label={`Remove ${name(row.ref)} from ${label.toLowerCase()}`} tone="quiet" type="button" onClick={() => onChange(rows.filter((_, position) => position !== index))}>Remove</Button>
      </> : <span>{row.count === PERMANENT_STATUS_COUNT ? 'Permanent' : `${numberText(row.count)} remaining`}</span>}
    </div>)}
    {onChange && <CalculationPicker gameSetup={context.gameSetup} kinds={STATUS_KINDS} label={`Add ${label.toLowerCase()}`} value={null} excludedRefs={rows.map(row => row.ref)} onChange={add}/>}
    {rows.length > 0 && <p className="field__hint">Enter the remaining duration. {PERMANENT_STATUS_COUNT} means permanent; blank means unknown.</p>}
  </div>
}

function StatusHistory({ label, refs, onChange, ...context }: DefinitionContext & {
  readonly label: string
  readonly refs: readonly EntityRef[]
  readonly onChange?: (refs: readonly EntityRef[]) => void
}) {
  return <div className="stack">
    <h5>{label}</h5>
    {refs.length ? <ul className="battle-history">
      {refs.map((ref, index) => <li key={entityDefinitionKey(ref)}>
        <span>{entityName(context.localData, context.catalogs, ref)}</span>
        {onChange && <Button
          tone="quiet"
          type="button"
          aria-label={`Remove ${entityName(context.localData, context.catalogs, ref)} from ${label.toLowerCase()}`}
          onClick={() => onChange(refs.filter((_, position) => position !== index))}
        >Remove</Button>}
      </li>)}
    </ul> : <p className="field__hint">None recorded in this scenario.</p>}
    {onChange && <CalculationPicker
      gameSetup={context.gameSetup}
      kinds={STATUS_KINDS}
      label={`Add ${label.toLowerCase()}`}
      value={null}
      excludedRefs={refs}
      onChange={ref => {
        if (ref && !refs.some(value => logicalEntityKey(context.localData, value) === logicalEntityKey(context.localData, ref))) onChange([...refs, ref])
      }}
    />}
  </div>
}

function ResourceMaximums({ label, value }: { readonly label: string; readonly value: BattleResourceInputs | null }) {
  return <dl className="battle-maxima" aria-label={`${label} maximum resources`}>
    {BATTLE_RESOURCES.map(resource => <div key={resource}>
      <dt>Max {resource.toUpperCase()}</dt>
      <dd>{numberText(value?.[resource] ?? null)}</dd>
    </div>)}
  </dl>
}

function ResourceInputs({ label, value, maximum, onChange }: {
  readonly label: 'Actor' | 'Target'
  readonly value: BattleResourceInputs
  readonly maximum: BattleResourceInputs | null
  readonly onChange?: (value: BattleResourceInputs) => void
}) {
  const useFullResources = () => {
    if (!maximum || !onChange) return
    const next = { ...value }
    for (const resource of BATTLE_RESOURCES) next[resource] = maximum[resource] ?? value[resource]
    onChange(next)
  }
  return <details className="battle-resources" aria-label={`${label} resources`}>
    <summary>
      <span>Resources</span>
      {BATTLE_RESOURCES.some(resource => value[resource] !== null) && <small className="battle-resources__values">{BATTLE_RESOURCES.map(resource => `${resource.toUpperCase()} ${numberText(value[resource])}`).join(' · ')}</small>}
    </summary>
    <div className="stack">
      <p className="field__hint">{onChange ? 'Optional. Enter current resources when an ability needs them; leave blank if unknown.' : 'Current resources are assumptions for this scenario.'}</p>
      {onChange && <Button tone="quiet" type="button" disabled={!maximum || Object.values(maximum).every(value => value === null)} onClick={useFullResources}>Use full {label.toLowerCase()} resources</Button>}
      <div className="battle-input-grid">
        {BATTLE_RESOURCES.map(resource => <Field key={resource} label={`${label} current ${resource.toUpperCase()}`}>
          {onChange ? <input
            aria-label={`${label} current ${resource.toUpperCase()}`}
            data-battle-field={`${label.toLowerCase()}.${resource}`}
            min="0"
            max={maximum?.[resource] ?? MAX_NATIVE_INTEGER}
            type="number"
            value={value[resource] ?? ''}
            placeholder="Unknown"
            onChange={event => onChange({ ...value, [resource]: amount(event.target.value) })}
          /> : <span>{numberText(value[resource])}</span>}
          {maximum?.[resource] != null && <small>Maximum: {numberText(maximum[resource])}</small>}
        </Field>)}
      </div>
    </div>
  </details>
}

export function BattleCalculationControls({ battle, maxima, onChange, ...context }: DefinitionContext & {
  readonly battle: BattleCalculationPlan
  readonly maxima: { readonly user: BattleResourceInputs; readonly target: BattleResourceInputs | null }
  readonly onChange?: (battle: BattleCalculationPlan) => void
}) {
  const update = (patch: Partial<BattleCalculationPlan>) => onChange?.({ ...battle, ...patch })
  const self = battle.target === 'self'
  return <div className="stack battle-controls">
    <div className="battle-combatants">
      <section className="battle-combatant stack" aria-label="Your character">
        <div className="battle-combatant__header">
          <h4>Your character</h4>
          <p className="field__hint">Stats from your Build and Game Setup.</p>
        </div>
        <ResourceMaximums label="Actor" value={maxima.user}/>
        <ResourceInputs label="Actor" value={battle.user} maximum={maxima.user} onChange={onChange ? user => update({ user }) : undefined}/>
        <details>
          <summary data-battle-field="actor-statuses">Actor statuses · {battle.statuses.length}</summary>
          <StatusInputs {...context} label="Actor statuses" rows={battle.statuses} onChange={onChange ? statuses => update({ statuses }) : undefined}/>
        </details>
      </section>
      <section className="battle-combatant stack" aria-label="Target combatant">
        <div className="battle-combatant__header">
          <h4>Target</h4>
          {self ? <p className="field__hint">Your character is the target.</p> : battle.target ? <>
            <p><strong>{entityName(context.localData, context.catalogs, battle.target)}</strong></p>
            <p className="field__hint">Stats from the catalog and Game Setup difficulty.</p>
          </> : <p className="field__hint">Choose a target above to calculate its outcomes.</p>}
        </div>
        <ResourceMaximums label="Target" value={self ? maxima.user : maxima.target}/>
        {self ? <p className="field__hint">Shares your character's current resources, active statuses, elapsed turns, and prior status applications.</p> : <>
          <ResourceInputs label="Target" value={battle.targetResources} maximum={maxima.target} onChange={onChange ? targetResources => update({ targetResources }) : undefined}/>
          <details>
            <summary data-battle-field="target-statuses">Target statuses · {battle.targetStatuses.length}</summary>
            <StatusInputs {...context} label="Target statuses" rows={battle.targetStatuses} onChange={onChange ? targetStatuses => update({ targetStatuses }) : undefined}/>
          </details>
        </>}
      </section>
    </div>
    <details className="battle-advanced">
      <summary>Advanced conditions</summary>
      <div className="stack">
        <div className="battle-advanced__group stack">
          <h5>Turns and repeated actions</h5>
          <div className="battle-input-grid">
            <Field label="Elapsed actor turns">
              {onChange ? <input aria-label="Elapsed actor turns" data-battle-field="turnCount" min="0" max={MAX_NATIVE_INTEGER} type="number" value={battle.turnCount ?? ''} placeholder="Unknown" onChange={event => update({ turnCount: amount(event.target.value) })}/> : <span>{numberText(battle.turnCount)}</span>}
            </Field>
            {!self && <Field label="Elapsed target turns">
              {onChange ? <input aria-label="Elapsed target turns" data-battle-field="targetTurnCount" min="0" max={MAX_NATIVE_INTEGER} type="number" value={battle.targetTurnCount ?? ''} placeholder="Unknown" onChange={event => update({ targetTurnCount: amount(event.target.value) })}/> : <span>{numberText(battle.targetTurnCount)}</span>}
            </Field>}
            <Field label="Repeated action count">
              {onChange ? <input aria-label="Repeated action count" data-battle-field="repeatCount" min="0" max={MAX_NATIVE_INTEGER} type="number" value={battle.repeatCount ?? ''} placeholder="Unknown" onChange={event => update({ repeatCount: amount(event.target.value) })}/> : <span>{numberText(battle.repeatCount)}</span>}
            </Field>
          </div>
        </div>
        <div className="battle-advanced__group stack">
          <h5>Automatic statuses</h5>
          {onChange ? <label className="check-row">
            <input type="checkbox" data-battle-field="automaticStatuses" checked={battle.automaticStatuses} onChange={event => update({ automaticStatuses: event.target.checked })}/>
            <span>Include guaranteed automatic battle-start statuses</span>
          </label> : <p>Automatic battle-start statuses: {battle.automaticStatuses ? 'Included when guaranteed' : 'Excluded'}</p>}
          <p className="field__hint">Select chance-based or possibly expired statuses only if they are active.</p>
        </div>
        <div className="battle-advanced__group stack">
          <h5>Threat and charging conditions</h5>
          <div className="battle-input-grid">
            {Object.entries(conditionLabels).map(([key, label]) => <Field label={label} key={key}>
              {onChange ? <select
                aria-label={label}
                data-battle-field={key}
                value={battle[key as keyof typeof conditionLabels] === null ? '' : String(battle[key as keyof typeof conditionLabels])}
                onChange={event => update({ [key]: knownBoolean(event.target.value) })}
              >
                <option value="">Unknown</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select> : <span>{battle[key as keyof typeof conditionLabels] === null ? 'Unknown' : battle[key as keyof typeof conditionLabels] ? 'Yes' : 'No'}</span>}
            </Field>)}
          </div>
        </div>
        <div className="battle-advanced__group battle-history-grid">
          <StatusHistory {...context} label="Statuses previously applied to actor" refs={battle.userPreviouslyAppliedStatuses} onChange={onChange ? userPreviouslyAppliedStatuses => update({ userPreviouslyAppliedStatuses }) : undefined}/>
          {!self && <StatusHistory {...context} label="Statuses previously applied to target" refs={battle.previouslyAppliedStatuses} onChange={onChange ? previouslyAppliedStatuses => update({ previouslyAppliedStatuses }) : undefined}/>}
        </div>
      </div>
    </details>
  </div>
}
