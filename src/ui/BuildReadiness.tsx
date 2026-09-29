import { useState } from 'react'
import { effectiveScenarioAssignments, entityDefinitionKey, scenarioMemberIds, TEAM_SIZE } from '../domain'
import type { Build, BuildRevision, CatalogRef, CatalogSnapshot, Profile, TeamScenario, ValidationIssue, ValidationReport } from '../domain/types'
import { groupValidationIssues } from './build-evidence'
import { Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { catalogLocksMatch, entityName, ownRecordValue } from './model'
import { useNavigation, type AppRoute } from './navigation'

const VALIDATION_CODE = Object.freeze({
  catalogApplicabilityUnknown: 'CATALOG_APPLICABILITY_UNKNOWN',
  catalogSnapshotUnavailable: 'CATALOG_SNAPSHOT_UNAVAILABLE',
  rulesetFieldUnknown: 'RULESET_FIELD_UNKNOWN',
  suggestedSlotDefinition: 'SUGGESTED_SLOT_DEFINITION',
})

interface ValidationAction {
  readonly label: string
  readonly route: AppRoute
}

function issueInputs(issue: ValidationIssue): Readonly<Record<string, unknown>> {
  return issue.inputs && typeof issue.inputs === 'object' && !Array.isArray(issue.inputs) ? issue.inputs as Readonly<Record<string, unknown>> : {}
}

function issueCatalog(issue: ValidationIssue, catalogs: readonly CatalogSnapshot[]): CatalogSnapshot | undefined {
  const inputs = issueInputs(issue)
  return typeof inputs.catalogId === 'string' && typeof inputs.revisionId === 'string'
    ? catalogs.find(catalog => catalog.id === inputs.catalogId && catalog.revisionId === inputs.revisionId)
    : undefined
}

function coverageRef(catalog: CatalogSnapshot): CatalogRef | undefined {
  const entity = Object.values(catalog.entities).find(candidate => candidate.kind === 'other' && /catalog coverage|coverage gaps/i.test(candidate.name))
  return entity ? { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id } : undefined
}

function issueContext(issue: ValidationIssue, profile: Profile, catalogs: readonly CatalogSnapshot[], report: ValidationReport, scenario?: TeamScenario) {
  const details: string[] = []
  if (issue.ref) details.push(entityName(profile, catalogs, issue.ref))
  if (issue.characterId) details.push(ownRecordValue(profile.characters, issue.characterId)?.name ?? issue.characterId)
  if (issue.slotId) details.push(ownRecordValue(profile.rulesets, report.rulesetRevisionId)?.slots.find((slot) => slot.id === issue.slotId)?.label ?? issue.slotId)
  if (issue.ref && scenario && !issue.characterId) {
    const affected = Object.entries(effectiveScenarioAssignments(scenario)).flatMap(([characterId, revisionId]) => {
      const revision = revisionId ? ownRecordValue(profile.buildRevisions, revisionId) : undefined
      return revision && [...Object.values(revision.content.equipment).flatMap(selection => selection ? [selection] : []), ...revision.content.passives].some((selection) => entityDefinitionKey(selection.ref) === entityDefinitionKey(issue.ref!)) ? [ownRecordValue(profile.characters, characterId)?.name ?? characterId] : []
    })
    if (affected.length) details.push(`Assigned to ${affected.join(', ')}`)
  }
  const inputs = issueInputs(issue)
  if (Object.keys(inputs).length > 0) {
    if (typeof inputs.field === 'string') details.push(inputs.field)
    const demand = typeof inputs.demand === 'number' ? inputs.demand : undefined
    const available = typeof inputs.available === 'number' ? inputs.available : typeof inputs.confirmedAvailable === 'number' ? inputs.confirmedAvailable : undefined
    if (demand !== undefined) details.push(`${demand} required${available !== undefined ? `, ${available} confirmed available` : ''}`)
  }
  if (issue.code === VALIDATION_CODE.catalogApplicabilityUnknown) {
    const catalog = issueCatalog(issue, catalogs)
    if (catalog) {
      const applicability = catalog.applicability
      if (applicability.state === 'unknown' && applicability.reason) details.push(applicability.reason)
      else if (applicability.state === 'conflicting') details.push('The pinned reference contains conflicting applicability claims')
      details.push(`${catalog.id} · ${catalog.revisionId}`)
    }
  }
  return [...new Set(details)].join(' · ')
}

function issueActions(issue: ValidationIssue, profile: Profile, catalogs: readonly CatalogSnapshot[], report: ValidationReport): readonly ValidationAction[] {
  if (issue.code.includes('STOCK')) return [{ label: issue.ref ? `Review stock for ${entityName(profile, catalogs, issue.ref)}` : 'Review inventory', route: { page: { page: 'inventory', view: 'list' }, overlays: [], query: { v: ['1'], q: [issue.ref ? entityName(profile, catalogs, issue.ref) : ''] } } }]
  if (issue.characterId && (issue.code.startsWith('PP_') || issue.code.includes('LEARN') || issue.code.startsWith('CLASS_'))) return [{ label: issue.code.startsWith('PP_') ? 'Record character PP capacity' : issue.code.startsWith('CLASS_') ? 'Review class unlocks' : 'Review learned skills', route: { page: { page: 'characters', view: 'character', characterId: issue.characterId, tab: issue.code.startsWith('PP_') ? 'current' : issue.code.startsWith('CLASS_') ? 'classes' : 'knowledge' }, overlays: [], query: {} } }]
  if (issue.code === VALIDATION_CODE.rulesetFieldUnknown) return [{ label: 'Review setup', route: { page: { page: 'settings', section: 'ruleset' }, overlays: [], query: { ruleset: [report.rulesetRevisionId], focus: ['setup'] } } }]
  if (issue.code === VALIDATION_CODE.suggestedSlotDefinition) return [{ label: 'Review planner defaults', route: { page: { page: 'settings', section: 'ruleset' }, overlays: [], query: { ruleset: [report.rulesetRevisionId], focus: ['slots'] } } }]
  if (issue.code === VALIDATION_CODE.catalogApplicabilityUnknown) {
    const catalog = issueCatalog(issue, catalogs)
    const ref = catalog ? coverageRef(catalog) : undefined
    return [
      { label: 'Review catalog coverage', route: ref ? { page: { page: 'reference', view: 'detail', ref }, overlays: [], query: {} } : { page: { page: 'reference', view: 'list' }, overlays: [], query: { v: ['1'], q: ['catalog coverage'] } } },
      { label: 'Import reference data', route: { page: { page: 'settings', section: 'data' }, overlays: [], query: {} } },
    ]
  }
  if (issue.code === VALIDATION_CODE.catalogSnapshotUnavailable) return [{ label: 'Import reference data', route: { page: { page: 'settings', section: 'data' }, overlays: [], query: {} } }]
  if (issue.ref) return [{ label: `Inspect ${entityName(profile, catalogs, issue.ref)}`, route: { page: { page: 'reference', view: 'detail', ref: issue.ref }, overlays: [], query: {} } }]
  return []
}

function issueGroupPresentation(issue: ValidationIssue, count: number): { readonly summary: string; readonly detail?: string } {
  if (issue.code === VALIDATION_CODE.rulesetFieldUnknown) return { summary: `Setup needs review${count > 1 ? ` · ${count} fields` : ''}`, detail: 'Record or resolve the playthrough setup used by this pinned ruleset. A recorded value is not an independent verification.' }
  if (issue.code === VALIDATION_CODE.suggestedSlotDefinition) return { summary: `Planner defaults in use${count > 1 ? ` · ${count} slots` : ''}`, detail: 'These slots are planner-supplied starting assumptions. Review them or explicitly accept the layout for a new ruleset revision.' }
  if (issue.code === VALIDATION_CODE.catalogApplicabilityUnknown) return { summary: 'Reference coverage is limited', detail: 'The pinned catalog retains useful facts, but its sources do not establish exact applicability to this game setup.' }
  if (issue.code === VALIDATION_CODE.catalogSnapshotUnavailable) return { summary: 'Pinned reference is unavailable', detail: 'Import the missing reference revision before relying on checks that use it.' }
  return { summary: `${issue.status === 'invalid' ? 'Needs attention' : 'Unknown'}: ${issue.message}${count > 1 ? ` (${count} checks)` : ''}` }
}

export function ValidationPanel({ report, profile, catalogs, scenario }: { report?: ValidationReport; profile: Profile; catalogs: readonly CatalogSnapshot[]; scenario?: TeamScenario }) {
  const navigation = useNavigation()
  const labels: Record<string, string> = { structure: 'Structure', equipment: 'Equipment legality', passives: 'Passive legality', characterReadiness: 'Character readiness', inventory: 'Inventory sufficiency', rulesetCertainty: 'Setup and reference coverage', calculationReadiness: 'Calculation readiness' }
  if (!report) return <InlineNotice title="Validation awaits a scenario">Assign a saved revision to a team to evaluate simultaneous stock and readiness. Planning does not require ownership or learned skills.</InlineNotice>
  return <div className="validation-list">{Object.entries(report.dimensions).map(([dimension, result]) => <div className={`validation-item validation-item--${result.status}`} key={dimension}><span className="validation-item__icon"><Icon name={result.status === 'valid' ? 'check' : result.status === 'invalid' ? 'close' : 'warning'}/></span><div><strong>{labels[dimension] ?? dimension}</strong>{result.status === 'valid' ? <p>No issue found with the known inputs.</p> : result.status === 'notApplicable' ? <p>Not applicable in this scenario.</p> : groupValidationIssues(result.issues).map((group) => {
    const first = group[0]!
    const presentation = issueGroupPresentation(first, group.length)
    const actions = new Map(group.flatMap(issue => issueActions(issue, profile, catalogs, report).map(action => [`${action.label}:${JSON.stringify(action.route)}`, action] as const)))
    return <details className="validation-group" key={`${first.code}:${first.message}:${first.status}`}><summary>{presentation.summary}</summary>{presentation.detail && <p>{presentation.detail}</p>}<ul className="validation-issues">{group.map((issue, index) => <li key={index}>{issueContext(issue, profile, catalogs, report, scenario) || issue.message}{issue.suggestion && <small>{issue.suggestion}</small>}</li>)}</ul><div className="validation-actions">{[...actions].map(([key, action]) => <Button key={key} onClick={() => navigation.navigate(action.route)} tone="quiet" type="button">{action.label}</Button>)}</div></details>
  })}</div></div>)}</div>
}

export function BuildReadinessAssignment({ build, revision, profile, disabled, onAssign, scenarioId, onScenarioChange }: { scenarioId?: string; onScenarioChange: (scenarioId: string) => void; build: Build; revision: BuildRevision; profile: Profile; disabled: boolean; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void> }) {
  const navigation = useNavigation()
  const scenarios = Object.values(profile.scenarios).filter((scenario) => {
    const members = scenarioMemberIds(scenario)
    return scenario.kind !== 'recordedCurrent' && scenario.rulesetRevisionId === revision.rulesetRevisionId && catalogLocksMatch(scenario.catalogLock, revision.catalogLock) && members.length === TEAM_SIZE && new Set(members).size === TEAM_SIZE && (!build.characterId || members.includes(build.characterId))
  })
  const [characterChoice, setCharacterChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? scenarios.find((entry) => entry.id === profile.activeScenarioId) ?? scenarios[0]
  const members = new Set(scenario ? scenarioMemberIds(scenario) : [])
  const characters = Object.values(profile.characters).filter((character) => members.has(character.id) && (!build.characterId || build.characterId === character.id))
  const character = characters.find((entry) => entry.id === characterChoice) ?? characters[0]
  const assigned = Boolean(scenario && character && effectiveScenarioAssignments(scenario)[character.id] === revision.id)
  const assign = async () => {
    if (!scenario || !character || busy || disabled) return
    setBusy(true)
    setError(undefined)
    try { await onAssign(scenario.id, character.id, revision.id); onScenarioChange(scenario.id) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The assignment could not be saved.') } finally { setBusy(false) }
  }
  return <section aria-label="Assign revision for readiness" className="readiness-assignment stack">
    <h3>Choose the current-use context</h3>
    <p>Assign saved r{revision.revision} to a character and team. This checks present readiness without recording an in-game change.</p>
    {disabled && <p>Save or discard editor changes before assigning a revision.</p>}
    {scenarios.length > 0 && characters.length > 0 ? <><div className="grid-2"><Field label="Readiness scenario"><select disabled={busy || disabled} onChange={(event) => onScenarioChange(event.target.value)} value={scenario?.id}>{scenarios.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></Field><Field label="Readiness character"><select disabled={busy || disabled} onChange={(event) => setCharacterChoice(event.target.value)} value={character?.id}>{characters.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field></div><div className="cluster"><Button disabled={busy || disabled || assigned} onClick={() => void assign()} type="button">{busy ? 'Assigning...' : assigned ? 'Revision assigned' : 'Assign revision to team'}</Button><Button disabled={busy || disabled} onClick={() => { if (scenario) navigation.navigate({ page: { page: 'builds', view: 'scenario', scenarioId: scenario.id }, overlays: [], query: {} }) }} tone="quiet" type="button">Open team scenario</Button></div></> : <div className="cluster">{characters.length === 0 && <Button disabled={disabled} onClick={() => navigation.navigate({ page: { page: 'characters', view: 'new' }, overlays: [], query: {} })} type="button">Add a character</Button>}{scenarios.length === 0 && <><p>No editable team uses this revision's ruleset and catalog snapshot.</p><Button disabled={disabled} onClick={() => navigation.navigate({ page: { page: 'builds', view: 'scenario-new' }, overlays: [], query: { forRevision: [revision.id] } })} type="button">Create a team scenario</Button></>}</div>}
    {error && <InlineNotice title="Assignment not saved" tone="danger">{error} Retry after resolving the save problem.</InlineNotice>}
  </section>
}
