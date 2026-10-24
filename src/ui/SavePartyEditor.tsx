import { jsonEqual } from '../persistence/local-data'
import { saveDefinitionContext, saveSelectionContext } from '../workspace/save-context'
import type { SaveWorkspace } from './save-workspace'
import type { JsonValue } from '../domain/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { jsonRecord } from '../domain/crystal-edit'
import { entityDefinitionKey } from '../domain/core'
import { buildEquipmentPermissions } from '../domain/build-mechanics'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { definitionLineageRootRef } from '../domain/definitions'
import { editSave, previewSaveAdditions, type SaveEditCommand, type SaveEditorSummary } from '../domain/save-editor'
import { saveEditorDefinitionId, saveEditorDefinitionScope, type SaveEditorDefinitionScope, type SaveEditorModSource } from '../domain/save-editor-mods'
import type { BuildRevisionContent, EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import type { CrystalSave } from '../interchange/crystal-save'
import { BuildDefinitionField, BUILD_DEFINITION_PAGE_SIZE } from './BuildDefinitionField'
import { LoadoutSheet } from './LoadoutSheet'
import { Badge, Button, Field, InlineNotice } from './components'
import { ScopedDefinitionProvider, useDefinitionLibrary, type DefinitionOption } from './definitions'
import { saveEditorLevelHint } from './save-editor-levels'

interface PickerState { readonly fieldKey: string; readonly query: string; readonly resultLimit: number }
function buildContent(member: SaveEditorSummary['members'][number], scope: SaveEditorDefinitionScope): BuildRevisionContent {
  return {
    primaryClass: scope.refs.job.get(member.jobId) ?? null,
    secondaryClass: member.subJobId === null ? null : scope.refs.job.get(member.subJobId) ?? null,
    equipment: Object.fromEntries(SUGGESTED_BUILD_SLOTS.map((slot, index) => {
      const id = member.equipmentIds[index]
      const ref = id === null || id === undefined ? undefined : scope.refs.equipment.get(id)
      return [slot.id, ref ? { ref } : null]
    })),
    passives: member.passiveIds.flatMap(id => {
      const ref = scope.refs.passive.get(id)
      return ref ? [{ ref }] : []
    }),
    contextAssumptions: [],
  }
}

function resolvedId(localData: LocalData, scope: SaveEditorDefinitionScope, ref: EntityRef | null | undefined, family: 'job' | 'equipment' | 'passive') {
  return saveEditorDefinitionId(scope, ref ? definitionLineageRootRef(localData, ref) : ref, family)
}

function loadoutCommand(localData: LocalData, scope: SaveEditorDefinitionScope, memberIndex: number, content: BuildRevisionContent): Extract<SaveEditCommand, { type: 'loadout' }> | undefined {
  const jobId = resolvedId(localData, scope, content.primaryClass, 'job')
  const subJobId = resolvedId(localData, scope, content.secondaryClass, 'job')
  if (jobId === undefined || jobId === null || subJobId === undefined) return undefined
  const equipmentIds: (number | null)[] = []
  for (const slot of SUGGESTED_BUILD_SLOTS) {
    const id = resolvedId(localData, scope, content.equipment[slot.id]?.ref ?? null, 'equipment')
    if (id === undefined) return undefined
    equipmentIds.push(id)
  }
  const passiveIds: number[] = []
  for (const selection of content.passives) {
    const id = resolvedId(localData, scope, selection.ref, 'passive')
    if (id === undefined || id === null) return undefined
    passiveIds.push(id)
  }
  return { type: 'loadout', index: memberIndex, jobId, subJobId, equipmentIds, passiveIds }
}

function SaveLoadoutEditor({ storage, save, summary, memberIndex, modSources, scope, localData, locked, onDraftChange, onReview }: {
  readonly storage: SaveWorkspace
  readonly save: CrystalSave
  readonly summary: SaveEditorSummary
  readonly memberIndex: number
  readonly modSources: readonly SaveEditorModSource[]
  readonly scope: SaveEditorDefinitionScope
  readonly localData: LocalData
  readonly locked: boolean
  readonly onDraftChange: (dirty: boolean) => void
  readonly onReview: (title: string, command: Extract<SaveEditCommand, { type: 'loadout' }>, trigger: HTMLButtonElement) => void
}) {
  const member = summary.members[memberIndex]!
  const initial = useMemo(() => buildContent(member, scope), [member, scope])
  const childOwner = useRef<ReturnType<SaveWorkspace['controller']['attachChild']> | undefined>(undefined)
  const childMounted = useRef(false)
  // useMemo factories may run twice in StrictMode; only the mounted child owns this controller incarnation
  const child = childOwner.current ?? (childOwner.current = storage.controller.attachChild(storage.view, memberIndex))
  const context = useMemo(() => saveDefinitionContext(save, modSources, summary.mode), [save, modSources, summary.mode])
  if (summary.editable) storage.controller.initializeLoadout(storage.view, child, initial, context)
  const [draft, setDraftState] = useState(() => storage.controller.snapshot().input?.loadout ?? initial)
  const changed = () => { storage.controller.assertChild(storage.view, child); setDraftState(storage.controller.snapshot().input!.loadout!); onDraftChange(true) }
  const contextAvailable = jsonEqual(storage.controller.snapshot().input?.context, context)
  const [picker, setPicker] = useState<PickerState | undefined>(() => { const value = storage.controller.snapshot().input?.presentation.picker; return jsonRecord(value) && typeof value.fieldKey === 'string' && typeof value.query === 'string' && typeof value.resultLimit === 'number' ? { fieldKey: value.fieldKey, query: value.query, resultLimit: value.resultLimit } : undefined })
  const [selectedKey, setSelectedKey] = useState(storage.controller.snapshot().input?.presentation.selected ?? null)
  const [inspectClassPermissions, setInspectClassPermissions] = useState(storage.controller.snapshot().input?.presentation.inspectClassPermissions !== false)
  const [buildRevisionId, setBuildRevisionId] = useState(storage.controller.snapshot().input?.selectedBuild?.revision.id ?? '')
  const [issue, setIssue] = useState<string>()
  const { options } = useDefinitionLibrary()
  const selected = contextAvailable && jsonRecord(selectedKey) ? options.find(option => option.key === selectedKey.key) : undefined
  const isChildCurrent = () => { try { storage.controller.assertChild(storage.view, child); return storage.isCurrent() } catch { return false } }
  const present = (key: string, value: JsonValue) => { if (!isChildCurrent()) return false; storage.controller.present(storage.view, key, value); onDraftChange(true); return true }
  const changePicker = (value: PickerState | undefined) => { if (present('picker', value ? { ...value } : null)) setPicker(value) }
  const definitionIndex = useMemo(() => new Map(options.map(option => [option.key, option.record])), [options])
  const equipmentPermissions = useMemo(() => buildEquipmentPermissions(draft, ref => definitionIndex.get(entityDefinitionKey(ref))), [definitionIndex, draft])
  const dirty = !jsonEqual(draft, initial)

  useEffect(() => { onDraftChange(dirty) }, [dirty, onDraftChange])
  useEffect(() => {
    childMounted.current = true
    return () => { childMounted.current = false; queueMicrotask(() => { if (!childMounted.current) storage.controller.releaseChild(storage.view, child) }) }
  }, [storage, child])
  const gameSetup = useMemo(() => ({
    id: 'save-editor-setup', gameSetupId: 'save-editor', revision: 1, label: 'Open save', platform: { state: 'known', value: 'Windows' }, gameVersion: { state: 'known', value: '1.6.9' }, mode: { state: 'known', value: summary.mode.name }, mods: { state: 'known', value: save.header.mods.map(mod => mod.title) }, disabledMods: { state: 'known', value: [] }, ppLimit: { state: 'known', value: 10 }, ppCostsNonNegative: { state: 'known', value: true }, slots: SUGGESTED_BUILD_SLOTS, catalogLock: Object.fromEntries(scope.catalogs.map(catalog => [catalog.id, catalog.revisionId])), modComposition: { version: 2, baseline: { catalogId: scope.catalogs[0]!.id, catalogRevisionId: scope.catalogs[0]!.revisionId }, layers: scope.catalogs.slice(1).map(catalog => ({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true })), links: [] }, createdAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as GameSetupRevision, [save.header.mods, scope.catalogs, summary.mode.name])
  const compatibleBuilds = useMemo(() => Object.values(localData.builds).flatMap(build => {
    if (build.archived || !build.latestRevisionId) return []
    const revision = localData.buildRevisions[build.latestRevisionId]
    if (!revision) return []
    const command = loadoutCommand(localData, scope, memberIndex, revision.content)
    if (!command) return []
    try { editSave(save, SAVE_EDITOR_CATALOG, command, new Date(0), modSources) } catch { return [] }
    return [{ id: revision.id, title: build.title, content: revision.content, revision, command, context: saveSelectionContext(localData, revision.content) }]
  }).sort((left, right) => left.title.localeCompare(right.title)), [localData, memberIndex, modSources, save, scope])
  storage.controller.bindChoices(storage.view, child, context, options.flatMap(option => { const binding = scope.bindings.get(option.key); return binding && ['job', 'equipment', 'passive'].includes(binding.family) ? [{ ref: option.ref, family: binding.family as 'job' | 'equipment' | 'passive' }] : [] }), compatibleBuilds.map(value => ({ title: value.title, revision: value.revision, context: value.context })))
  const recordedBuild = storage.controller.snapshot().input?.selectedBuild
  const exactBuild = recordedBuild && localData.buildRevisions[recordedBuild.revision.id]
  const buildAvailable = !!recordedBuild && !!exactBuild && jsonEqual(exactBuild, recordedBuild.revision) && jsonEqual(saveSelectionContext(localData, exactBuild.content), recordedBuild.context)
  const restoredCommand = buildAvailable && contextAvailable ? loadoutCommand(localData, scope, memberIndex, recordedBuild.revision.content) : undefined
  const chosenBuild = recordedBuild && restoredCommand ? { id: recordedBuild.revision.id, title: recordedBuild.title, command: restoredCommand } : undefined
  const openPicker = (fieldKey: string) => { storage.controller.assertChild(storage.view, child); const value = { fieldKey, query: '', resultLimit: BUILD_DEFINITION_PAGE_SIZE }; changePicker(value) }
  const field = (fieldKey: string, label: string, kinds: readonly ('class' | 'item' | 'passive' | 'innate')[], value: EntityRef | null, onChange: (ref: EntityRef | null) => void, equipmentIndex?: number, passiveIndex?: number) => <BuildDefinitionField
    allowEmpty={fieldKey !== 'primary-class'} allowedKinds={kinds} buildContent={draft} equipmentPermissions={equipmentIndex === undefined ? undefined : equipmentPermissions} equipmentSlot={equipmentIndex === undefined ? undefined : SUGGESTED_BUILD_SLOTS[equipmentIndex]} equipmentSlots={SUGGESTED_BUILD_SLOTS} gameSetup={gameSetup} label={label}
    onChange={ref => { if (!isChildCurrent()) return; onChange(ref); setBuildRevisionId(''); setIssue(undefined) }} onClose={() => changePicker(undefined)} onDismiss={() => changePicker(undefined)} onInspect={option => { if (!isChildCurrent()) return; const value = option ? { key: option.key, name: option.name } : null; present('selected', value); present('inspectClassPermissions', fieldKey !== 'secondary-class'); setSelectedKey(value); setInspectClassPermissions(fieldKey !== 'secondary-class') }} onOpen={() => openPicker(fieldKey)} onQueryChange={query => { if (picker?.fieldKey === fieldKey) changePicker({ ...picker, query }) }} onResultLimitChange={resultLimit => { if (picker?.fieldKey === fieldKey) changePicker({ ...picker, resultLimit }) }} open={picker?.fieldKey === fieldKey} passiveIndex={passiveIndex} query={picker?.fieldKey === fieldKey ? picker.query : ''} resultLimit={picker?.fieldKey === fieldKey ? picker.resultLimit : BUILD_DEFINITION_PAGE_SIZE} value={value}/>
  const command = useMemo(() => loadoutCommand(localData, scope, memberIndex, draft), [localData, scope, memberIndex, draft])
  const additions = useMemo(() => {
    const candidateCommand = chosenBuild?.command ?? command
    if (!candidateCommand || !dirty && !chosenBuild) return []
    try { return previewSaveAdditions(save, editSave(save, SAVE_EDITOR_CATALOG, candidateCommand, new Date(0), modSources), SAVE_EDITOR_CATALOG, modSources) } catch { return [] }
  }, [chosenBuild, command, dirty, modSources, save])
  const reviewDraft = (trigger: HTMLButtonElement) => {
    if (!contextAvailable || !command) { setIssue('Every selection needs a matching ID in this save before review.'); return }
    try {
      editSave(save, SAVE_EDITOR_CATALOG, command, new Date(0), modSources)
      onReview(`${member.name}'s loadout`, command, trigger)
    } catch (reason) { setIssue(reason instanceof Error ? reason.message : String(reason)) }
  }
  const primaryClassField = field('primary-class', 'Class', ['class'], draft.primaryClass, ref => { storage.controller.editClass(storage.view, child, 'primaryClass', ref); changed() })
  const subCommandField = field('secondary-class', 'Sub-command', ['class'], draft.secondaryClass, ref => { storage.controller.editClass(storage.view, child, 'secondaryClass', ref); changed() })
  const equipmentFields = SUGGESTED_BUILD_SLOTS.map((slot, index) => <div key={slot.id}>{field(`equipment:${slot.id}`, slot.label, ['item'], draft.equipment[slot.id]?.ref ?? null, ref => { storage.controller.editEquipment(storage.view, child, slot.id, ref); changed() }, index)}</div>)
  const passiveFields = [...draft.passives, undefined].map((selection, index) => <div key={`${index}:${selection ? entityDefinitionKey(selection.ref) : 'add'}`}>{field(`passive:${index}`, `Equipped passive ${index + 1}`, ['passive', 'innate'], selection?.ref ?? null, ref => { storage.controller.editPassive(storage.view, child, index, ref); changed() }, undefined, index)}</div>)
  return <div className="save-party__editor">
    <div className="save-party__build-import"><Field label="Load a compatible Build" hint={compatibleBuilds.length ? 'Adds any missing class unlocks, passives, and gear. Game and mod definitions must match this save.' : 'No saved Builds match this save\'s game and mod definitions and loadout rules.'}><select disabled={locked || !contextAvailable || !compatibleBuilds.length} onChange={event => { storage.controller.assertChild(storage.view, child); const choice = compatibleBuilds.find(build => build.id === event.target.value); storage.controller.selectBuild(storage.view, child, choice ? { title: choice.title, revision: choice.revision, context: choice.context } : undefined); setBuildRevisionId(event.target.value); setIssue(undefined); onDraftChange(true) }} value={buildRevisionId}><option value="">Choose a Build</option>{recordedBuild && !compatibleBuilds.some(value => value.id === recordedBuild.revision.id) && <option value={recordedBuild.revision.id}>{recordedBuild.title} (recorded revision)</option>}{compatibleBuilds.map(build => <option key={build.id} value={build.id}>{build.title}</option>)}</select></Field><Button disabled={locked || !chosenBuild || !contextAvailable} onClick={event => chosenBuild && onReview(`Load ${chosenBuild.title} for ${member.name}`, chosenBuild.command, event.currentTarget)} tone="secondary">Review Build</Button></div>
    {additions.length > 0 && <div aria-label="New loadout additions" className="save-party__additions"><Badge tone="info">New</Badge><ul>{additions.map(addition => <li key={addition}>{addition}</li>)}</ul></div>}
    {(!contextAvailable || recordedBuild && !buildAvailable) && <InlineNotice title="Recorded context unavailable" tone="warning">The exact recorded definitions or Build revision are unavailable. Your recorded choices are preserved. Restore that context or reset unfinished input before choosing a replacement.</InlineNotice>}
    {issue && <InlineNotice title="Loadout needs attention" tone="warning">{issue}</InlineNotice>}
    <fieldset disabled={locked || !contextAvailable}><LoadoutSheet catalogs={scope.catalogs} primaryClassField={primaryClassField} subCommandField={subCommandField} content={draft} equipmentFields={equipmentFields} localData={localData} onViewChange={() => undefined} passiveFields={passiveFields} selection={selected} showChecks={false} showClassPermissions={inspectClassPermissions} showStats={false} slots={SUGGESTED_BUILD_SLOTS} view="loadout" viewLabel="Save loadout view"/></fieldset>
    <div className="save-party__loadout-actions"><Button disabled={locked || !dirty || !command || !contextAvailable} onClick={event => reviewDraft(event.currentTarget)}>Review loadout changes</Button><Button disabled={locked || !contextAvailable || !dirty} onClick={() => { if (storage.pending()) return; storage.controller.resetLoadout(storage.view, child, initial, context); changed(); setBuildRevisionId(''); setIssue(undefined); }} tone="quiet">Discard loadout changes</Button><small>Reviewing does not change the draft until you confirm it.</small></div>
  </div>
}

export function SavePartyEditor({ storage, save, summary, modSources, localData, locked, applyLocked, pending, onFieldChange, onApplyMember, onDraftChange, onError, onReview }: {
  readonly storage: SaveWorkspace
  readonly save: CrystalSave
  readonly summary: SaveEditorSummary
  readonly modSources: readonly SaveEditorModSource[]
  readonly localData: LocalData
  readonly locked: boolean
  readonly applyLocked: boolean
  readonly pending: Readonly<Record<string, string>>
  readonly onFieldChange: (key: string, value: string, original: string) => void
  readonly onApplyMember: (command: Extract<SaveEditCommand, { type: 'member' }>, fields: readonly string[]) => void
  readonly onDraftChange: (dirty: boolean) => void
  readonly onError: (message: string) => void
  readonly onReview: (title: string, command: Extract<SaveEditCommand, { type: 'loadout' }>, trigger: HTMLButtonElement) => void
}) {
  const [memberIndex, setMemberIndex] = useState(storage.controller.snapshot().input?.member ?? 0)
  const [loadoutDirty, setLoadoutDirty] = useState(false)
  const member = summary.members[memberIndex] ?? summary.members[0]!
  const scope = useMemo(() => saveEditorDefinitionScope(save, DEFAULT_CATALOG, modSources, summary.mode), [modSources, save, summary.mode])
  const filterOption = useCallback((option: DefinitionOption) => {
    const binding = scope.bindings.get(option.key)
    // This scope contains exact save definitions; progression and stock are editable prerequisites
    return binding?.family === 'job' || binding?.family === 'passive' || binding?.family === 'equipment'
  }, [scope.bindings])
  const chooseMember = (index: number) => {
    if (locked || storage.pending()) return
    if (loadoutDirty && !window.confirm('Discard the unreviewed loadout changes and switch party members?')) return
    storage.controller.selectMember(storage.view, index)
    setLoadoutDirty(false)
    setMemberIndex(index)
    onDraftChange(true)
  }
  const handleLoadoutDraftChange = useCallback((dirty: boolean) => { setLoadoutDirty(dirty); onDraftChange(dirty) }, [onDraftChange])
  const prefix = `member.${member.index}.`
  const keys = ['name', 'level'].map(key => `${prefix}${key}`)
  const memberPending = keys.some(key => pending[key] !== undefined)
  return <section className="save-editor__panel save-party" aria-label="Party editor"><div className="save-party__heading"><div><h2>Party & loadouts</h2><p>Choose classes, equipment, and passives for this member. Missing unlocks and gear are added with the loadout.</p></div><span>{memberIndex + 1} of {summary.members.length}</span></div>
    <div className="save-party__tabs" role="tablist" aria-label="Party members">{summary.members.map(candidate => <button disabled={locked || storage.pending()} aria-selected={candidate.index === memberIndex} className="save-party__tab" key={candidate.index} onClick={() => chooseMember(candidate.index)} role="tab" type="button"><strong>{candidate.name}</strong><small>Lv {candidate.level}</small></button>)}</div>
    <form className="save-party__identity" onSubmit={event => {
      event.preventDefault()
      const levelValue = pending[`${prefix}level`]
      const level = levelValue === undefined ? undefined : Number(levelValue)
      if (levelValue !== undefined && (!/^\d+$/.test(levelValue.trim()) || !Number.isSafeInteger(level) || level === undefined || level < 1)) { onError('Level must be a whole number of 1 or more.'); return }
      onApplyMember({ type: 'member', index: member.index, ...(pending[`${prefix}name`] !== undefined ? { name: pending[`${prefix}name`] } : {}), ...(level !== undefined ? { level } : {}) }, keys)
    }}><Field label="Name"><input aria-label={`Member ${member.index + 1} name`} disabled={locked} value={pending[`${prefix}name`] ?? member.name} onChange={event => onFieldChange(`${prefix}name`, event.target.value, member.name)}/></Field><Field label="Level"><input aria-label={`Member ${member.index + 1} level`} aria-describedby="save-party-level-hint" disabled={locked} inputMode="numeric" value={pending[`${prefix}level`] ?? String(member.level)} onChange={event => onFieldChange(`${prefix}level`, event.target.value, String(member.level))}/></Field><Button disabled={applyLocked || !memberPending} tone="secondary" type="submit">Apply name & level</Button><p className="field__hint save-party__level-hint" id="save-party-level-hint">Level: {saveEditorLevelHint(summary)}</p><p>{member.unlockedJobs} classes unlocked · {member.masteredJobs} mastered · {member.learnedPassives} passives learned</p></form>
    <ScopedDefinitionProvider catalogs={scope.catalogs} filterOption={filterOption}><SaveLoadoutEditor storage={storage} key={`${member.index}:${member.jobId}:${member.subJobId}:${member.equipmentIds.join(',')}:${member.passiveIds.join(',')}`} localData={localData} locked={locked} memberIndex={member.index} modSources={modSources} onDraftChange={handleLoadoutDraftChange} onReview={onReview} save={save} scope={scope} summary={summary}/></ScopedDefinitionProvider>
  </section>
}
