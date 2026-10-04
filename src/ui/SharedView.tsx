import { useEffect, useMemo, useState } from 'react'
import { logicalEntityKey, validateBuildContent } from '../domain'
import { equipmentFacts, equipmentRole } from '../domain/mechanics-facts'
import type { BuildId, BuildRevision, CatalogSnapshot, LocalData, TeamId, EntityRef, Knowledge } from '../domain'
import { decodeSharePayload, sharePreviewData, type SharePayload } from '../interchange/share'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { prepareModCatalogs } from '../persistence'
import { BuildLoadoutSummary, PassiveCapacityMeter } from './BuildLoadoutSummary'
import { LoadoutSheet, type LoadoutView } from './LoadoutSheet'
import { ReadOnlyDefinitionField } from './ReadOnlyDefinitionField'
import { buildDefinitionOptions, findDefinitionOption, type DefinitionOption } from './definitions'
import { CalculationInputs } from './CalculationInputs'
import { resolveGameRules } from '../domain/game-rules'
import { KnowledgeValue } from './KnowledgeValue'
import { BuildValidity } from './BuildValidity'
import { Button, InlineNotice, ScreenHeader } from './components'
import { formatAppError, resolveEntity } from './model'
import { useNavigation } from './navigation'

interface SharedPreview { readonly payload: SharePayload; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[] }

function SharedBuild({ revision, preview }: { readonly revision: BuildRevision; readonly preview: SharedPreview }) {
  const { localData, catalogs } = preview
  const setup = localData.gameSetups[revision.gameSetupRevisionId]!
  const report = validateBuildContent(revision.content, setup, setup.slots, ref => resolveEntity(localData, catalogs, ref), ref => logicalEntityKey(localData, ref))
  const mainHandSlot = setup.slots.find(slot => equipmentRole(slot) === 'mainHand')
  const mainHand = mainHandSlot && revision.content.equipment[mainHandSlot.id]
  const mainHandDefinition = mainHand ? resolveEntity(localData, catalogs, mainHand.ref) : undefined
  const twoHanded = mainHandDefinition && equipmentFacts(mainHandDefinition).twoHanded === true
  const content = revision.content
  const rules = useMemo(() => resolveGameRules(setup, catalogs), [setup, catalogs])
  const slots = [...setup.slots].sort((left, right) => left.order - right.order)
  const retained = Object.keys(content.equipment).filter(id => !slots.some(slot => slot.id === id))
  const options = useMemo(() => buildDefinitionOptions({ ...localData, planningGameSetupRevisionId: setup.id }, catalogs), [localData, catalogs, setup.id])
  const [view, setView] = useState<LoadoutView>('loadout')
  const [inspection, setInspection] = useState<{ option?: DefinitionOption; showClassPermissions: boolean }>()
  const field = (label: string, ref: EntityRef | null | undefined, empty = 'Empty') => <ReadOnlyDefinitionField catalogs={catalogs} empty={empty} label={label} localData={localData} onInspect={option => setInspection({ option, showClassPermissions: label !== 'Sub-command' })} option={findDefinitionOption(options, ref)}/>
  const equipmentField = (id: string, label: string) => {
    const selection = content.equipment[id]
    const offHand = slots.find(slot => slot.id === id && equipmentRole(slot) === 'offHand')
    const sameCopy = Boolean(selection?.allocationId && selection.allocationId === mainHand?.allocationId)
    const occupied = twoHanded && offHand && (!selection || sameCopy)
    return <div className="slot-entry" key={id}>{field(label, occupied ? undefined : selection?.ref, occupied ? `Occupied by ${mainHandDefinition.name}` : selection?.observedName ?? 'Empty')}{selection?.allocationId && <p className="field__hint">Same physical copy: {[...slots.map(slot => ({ id: slot.id as string, label: slot.label })), ...retained.map(id => ({ id, label: id }))].filter(slot => slot.id !== id && content.equipment[slot.id]?.allocationId === selection.allocationId).map(slot => slot.label).join(', ') || 'No other selected slot'}</p>}</div>
  }
  const setupFacts: readonly { label: string; value: Knowledge<unknown> }[] = [
    { label: 'Platform', value: setup.platform }, { label: 'Game version', value: setup.gameVersion }, { label: 'Mode', value: setup.mode },
    { label: 'Enabled mods', value: setup.mods }, { label: 'Disabled mods', value: setup.disabledMods ?? { state: 'unknown' } },
    { label: 'Passive PP limit', value: setup.ppLimit ?? { state: 'unknown' } }, { label: 'Nonnegative PP costs', value: setup.ppCostsNonNegative },
  ]
  return <div className="stack build-sheet" data-validity={report.status}>
    <details><summary>Game Setup: {setup.label}</summary><dl className="definition-list">{setupFacts.map(({ label, value }) => <div className="definition-row" key={label}><dt>{label}</dt><dd><KnowledgeValue showSources value={value}/></dd></div>)}</dl></details>
    <BuildValidity hasPrimaryClass={Boolean(content.primaryClass)} report={report}/>
    <LoadoutSheet gameSetup={setup} catalogs={catalogs} content={content} localData={localData} slots={slots} view={view} onViewChange={setView} viewLabel="Shared build view" selection={inspection ? inspection.option : findDefinitionOption(options, content.primaryClass)} showClassPermissions={inspection?.showClassPermissions}
      classFields={<>{field('Class', content.primaryClass, 'No class selected')}{field('Sub-command', content.secondaryClass, 'No sub-command')}</>}
      equipmentFields={<>{slots.map(slot => equipmentField(slot.id, slot.label))}{retained.length > 0 && <div><p className="field__hint">Selections outside the pinned slot layout retain their stored slot IDs.</p>{retained.map(id => equipmentField(id, id))}</div>}</>}
      passiveTools={<PassiveCapacityMeter pp={report.pp}/>}
      passiveFields={content.passives.length ? content.passives.map((selection, index) => <div key={index}>{field(`Equipped passive ${index + 1}`, selection.ref, selection.observedName)}</div>) : <p>No passives equipped.</p>}
      notes={<>{content.calculation && <details><summary>Calculation inputs</summary><CalculationInputs catalogs={catalogs} localData={localData} plan={content.calculation} genders={rules.genders}/></details>}{(revision.note || content.rotationNotes || content.contextAssumptions.length > 0) && <details><summary>Build notes and assumptions</summary><div className="share-notes">{revision.note && <p>{revision.note}</p>}{content.rotationNotes && <p>{content.rotationNotes}</p>}{content.contextAssumptions.map((note, index) => <p key={index}>{note}</p>)}</div></details>}</>}
    />
  </div>
}

