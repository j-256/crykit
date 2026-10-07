import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { entityDefinitionKey } from '../domain/core'
import { buildEquipmentPermissions } from '../domain/build-mechanics'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { definitionLineageRootRef } from '../domain/definitions'
import { editSave, type SaveEditCommand, type SaveEditorSummary } from '../domain/save-editor'
import { saveEditorDefinitionId, saveEditorDefinitionScope, type SaveEditorDefinitionScope, type SaveEditorModSource } from '../domain/save-editor-mods'
import type { BuildRevisionContent, EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import type { CrystalSave } from '../interchange/crystal-save'
import { BuildDefinitionField, BUILD_DEFINITION_PAGE_SIZE } from './BuildDefinitionField'
import { LoadoutSheet } from './LoadoutSheet'
import { Button, Field, InlineNotice } from './components'
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

function SaveLoadoutEditor({ save, summary, memberIndex, modSources, scope, localData, locked, onDraftChange, onReview }: {
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
  const [draft, setDraft] = useState(initial)
  const [picker, setPicker] = useState<PickerState>()
  const [selected, setSelected] = useState<DefinitionOption>()
  const [buildRevisionId, setBuildRevisionId] = useState('')
  const [issue, setIssue] = useState<string>()
  const { options } = useDefinitionLibrary()
  const definitionIndex = useMemo(() => new Map(options.map(option => [option.key, option.record])), [options])
  const equipmentPermissions = useMemo(() => buildEquipmentPermissions(draft, ref => definitionIndex.get(entityDefinitionKey(ref))), [definitionIndex, draft])
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useEffect(() => { setDraft(initial); setPicker(undefined); setSelected(undefined); setBuildRevisionId(''); setIssue(undefined) }, [initial])
  useEffect(() => { onDraftChange(dirty) }, [dirty, onDraftChange])
  useEffect(() => () => onDraftChange(false), [onDraftChange])
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
    return [{ id: revision.id, title: build.title, content: revision.content, command }]
  }).sort((left, right) => left.title.localeCompare(right.title)), [localData, memberIndex, modSources, save, scope])
  const chosenBuild = compatibleBuilds.find(build => build.id === buildRevisionId)
  const openPicker = (fieldKey: string) => setPicker({ fieldKey, query: '', resultLimit: BUILD_DEFINITION_PAGE_SIZE })
  const field = (fieldKey: string, label: string, kinds: readonly ('class' | 'item' | 'passive' | 'innate')[], value: EntityRef | null, onChange: (ref: EntityRef | null) => void, equipmentIndex?: number, passiveIndex?: number) => <BuildDefinitionField
    allowEmpty={fieldKey !== 'primary-class'} allowedKinds={kinds} buildContent={draft} equipmentPermissions={equipmentIndex === undefined ? undefined : equipmentPermissions} equipmentSlot={equipmentIndex === undefined ? undefined : SUGGESTED_BUILD_SLOTS[equipmentIndex]} equipmentSlots={SUGGESTED_BUILD_SLOTS} gameSetup={gameSetup} includeInnates label={label}
    onChange={ref => { onChange(ref); setIssue(undefined) }} onClose={() => setPicker(undefined)} onDismiss={() => setPicker(undefined)} onInspect={setSelected} onOpen={() => openPicker(fieldKey)} onQueryChange={query => setPicker(current => current?.fieldKey === fieldKey ? { ...current, query } : current)} onResultLimitChange={resultLimit => setPicker(current => current?.fieldKey === fieldKey ? { ...current, resultLimit } : current)} open={picker?.fieldKey === fieldKey} passiveIndex={passiveIndex} query={picker?.fieldKey === fieldKey ? picker.query : ''} resultLimit={picker?.fieldKey === fieldKey ? picker.resultLimit : BUILD_DEFINITION_PAGE_SIZE} value={value}/>
  const command = loadoutCommand(localData, scope, memberIndex, draft)
  const reviewDraft = (trigger: HTMLButtonElement) => {
    if (!command) { setIssue('Every selection must resolve to an ID in this save before it can be reviewed.'); return }
    try {
      editSave(save, SAVE_EDITOR_CATALOG, command, new Date(0), modSources)
      onReview(`${member.name}'s loadout`, command, trigger)
    } catch (reason) { setIssue(reason instanceof Error ? reason.message : String(reason)) }
  }
  const classFields = <>
    {field('primary-class', 'Class', ['class'], draft.primaryClass, ref => setDraft(current => ({ ...current, primaryClass: ref })))}
    {field('secondary-class', 'Sub-command', ['class'], draft.secondaryClass, ref => setDraft(current => ({ ...current, secondaryClass: ref })))}
  </>
  const equipmentFields = SUGGESTED_BUILD_SLOTS.map((slot, index) => <div key={slot.id}>{field(`equipment:${slot.id}`, slot.label, ['item'], draft.equipment[slot.id]?.ref ?? null, ref => setDraft(current => ({ ...current, equipment: { ...current.equipment, [slot.id]: ref ? { ref } : null } })), index)}</div>)
  const passiveFields = [...draft.passives, undefined].map((selection, index) => <div key={`${index}:${selection ? entityDefinitionKey(selection.ref) : 'add'}`}>{field(`passive:${index}`, `Equipped passive ${index + 1}`, ['passive', 'innate'], selection?.ref ?? null, ref => setDraft(current => {
    const passives = [...current.passives]
    if (ref) passives[index] = { ref }
    else if (index < passives.length) passives.splice(index, 1)
    return { ...current, passives }
  }), undefined, index)}</div>)
  return <div className="save-party__editor">
    <div className="save-party__build-import"><Field label="Load a compatible Build" hint={compatibleBuilds.length ? 'Only Builds whose definitions, unlocks, PP, equipment slots, and carried stock fit this member are listed.' : 'No saved Builds are fully compatible with this member and save.'}><select disabled={locked || !compatibleBuilds.length} onChange={event => setBuildRevisionId(event.target.value)} value={buildRevisionId}><option value="">Choose a Build</option>{compatibleBuilds.map(build => <option key={build.id} value={build.id}>{build.title}</option>)}</select></Field><Button disabled={locked || !chosenBuild} onClick={event => chosenBuild && onReview(`Load ${chosenBuild.title} for ${member.name}`, chosenBuild.command, event.currentTarget)} tone="secondary">Review Build</Button></div>
    {issue && <InlineNotice title="Loadout needs attention" tone="warning">{issue}</InlineNotice>}
    <LoadoutSheet catalogs={scope.catalogs} classFields={classFields} content={draft} equipmentFields={equipmentFields} localData={localData} onViewChange={() => undefined} passiveFields={passiveFields} selection={selected} showChecks={false} showClassPermissions showStats={false} slots={SUGGESTED_BUILD_SLOTS} view="loadout" viewLabel="Save loadout view"/>
    <div className="save-party__loadout-actions"><Button disabled={locked || !dirty || !command} onClick={event => reviewDraft(event.currentTarget)}>Review loadout changes</Button><Button disabled={locked || !dirty} onClick={() => { setDraft(initial); setIssue(undefined) }} tone="quiet">Discard loadout changes</Button><small>Reviewing does not change the draft until you confirm it.</small></div>
  </div>
}

