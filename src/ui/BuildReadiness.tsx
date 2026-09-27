import { useState } from 'react'
import { effectiveScenarioAssignments, entityDefinitionKey } from '../domain'
import type { Build, BuildRevision, CatalogSnapshot, Profile, TeamScenario, ValidationIssue, ValidationReport } from '../domain/types'
import { groupValidationIssues } from './build-evidence'
import { Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { catalogLocksMatch, entityName, ownRecordValue } from './model'
import { useNavigation, type AppRoute } from './navigation'

function issueContext(issue: ValidationIssue, profile: Profile, catalogs: readonly CatalogSnapshot[], report: ValidationReport, scenario?: TeamScenario) {
  const details: string[] = []
  if (issue.ref) details.push(entityName(profile, catalogs, issue.ref))
  if (issue.characterId) details.push(ownRecordValue(profile.characters, issue.characterId)?.name ?? issue.characterId)
  if (issue.slotId) details.push(ownRecordValue(profile.rulesets, report.rulesetRevisionId)?.slots.find((slot) => slot.id === issue.slotId)?.label ?? issue.slotId)
  if (issue.ref && scenario && !issue.characterId) {
    const affected = Object.entries(effectiveScenarioAssignments(scenario)).flatMap(([characterId, revisionId]) => {
      const revision = revisionId ? ownRecordValue(profile.buildRevisions, revisionId) : undefined
      return revision && Object.values(revision.content.selections).some((selection) => selection && entityDefinitionKey(selection.ref) === entityDefinitionKey(issue.ref!)) ? [ownRecordValue(profile.characters, characterId)?.name ?? characterId] : []
    })
    if (affected.length) details.push(`Assigned to ${affected.join(', ')}`)
  }
  if (issue.inputs && typeof issue.inputs === 'object' && !Array.isArray(issue.inputs)) {
    const inputs = issue.inputs as Readonly<Record<string, unknown>>
    if (typeof inputs.field === 'string') details.push(inputs.field)
    const demand = typeof inputs.demand === 'number' ? inputs.demand : undefined
    const available = typeof inputs.available === 'number' ? inputs.available : typeof inputs.confirmedAvailable === 'number' ? inputs.confirmedAvailable : undefined
    if (demand !== undefined) details.push(`${demand} required${available !== undefined ? `, ${available} confirmed available` : ''}`)
  }
  return [...new Set(details)].join(' · ')
}

function issueAction(issue: ValidationIssue, profile: Profile, catalogs: readonly CatalogSnapshot[]): { label: string; route: AppRoute } | undefined {
  if (issue.code.includes('STOCK')) return { label: issue.ref ? `Review stock for ${entityName(profile, catalogs, issue.ref)}` : 'Review inventory', route: { page: { page: 'inventory', view: 'list' }, overlays: [], query: { v: ['1'], q: [issue.ref ? entityName(profile, catalogs, issue.ref) : ''] } } }
  if (issue.characterId && (issue.code.startsWith('PP_') || issue.code.includes('LEARN') || issue.code.startsWith('CLASS_'))) return { label: issue.code.startsWith('PP_') ? 'Record character PP capacity' : issue.code.startsWith('CLASS_') ? 'Review class unlocks' : 'Review learned skills', route: { page: { page: 'characters', view: 'character', characterId: issue.characterId, tab: issue.code.startsWith('PP_') ? 'current' : issue.code.startsWith('CLASS_') ? 'classes' : 'knowledge' }, overlays: [], query: {} } }
  if (issue.code === 'SUGGESTED_SLOT_DEFINITION' || issue.code === 'RULESET_FIELD_UNKNOWN') return { label: 'Review ruleset settings', route: { page: { page: 'settings', section: 'ruleset' }, overlays: [], query: {} } }
  if (issue.ref) return { label: `Inspect ${entityName(profile, catalogs, issue.ref)}`, route: { page: { page: 'reference', view: 'detail', ref: issue.ref }, overlays: [], query: {} } }
  return undefined
}

export function ValidationPanel({ report, profile, catalogs, scenario }: { report?: ValidationReport; profile: Profile; catalogs: readonly CatalogSnapshot[]; scenario?: TeamScenario }) {
  const navigation = useNavigation()
  const labels: Record<string, string> = { structure: 'Structure', equipment: 'Equipment legality', passives: 'Passive legality', characterReadiness: 'Character readiness', inventory: 'Inventory sufficiency', rulesetCertainty: 'Ruleset certainty', calculationReadiness: 'Calculation readiness' }
  if (!report) return <InlineNotice title="Validation awaits a scenario">Assign a saved revision to a team to evaluate simultaneous stock and readiness. Planning does not require ownership or learned skills.</InlineNotice>
  return <div className="validation-list">{Object.entries(report.dimensions).map(([dimension, result]) => <div className={`validation-item validation-item--${result.status}`} key={dimension}><span className="validation-item__icon"><Icon name={result.status === 'valid' ? 'check' : result.status === 'invalid' ? 'close' : 'warning'}/></span><div><strong>{labels[dimension] ?? dimension}</strong>{result.status === 'valid' ? <p>No issue found with the known inputs.</p> : result.status === 'notApplicable' ? <p>Not applicable in this scenario.</p> : groupValidationIssues(result.issues).map((group) => {
    const first = group[0]!
    const actions = new Map(group.flatMap((issue) => { const action = issueAction(issue, profile, catalogs); return action ? [[JSON.stringify(action.route), action] as const] : [] }))
    return <details className="validation-group" key={`${first.code}:${first.message}:${first.status}`}><summary>{first.status === 'invalid' ? 'Needs attention' : 'Unknown'}: {first.code === 'RULESET_FIELD_UNKNOWN' ? 'Ruleset settings need evidence' : first.message}{group.length > 1 ? ` (${group.length} checks)` : ''}</summary><ul className="validation-issues">{group.map((issue, index) => <li key={index}>{issueContext(issue, profile, catalogs, report, scenario) || issue.message}{issue.suggestion && <small>{issue.suggestion}</small>}</li>)}</ul><div className="validation-actions">{[...actions].map(([key, action]) => <Button key={key} onClick={() => navigation.navigate(action.route)} tone="quiet" type="button">{action.label}</Button>)}</div></details>
  })}</div></div>)}</div>
}

export function BuildReadinessAssignment({ build, revision, profile, disabled, onAssign, scenarioId, onScenarioChange }: { scenarioId?: string; onScenarioChange: (scenarioId: string) => void; build: Build; revision: BuildRevision; profile: Profile; disabled: boolean; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void> }) {
  const navigation = useNavigation()
  const scenarios = Object.values(profile.scenarios).filter((scenario) => scenario.kind !== 'recordedCurrent' && scenario.rulesetRevisionId === revision.rulesetRevisionId && catalogLocksMatch(scenario.catalogLock, revision.catalogLock))
  const characters = Object.values(profile.characters).filter((character) => !build.characterId || build.characterId === character.id)
  const [characterChoice, setCharacterChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? scenarios.find((entry) => entry.id === profile.activeScenarioId) ?? scenarios[0]
  const character = characters.find((entry) => entry.id === characterChoice) ?? characters[0]
  const assigned = Boolean(scenario && character && effectiveScenarioAssignments(scenario)[character.id] === revision.id)
  const assign = async () => {
    if (!scenario || !character || busy || disabled) return
    setBusy(true)
    setError(undefined)
    try { await onAssign(scenario.id, character.id, revision.id); onScenarioChange(scenario.id) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The assignment could not be saved.') } finally { setBusy(false) }
  }
  return <section aria-label="Assign revision for readiness" className="readiness-assignment stack">
    <h3>Check this revision with a team</h3>
    <p>Assign saved r{revision.revision} to a character. This changes the scenario, without recording an in-game change.</p>
    {disabled && <p>Save or discard editor changes before assigning a revision.</p>}
    {scenarios.length > 0 && characters.length > 0 ? <><div className="grid-2"><Field label="Readiness scenario"><select disabled={busy || disabled} onChange={(event) => onScenarioChange(event.target.value)} value={scenario?.id}>{scenarios.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></Field><Field label="Readiness character"><select disabled={busy || disabled} onChange={(event) => setCharacterChoice(event.target.value)} value={character?.id}>{characters.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field></div><div className="cluster"><Button disabled={busy || disabled || assigned} onClick={() => void assign()} type="button">{busy ? 'Assigning...' : assigned ? 'Revision assigned' : 'Assign revision to team'}</Button><Button disabled={busy || disabled} onClick={() => { if (scenario) navigation.navigate({ page: { page: 'builds', view: 'scenario', scenarioId: scenario.id }, overlays: [], query: {} }) }} tone="quiet" type="button">Open team scenario</Button></div></> : <div className="cluster">{characters.length === 0 && <Button disabled={disabled} onClick={() => navigation.navigate({ page: { page: 'characters', view: 'new' }, overlays: [], query: {} })} type="button">Add a character</Button>}{scenarios.length === 0 && <><p>No editable team uses this revision's ruleset and catalog snapshot.</p><Button disabled={disabled} onClick={() => navigation.navigate({ page: { page: 'builds', view: 'scenario-new' }, overlays: [], query: { forRevision: [revision.id] } })} type="button">Create a team scenario</Button></>}</div>}
    {error && <InlineNotice title="Assignment not saved" tone="danger">{error} Retry after resolving the save problem.</InlineNotice>}
  </section>
}