export function SharedView({ encoded, catalogs, onSave }: { readonly encoded: string; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly onSave: (payload: SharePayload) => Promise<{ readonly buildId?: BuildId; readonly teamId?: TeamId }> }) {
  const navigation = useNavigation()
  const [preview, setPreview] = useState<SharedPreview>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  useEffect(() => {
    let live = true
    setPreview(undefined)
    setError(undefined)
    void (async () => {
      const payload = decodeSharePayload(encoded)
      const data = sharePreviewData(payload)
      const prepared = await prepareModCatalogs(data, catalogs)
      validateNativeLocalDataGraph(data, prepared)
      if (live) setPreview({ payload, localData: data, catalogs: prepared })
    })().catch(reason => { if (live) setError(formatAppError(reason, 'The shared snapshot could not be opened.')) })
    return () => { live = false }
  }, [catalogs, encoded])
  const save = async () => {
    if (!preview) return
    setBusy(true)
    setSaveError(undefined)
    try {
      const result = await onSave(preview.payload)
      const page = result.teamId ? { page: 'teams' as const, view: 'team' as const, teamId: result.teamId } : { page: 'builds' as const, view: 'build' as const, buildId: result.buildId! }
      navigation.navigate({ page, overlays: [], query: {} })
    } catch (reason) { setSaveError(formatAppError(reason, 'The shared copy could not be saved.')) }
    finally { setBusy(false) }
  }
  if (error) return <><ScreenHeader title="Shared snapshot unavailable" description="The shared snapshot could not be opened." actions={<Button onClick={() => navigation.navigate({ page: { page: 'builds', view: 'library' }, overlays: [], query: {} })}>Open build library</Button>}/><section className="panel"><div className="panel__body stack"><InlineNotice title="Link could not be opened" tone="danger">{error} Missing catalog revisions are not replaced by another version.</InlineNotice></div></section></>
  if (!preview) return <p role="status">Opening shared snapshot...</p>
  const { payload } = preview
  const slots = payload.kind === 'team' ? payload.slots! : [Object.values(payload.records.buildRevisions)[0]!.id]
  return <div className="stack shared-preview">
    <ScreenHeader description="A read-only snapshot from a share link. Save a copy to edit it in this browser." eyebrow={payload.kind === 'team' ? 'Shared team' : 'Shared build'} title={payload.title} actions={<Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save a copy'}</Button>}/>
    <p>Build rules use the pinned Game Setup. Character readiness and available stock need your own Playthrough records.</p>
    {saveError && <InlineNotice title="Copy not saved" tone="danger">{saveError} Your existing records were preserved.</InlineNotice>}
    <div className={payload.kind === 'team' ? 'share-team-grid' : 'share-build-grid'}>{slots.map((id, index) => {
      const revision = id ? payload.records.buildRevisions[id] : undefined
      const build = revision ? payload.records.builds[revision.buildId] : undefined
      return <section aria-label={payload.kind === 'team' ? `Shared team slot ${index + 1}` : 'Shared build loadout'} className="panel" key={index}><header className="panel__header"><h2>{payload.kind === 'team' ? `${index + 1}. ` : ''}{build?.title ?? 'No build assigned'}</h2></header><div className="panel__body">{revision ? <SharedBuild preview={preview} revision={revision}/> : <BuildLoadoutSummary catalogs={preview.catalogs} gameSetup={preview.localData.gameSetups[payload.teamGameSetupRevisionId!]} localData={preview.localData}/>}</div></section>
    })}</div>

  </div>
}