export function SavePartyEditor({ save, summary, modSources, localData, locked, pending, onFieldChange, onApplyMember, onDraftChange, onError, onReview }: {
  readonly save: CrystalSave
  readonly summary: SaveEditorSummary
  readonly modSources: readonly SaveEditorModSource[]
  readonly localData: LocalData
  readonly locked: boolean
  readonly pending: Readonly<Record<string, string>>
  readonly onFieldChange: (key: string, value: string, original: string) => void
  readonly onApplyMember: (command: Extract<SaveEditCommand, { type: 'member' }>, fields: readonly string[]) => void
  readonly onDraftChange: (dirty: boolean) => void
  readonly onError: (message: string) => void
  readonly onReview: (title: string, command: Extract<SaveEditCommand, { type: 'loadout' }>, trigger: HTMLButtonElement) => void
}) {
  const [memberIndex, setMemberIndex] = useState(0)
  const [loadoutDirty, setLoadoutDirty] = useState(false)
  const member = summary.members[memberIndex] ?? summary.members[0]!
  const scope = useMemo(() => saveEditorDefinitionScope(save, DEFAULT_CATALOG, modSources, summary.mode), [modSources, save, summary.mode])
  const availableEquipment = useMemo(() => new Set(summary.inventory.filter(row => row.kind === 'equipment' && (row.count > 0 || member.equipmentIds.includes(row.id))).map(row => row.id)), [member.equipmentIds, summary.inventory])
  const unlockedJobs = useMemo(() => new Set(member.unlockedJobIds), [member.unlockedJobIds])
  const learnedPassives = useMemo(() => new Set(member.learnedPassiveIds), [member.learnedPassiveIds])
  const filterOption = useCallback((option: DefinitionOption) => {
    const binding = scope.bindings.get(option.key)
    return !binding || binding.family === 'job' ? Boolean(binding && unlockedJobs.has(binding.id)) : binding.family === 'passive' ? learnedPassives.has(binding.id) : binding.family === 'equipment' ? availableEquipment.has(binding.id) : false
  }, [availableEquipment, learnedPassives, scope.bindings, unlockedJobs])
  const chooseMember = (index: number) => {
    if (loadoutDirty && !window.confirm('Discard the unreviewed loadout changes and switch party members?')) return
    setLoadoutDirty(false)
    setMemberIndex(index)
  }
  const handleLoadoutDraftChange = useCallback((dirty: boolean) => { setLoadoutDirty(dirty); onDraftChange(dirty) }, [onDraftChange])
  const prefix = `member.${member.index}.`
  const keys = ['name', 'level'].map(key => `${prefix}${key}`)
  const memberPending = keys.some(key => pending[key] !== undefined)
  return <section className="save-editor__panel save-party" aria-label="Party editor"><div className="save-party__heading"><div><h2>Party & loadouts</h2><p>Use the same searchable class, equipment, and passive fields as the Build editor. Choices are limited to native definitions and exact matched mods in this save, then narrowed to this member's unlocks and available equipment.</p></div><span>{memberIndex + 1} of {summary.members.length}</span></div>
    <div className="save-party__tabs" role="tablist" aria-label="Party members">{summary.members.map(candidate => <button aria-selected={candidate.index === memberIndex} className="save-party__tab" key={candidate.index} onClick={() => chooseMember(candidate.index)} role="tab" type="button"><strong>{candidate.name}</strong><small>Lv {candidate.level}</small></button>)}</div>
    <form className="save-party__identity" onSubmit={event => {
      event.preventDefault()
      const levelValue = pending[`${prefix}level`]
      const level = levelValue === undefined ? undefined : Number(levelValue)
      if (levelValue !== undefined && (!/^\d+$/.test(levelValue.trim()) || !Number.isSafeInteger(level) || level === undefined || level < 1)) { onError('Level must be a whole number of 1 or more.'); return }
      onApplyMember({ type: 'member', index: member.index, ...(pending[`${prefix}name`] !== undefined ? { name: pending[`${prefix}name`] } : {}), ...(level !== undefined ? { level } : {}) }, keys)
    }}><Field label="Name"><input aria-label={`Member ${member.index + 1} name`} disabled={locked} value={pending[`${prefix}name`] ?? member.name} onChange={event => onFieldChange(`${prefix}name`, event.target.value, member.name)}/></Field><Field label="Level"><input aria-label={`Member ${member.index + 1} level`} aria-describedby="save-party-level-hint" disabled={locked} inputMode="numeric" value={pending[`${prefix}level`] ?? String(member.level)} onChange={event => onFieldChange(`${prefix}level`, event.target.value, String(member.level))}/></Field><Button disabled={locked || !memberPending} tone="secondary" type="submit">Apply name & level</Button><p className="field__hint save-party__level-hint" id="save-party-level-hint">Level: {saveEditorLevelHint(summary)}</p><p>{member.unlockedJobs} classes unlocked · {member.masteredJobs} mastered · {member.learnedPassives} passives learned</p></form>
    <ScopedDefinitionProvider catalogs={scope.catalogs} filterOption={filterOption}><SaveLoadoutEditor key={`${member.index}:${member.jobId}:${member.subJobId}:${member.equipmentIds.join(',')}:${member.passiveIds.join(',')}`} localData={localData} locked={locked} memberIndex={member.index} modSources={modSources} onDraftChange={handleLoadoutDraftChange} onReview={onReview} save={save} scope={scope} summary={summary}/></ScopedDefinitionProvider>
  </section>
}
