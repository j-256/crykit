import type { ReactNode } from 'react'
import { calculationGenderId, calculationGenderLabel, type GenderDefinition } from '../domain/calculation-genders'
import { PC_GAME_RULES, type GameRuleResolution } from '../domain/game-rules'
import type { BuildCalculationPlan } from '../domain/types'
import { InlineNotice } from './components'
import type { GameSetupDraft } from './GameSetupEditor'
import { gameRuleLabel, gameRuleScope, gameRuleValue } from './game-rule-labels'
import { knowledgeLabel } from './model'
import { TechnicalFieldInfo } from './TechnicalFieldInfo'
import { Sources } from './Sources'

function bonusFlags(gender: GenderDefinition): string {
  return gender.issues.length ? 'Unknown bonus flags' : Object.entries(gender.boosts).filter(([, enabled]) => enabled).map(([stat]) => stat).join(', ') || 'No stat bonuses'
}

function ProfileSources({ gender, anchor, uncertain = false }: { readonly gender: GenderDefinition; readonly anchor: ReactNode; readonly uncertain?: boolean }) {
  const bonusEvidence = gender.sourceKind === 'mod' || gender.issues.length > 0 || uncertain
  if (!bonusEvidence && !gender.nameSource) return <>{anchor}</>
  return <Sources anchor={anchor} label={`Sources for ${gender.name} bonus profile`}>{bonusEvidence && <p>Bonus flags: {gender.source}</p>}{gender.nameSource && <p>Profile name: {gender.nameSource}. This changes the name without changing bonus flags.</p>}</Sources>
}

export function GameRuleDetails({ rules, draft, legacyRules, calculation }: { readonly rules: GameRuleResolution; readonly draft: GameSetupDraft; readonly legacyRules: boolean; readonly calculation?: BuildCalculationPlan }) {
  const selectedId = calculationGenderId(calculation)
  const selected = rules.genders.find(gender => gender.id === selectedId)
  const groups = [...new Map(rules.genders.map(gender => [JSON.stringify([gender.sourceKind, gender.source]), { source: gender.source, kind: gender.sourceKind }])).values()]
  const issues = [...new Set([...rules.issues, ...rules.difficultyIssues])]
  return <div className="game-setup-disclosure__body stack game-rule-details">
    {calculation && <section aria-label="Selected gender bonuses" className="game-rule-profile">
      <h4>Selected bonus profile</h4>
      {selected ? <ProfileSources anchor={<strong>{selected.name}</strong>} gender={selected} uncertain={rules.issues.length > 0}/> : <strong>{calculationGenderLabel(calculation, rules.genders)}</strong>}
      {selected ? <p>{!selected.issues.length && Object.values(selected.boosts).some(Boolean) ? `Bonus stats: ${bonusFlags(selected)}` : bonusFlags(selected)}</p> : <p>{selectedId === undefined ? 'No-bonus comparison baseline.' : 'This saved profile is unavailable in the selected Game Setup. Its totals remain unknown.'}</p>}
    </section>}
    <details className="game-rule-details__section">
      <summary>All bonus profiles · {rules.genders.length}</summary>
      <div aria-label="Game Setup gender bonuses" className="stack">{groups.map(group => <section key={JSON.stringify(group)}><h4>{group.kind === 'native' ? 'Base game' : group.source}</h4><ul>{rules.genders.filter(gender => gender.source === group.source && gender.sourceKind === group.kind).map(gender => <li key={gender.id}><ProfileSources anchor={<><strong>{gender.name}</strong>: {bonusFlags(gender)}</>} gender={gender} uncertain={rules.issues.length > 0}/></li>)}</ul></section>)}<p className="field__hint">The selected profile's flags choose which stats receive a bonus. Bonus amounts and rounding follow native formulas. An unspecified calculation gender provides a no-bonus comparison baseline.</p></div>
    </details>
    {rules.changes.length > 0 && <details className="game-rule-details__section">
      <summary>Other rule changes · {rules.changes.length}</summary>
      <ul aria-label="Mod rule changes" className="game-rule-changes">{rules.changes.map(change => {
        const field = gameRuleLabel(change)
        return <li key={change.field}>
          <div className="game-rule-change__heading"><strong>{field.label}</strong><TechnicalFieldInfo field={change.field} label={field.label}/></div>
          <Sources anchor={<p>{gameRuleValue(change.baseline, field.unit)} to <strong>{gameRuleValue(change.value, field.unit)}</strong></p>} label={`Sources for ${field.label}`}><p>{change.source}</p></Sources>
          <p className="field__hint">{field.description}</p>
          <small>{gameRuleScope(change)}</small>
        </li>
      })}</ul>
    </details>}
    <details className="game-rule-details__section">
      <summary>Difficulty and engine rules</summary>
      <div className="stack">
        {rules.difficulty && <div>{rules.difficulty.sourceKind === 'mod' || rules.difficultyIssues.length > 0 ? <Sources anchor={<h4>{rules.difficulty.name}</h4>} label={`Sources for ${rules.difficulty.name} difficulty`}><p>{rules.difficulty.source}</p></Sources> : <h4>{rules.difficulty.name}</h4>}<p>Enemy HP: {rules.difficulty.values.MonsterHPRate ?? 'Unknown'}%. Boss HP: {rules.difficulty.values.BossHPRate ?? 'Unknown'}%. Player hit modifier: {rules.difficulty.values.MemberHitChanceMod ?? 'Unknown'} percentage points.</p></div>}
        <dl className="definition-list"><div className="definition-row" data-game-setup-focus="passives"><dt>Saved PP budget</dt><dd>{knowledgeLabel(draft.ppLimit)}</dd></div><div className="definition-row" data-game-setup-focus="slots"><dt>Saved equipment layout</dt><dd>{draft.slots.map(slot => slot.label).join(', ') || 'Unspecified'}</dd></div></dl>
        <p className="field__hint">PC 1.6.9.0 uses a {PC_GAME_RULES.ppLimit} PP budget and {PC_GAME_RULES.equipmentSlots} equipment slots. Mods can change class growth, equipment and passive effects, bonus profiles, and supported calculation constants. Native formulas, rounding, and caps apply. Switch, Linux, other versions, and full mod runtime parity remain unverified.</p>
        {legacyRules && <InlineNotice title="Saved rules">This setup contains imported or manually specified rules. They stay intact when you change version, difficulty, or mods. To plan with standard rules, start a new Game Setup.</InlineNotice>}
      </div>
    </details>
    {issues.length > 0 && <InlineNotice title="Calculation coverage"><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></InlineNotice>}
  </div>
}
