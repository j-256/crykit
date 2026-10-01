import { useState } from 'react'
import { sameBuildBehavior, effectiveScenarioAssignments, entityDefinitionKey, requirePlaythrough } from '../domain'
import type { Build, BuildRevision, CatalogRef, CatalogSnapshot, LocalData, TeamScenario, ValidationIssue, ValidationReport } from '../domain/types'
import { groupValidationIssues } from './build-evidence'
import { NATIVE_SCOPE_UNVERIFIED } from '../domain/native-game'
import { Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { catalogLocksMatch, entityName, ownRecordValue } from './model'
import { useNavigation, type AppRoute } from './navigation'

const VALIDATION_CODE = Object.freeze({
  catalogApplicabilityUnknown: 'CATALOG_APPLICABILITY_UNKNOWN',
  catalogSnapshotUnavailable: 'CATALOG_SNAPSHOT_UNAVAILABLE',
  ppLimitUnknown: 'PP_LIMIT_UNKNOWN',
  gameSetupFieldUnknown: 'GAME_SETUP_FIELD_UNKNOWN',
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

function issueContext(issue: ValidationIssue, localData: LocalData, catalogs: readonly CatalogSnapshot[], report: ValidationReport, scenario?: TeamScenario) {
  const details: string[] = []
  if (issue.ref) details.push(entityName(localData, catalogs, issue.ref))
  if (issue.characterId) details.push(ownRecordValue(requirePlaythrough(localData).characters, issue.characterId)?.name ?? issue.characterId)
  if (issue.slotId) details.push(ownRecordValue(localData.gameSetups, report.gameSetupRevisionId)?.slots.find((slot) => slot.id === issue.slotId)?.label ?? issue.slotId)
  if (issue.ref && scenario && !issue.characterId) {
    const affected = Object.entries(effectiveScenarioAssignments(scenario)).flatMap(([characterId, revisionId]) => {
      const revision = revisionId ? ownRecordValue(localData.buildRevisions, revisionId) : undefined
      return revision && [...Object.values(revision.content.equipment).flatMap(selection => selection ? [selection] : []), ...revision.content.passives].some((selection) => entityDefinitionKey(selection.ref) === entityDefinitionKey(issue.ref!)) ? [ownRecordValue(requirePlaythrough(localData).characters, characterId)?.name ?? characterId] : []
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

function issueActions(issue: ValidationIssue, localData: LocalData, catalogs: readonly CatalogSnapshot[], report: ValidationReport): readonly ValidationAction[] {
  if (issue.code.includes('STOCK')) return [{ label: issue.ref ? `Review stock for ${entityName(localData, catalogs, issue.ref)}` : 'Review inventory', route: { page: { page: 'inventory', view: 'list' }, overlays: [], query: { v: ['1'], q: [issue.ref ? entityName(localData, catalogs, issue.ref) : ''] } } }]
  if (issue.code === VALIDATION_CODE.ppLimitUnknown) return [{ label: 'Review passive rules', route: { page: { page: 'settings', section: 'game-setup' }, overlays: [], query: { gameSetup: [report.gameSetupRevisionId], focus: ['passives'] } } }]
  if (issue.characterId && (issue.code.includes('LEARN') || issue.code.startsWith('CLASS_'))) return [{ label: issue.code.startsWith('CLASS_') ? 'Review class unlocks' : 'Review learned skills', route: { page: { page: 'characters', view: 'character', characterId: issue.characterId, tab: 'current' }, overlays: [], query: {} } }]
  if (issue.code === VALIDATION_CODE.gameSetupFieldUnknown || issue.code === NATIVE_SCOPE_UNVERIFIED) return [{ label: 'Review setup', route: { page: { page: 'settings', section: 'game-setup' }, overlays: [], query: { gameSetup: [report.gameSetupRevisionId], focus: ['setup'] } } }]
  if (issue.code === VALIDATION_CODE.suggestedSlotDefinition) return [{ label: 'Review planner defaults', route: { page: { page: 'settings', section: 'game-setup' }, overlays: [], query: { gameSetup: [report.gameSetupRevisionId], focus: ['slots'] } } }]
  if (issue.code === VALIDATION_CODE.catalogApplicabilityUnknown) {
    const catalog = issueCatalog(issue, catalogs)
    const ref = catalog ? coverageRef(catalog) : undefined
    return [
      { label: 'Review catalog coverage', route: ref ? { page: { page: 'reference', view: 'detail', ref }, overlays: [], query: {} } : { page: { page: 'reference', view: 'list' }, overlays: [], query: { v: ['1'], q: ['catalog coverage'] } } },
      { label: 'Import reference data', route: { page: { page: 'settings', section: 'data' }, overlays: [], query: {} } },
    ]
  }
  if (issue.code === VALIDATION_CODE.catalogSnapshotUnavailable) return [{ label: 'Import reference data', route: { page: { page: 'settings', section: 'data' }, overlays: [], query: {} } }]
  if (issue.ref) return [{ label: `Inspect ${entityName(localData, catalogs, issue.ref)}`, route: { page: { page: 'reference', view: 'detail', ref: issue.ref }, overlays: [], query: {} } }]
  return []
}

function issueGroupPresentation(issue: ValidationIssue, count: number): { readonly summary: string; readonly detail?: string } {
  if (issue.code === VALIDATION_CODE.gameSetupFieldUnknown) return { summary: `Setup needs review${count > 1 ? ` · ${count} fields` : ''}`, detail: 'Review the version, difficulty, and mods saved with this checkpoint. A recorded setting does not establish source coverage.' }
  if (issue.code === VALIDATION_CODE.suggestedSlotDefinition) return { summary: `Planner defaults in use${count > 1 ? ` · ${count} slots` : ''}`, detail: 'These slots use the standard PC layout. Check the Game Setup for version and platform coverage.' }
  if (issue.code === VALIDATION_CODE.catalogApplicabilityUnknown) return { summary: 'Reference coverage is limited', detail: 'The pinned catalog retains useful facts, but its sources do not establish exact applicability to this game setup.' }
  if (issue.code === NATIVE_SCOPE_UNVERIFIED) return { summary: 'Game data parity is unresolved', detail: 'A different platform or version does not establish missing content or update lag. These facts remain available as scoped reference data.' }
  if (issue.code === VALIDATION_CODE.catalogSnapshotUnavailable) return { summary: 'Pinned reference is unavailable', detail: 'Import the missing reference revision before relying on checks that use it.' }
  return { summary: `${issue.status === 'invalid' ? 'Needs attention' : 'Unknown'}: ${issue.message}${count > 1 ? ` (${count} checks)` : ''}` }
}

export function ValidationPanel({ report, localData, catalogs, scenario }: { report?: ValidationReport; localData: LocalData; catalogs: readonly CatalogSnapshot[]; scenario?: TeamScenario }) {
  const navigation = useNavigation()
  const labels: Record<string, string> = { structure: 'Structure', equipment: 'Equipment legality', passives: 'Passive legality', characterReadiness: 'Character readiness', inventory: 'Inventory sufficiency', gameSetupCertainty: 'Setup and reference coverage', calculationReadiness: 'Calculation readiness' }
  if (!report) return <InlineNotice title="Choose a party plan">Assign a saved revision to a party plan to evaluate simultaneous stock and readiness. Planning does not require ownership or learned skills.</InlineNotice>
  const dimensions = Object.entries(report.dimensions)
  const concerns = dimensions.filter(([, result]) => result.status === 'invalid' || result.status === 'undetermined')
  const invalidCount = concerns.filter(([, result]) => result.status === 'invalid').length
  const clearCount = dimensions.filter(([, result]) => result.status === 'valid').length
  const overviewStatus = invalidCount > 0 ? 'invalid' : concerns.length > 0 ? 'undetermined' : 'valid'
  const overviewTitle = overviewStatus === 'invalid' ? 'Party needs changes' : overviewStatus === 'undetermined' ? 'Some party checks are unresolved' : 'No known party issues'
  return <div className="validation-list"><div className="validation-overview" data-status={overviewStatus}><Icon name={overviewStatus === 'valid' ? 'check' : overviewStatus === 'invalid' ? 'close' : 'warning'}/><strong>{overviewTitle}</strong><small>{clearCount} {clearCount === 1 ? 'check' : 'checks'} clear</small></div>{concerns.map(([dimension, result]) => <div className={`validation-item validation-item--${result.status}`} key={dimension}><span className="validation-item__icon"><Icon name={result.status === 'invalid' ? 'close' : 'warning'}/></span><div><strong>{labels[dimension] ?? dimension}</strong>{groupValidationIssues(result.issues).map((group) => {
    const first = group[0]!
    const presentation = issueGroupPresentation(first, group.length)
    const actions = new Map(group.flatMap(issue => issueActions(issue, localData, catalogs, report).map(action => [`${action.label}:${JSON.stringify(action.route)}`, action] as const)))
    return <details className="validation-group" key={`${first.code}:${first.message}:${first.status}`}><summary>{presentation.summary}</summary>{presentation.detail && <p>{presentation.detail}</p>}<ul className="validation-issues">{group.map((issue, index) => <li key={index}>{issueContext(issue, localData, catalogs, report, scenario) || issue.message}{issue.suggestion && <small>{issue.suggestion}</small>}</li>)}</ul><div className="validation-actions">{[...actions].map(([key, action]) => <Button key={key} onClick={() => navigation.navigate(action.route)} tone="quiet" type="button">{action.label}</Button>)}</div></details>
  })}</div></div>)}</div>
}

export function BuildReadinessAssignment({ build, revision, localData, disabled, onAssign, scenarioId, onScenarioChange }: { scenarioId?: string; onScenarioChange: (scenarioId: string) => void; build: Build; revision: BuildRevision; localData: LocalData; disabled: boolean; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void> }) {
  void build
  const navigation = useNavigation()
  const scenarios = Object.values(requirePlaythrough(localData).scenarios).filter((scenario) => {
    return scenario.kind !== 'recordedCurrent' && sameBuildBehavior(localData.gameSetups[scenario.gameSetupRevisionId], localData.gameSetups[revision.gameSetupRevisionId]) && catalogLocksMatch(scenario.catalogLock, revision.catalogLock)
  })
  const [characterChoice, setCharacterChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? scenarios.find((entry) => entry.id === requirePlaythrough(localData).activeScenarioId) ?? scenarios[0]
  const members = new Set(scenario?.memberIds ?? [])
  const characters = Object.values(requirePlaythrough(localData).characters).filter((character) => members.has(character.id))
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
    <p>Assign saved r{revision.revision} to a tracked character in a party plan. This checks present readiness without recording an in-game change.</p>
    {disabled && <p>Save or discard editor changes before assigning a revision.</p>}
    {scenarios.length > 0 && characters.length > 0 ? <><div className="grid-2"><Field label="Party plan"><select disabled={busy || disabled} onChange={(event) => onScenarioChange(event.target.value)} value={scenario?.id}>{scenarios.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></Field><Field label="Tracked character"><select disabled={busy || disabled} onChange={(event) => setCharacterChoice(event.target.value)} value={character?.id}>{characters.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field></div><div className="cluster"><Button disabled={busy || disabled || assigned} onClick={() => void assign()} type="button">{busy ? 'Assigning...' : assigned ? 'Revision assigned' : 'Assign revision to party'}</Button><Button disabled={busy || disabled} onClick={() => { if (scenario) navigation.navigate({ page: { page: 'builds', view: 'scenario', scenarioId: scenario.id }, overlays: [], query: {} }) }} tone="quiet" type="button">Open party plan</Button></div></> : <div className="cluster">{characters.length === 0 && <Button disabled={disabled} onClick={() => navigation.navigate({ page: { page: 'characters', view: 'new' }, overlays: [], query: {} })} type="button">Add a character</Button>}{scenarios.length === 0 && <><p>No editable party plan uses this revision's Game Setup and catalog snapshot.</p><Button disabled={disabled} onClick={() => navigation.navigate({ page: { page: 'builds', view: 'scenario-new' }, overlays: [], query: { forRevision: [revision.id] } })} type="button">Create a party plan</Button></>}</div>}
    {error && <InlineNotice title="Assignment not saved" tone="danger">{error} Retry after resolving the save problem.</InlineNotice>}
  </section>
}
