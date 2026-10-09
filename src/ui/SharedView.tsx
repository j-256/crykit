import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { logicalEntityKey, validateBuildContent } from '../domain'
import { equipmentFacts, equipmentRole } from '../domain/mechanics-facts'
import type { BuildId, BuildRevision, CatalogSnapshot, LocalData, TeamId, EntityRef, Knowledge } from '../domain'
import { decodeSharePayload, sharePreviewData, type SharePayload } from '../interchange/share'
import { prepareSharedModRecovery } from '../interchange/share-mod-recovery'
import { modCatalogTitle } from '../domain/mod-layers'
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
import { buildReferenceName } from '../domain/build-reference-names'
import { entityDefinitionKey } from '../domain/core'
import type { BuildReferenceName } from '../domain/types'
import type { ImportPreview } from '../interchange/types'
import { SharedModSources } from './SharedModSources'
import { LocalArtworkContext } from './GameIcon'
import { Sheet } from './Sheet'
import { focusFieldElement } from './field-focus'
import { BUILD_REVIEW_FIELDS } from './build-validity-guidance'
import { passivePosition } from '../domain/passive-loadout'

const MAX_LOCAL_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_LOCAL_ARTWORK_BYTES = 16 * 1024 * 1024

interface SharedPreview { readonly payload: SharePayload; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[] }

function SharedBuild({ revision, preview, onUploadMod }: { readonly revision: BuildRevision; readonly preview: SharedPreview; readonly onUploadMod: () => void }) {
  const fieldScope = useId()
  const validityRef = useRef<HTMLElement>(null)
  const reviewSolutions = () => { validityRef.current?.scrollIntoView({ block: 'center' }); validityRef.current?.focus({ preventScroll: true }) }
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
  const setupRef = useRef<HTMLDetailsElement>(null)
  const [inspection, setInspection] = useState<{ option?: DefinitionOption; showClassPermissions: boolean }>()
  const field = (label: string, ref: EntityRef | null | undefined, empty = 'Empty', observedName?: string, target = label === 'Class' ? BUILD_REVIEW_FIELDS.primaryClass : label === 'Sub-command' ? BUILD_REVIEW_FIELDS.secondaryClass : label) => <div data-field-key={`${fieldScope}:${target}`} tabIndex={-1}><ReadOnlyDefinitionField catalogs={catalogs} empty={ref ? buildReferenceName(content, ref) ?? observedName ?? 'Unresolved selection' : empty} gameSetup={setup} label={label} value={ref} localData={localData} onInspect={option => setInspection({ option, showClassPermissions: label !== 'Sub-command' })} option={findDefinitionOption(options, ref)}/></div>
  const equipmentField = (id: string, label: string) => {
    const selection = content.equipment[id]
    const offHand = slots.find(slot => slot.id === id && equipmentRole(slot) === 'offHand')
    const sameCopy = Boolean(selection?.allocationId && selection.allocationId === mainHand?.allocationId)
    const occupied = twoHanded && offHand && (!selection || sameCopy)
    return <div className="slot-entry" key={id}>{field(label, occupied ? undefined : selection?.ref, occupied ? `Occupied by ${mainHandDefinition.name}` : 'Empty', selection?.observedName, id)}{selection?.allocationId && <p className="field__hint">Same physical copy: {[...slots.map(slot => ({ id: slot.id as string, label: slot.label })), ...retained.map(id => ({ id, label: id }))].filter(slot => slot.id !== id && content.equipment[slot.id]?.allocationId === selection.allocationId).map(slot => slot.label).join(', ') || 'No other selected slot'}</p>}</div>
  }
  const setupFacts: readonly { label: string; value: Knowledge<unknown> }[] = [
    { label: 'Platform', value: setup.platform }, { label: 'Game version', value: setup.gameVersion }, { label: 'Mode', value: setup.mode },
    { label: 'Enabled mods', value: setup.mods }, { label: 'Disabled mods', value: setup.disabledMods ?? { state: 'unknown' } },
    { label: 'Passive PP limit', value: setup.ppLimit ?? { state: 'unknown' } }, { label: 'Nonnegative PP costs', value: setup.ppCostsNonNegative },
  ]
  return <div className="stack build-sheet" data-validity={report.status}>
    <details ref={setupRef} tabIndex={-1}><summary>Game Setup: {setup.label}</summary><dl className="definition-list">{setupFacts.map(({ label, value }) => <div className="definition-row" key={label}><dt>{label}</dt><dd><KnowledgeValue showSources value={value}/></dd></div>)}</dl></details>
    <BuildValidity panelRef={validityRef} hasPrimaryClass={Boolean(content.primaryClass)} readOnly report={report} fieldLabels={Object.fromEntries([...slots.map(slot => [slot.id, slot.label]), ...content.passives.map((_selection, index) => [passivePosition(index).id, passivePosition(index).label])])} onUploadMod={setup.modSourceReceipts?.length ? onUploadMod : undefined} onReviewField={target => { setView('loadout'); focusFieldElement(`${fieldScope}:${target === BUILD_REVIEW_FIELDS.passives ? passivePosition(0).id : target}`) }} onReviewSetup={() => { if (setupRef.current) { setupRef.current.open = true; setupRef.current.scrollIntoView({ block: 'center' }); setupRef.current.focus() } }}/>
    <LoadoutSheet onReviewIssues={reviewSolutions} gameSetup={setup} catalogs={catalogs} content={content} localData={localData} slots={slots} view={view} onViewChange={setView} viewLabel="Shared build view" selection={inspection ? inspection.option : findDefinitionOption(options, content.primaryClass)} showClassPermissions={inspection?.showClassPermissions}
      primaryClassField={field('Class', content.primaryClass, 'No class selected')} subCommandField={field('Sub-command', content.secondaryClass, 'No sub-command')}
      equipmentFields={<>{slots.map(slot => equipmentField(slot.id, slot.label))}{retained.length > 0 && <div><p className="field__hint">These selections use slots outside this Game Setup.</p>{retained.map(id => equipmentField(id, id))}</div>}</>}
      passiveTools={<PassiveCapacityMeter pp={report.pp}/>}
      passiveFields={content.passives.length ? content.passives.map((selection, index) => <div key={index}>{field(`Equipped passive ${index + 1}`, selection.ref, 'Empty', selection.observedName, passivePosition(index).id)}</div>) : <p>No passives equipped.</p>}
      notes={<>{content.calculation && <details><summary>Calculation inputs</summary><CalculationInputs catalogs={catalogs} localData={localData} plan={content.calculation} genders={rules.genders}/></details>}{(revision.note || content.rotationNotes || content.contextAssumptions.length > 0) && <details><summary>Build notes and assumptions</summary><div className="share-notes">{revision.note && <p>{revision.note}</p>}{content.rotationNotes && <p>{content.rotationNotes}</p>}{content.contextAssumptions.map((note, index) => <p key={index}>{note}</p>)}</div></details>}</>}
    />
  </div>
}

export function SharedView({ encoded, catalogs, onSave, onImport }: { readonly encoded: string; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly onImport: (preview: ImportPreview) => Promise<void>; readonly onSave: (payload: SharePayload) => Promise<{ readonly buildId?: BuildId; readonly teamId?: TeamId }> }) {
  const navigation = useNavigation()
  const [viewOriginal, setViewOriginal] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [artwork, setArtwork] = useState<Readonly<Record<string, string>>>({})
  const artworkFiles = useRef(new Map<string, { url: string; size: number }>())
  const [artworkError, setArtworkError] = useState<string>()
  useEffect(() => { const files = artworkFiles.current; return () => { for (const file of files.values()) URL.revokeObjectURL(file.url) } }, [])
  const attachArtwork = (entry: BuildReferenceName, file: File | undefined) => {
    if (!file) return
    setArtworkError(undefined)
    const key = entityDefinitionKey(entry.ref)
    const previous = artworkFiles.current.get(key)
    const total = [...artworkFiles.current.values()].reduce((sum, image) => sum + image.size, 0) - (previous?.size ?? 0) + file.size
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_LOCAL_IMAGE_BYTES || total > MAX_LOCAL_ARTWORK_BYTES) { setArtworkError('Choose a PNG, JPEG, or WebP up to 4 MB, with up to 16 MB of artwork in this view.'); return }
    const url = URL.createObjectURL(file)
    if (previous) URL.revokeObjectURL(previous.url)
    artworkFiles.current.set(key, { url, size: file.size })
    setArtwork(current => ({ ...current, [key]: url }))
  }
  const decoded = useMemo(() => { try { return decodeSharePayload(encoded) } catch { return undefined } }, [encoded])
  const recovery = useMemo(() => decoded && prepareSharedModRecovery(decoded, catalogs), [decoded, catalogs])
  const matched = recovery?.payload
  // Local files enrich the read-only preview without changing the link or saved checkpoint
  const useMatchingSources = Boolean(matched) && !viewOriginal
  const [preview, setPreview] = useState<SharedPreview>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [matchingError, setMatchingError] = useState<string>()
  const [importNotice, setImportNotice] = useState<string>()
  const importMod = async (imported: ImportPreview) => {
    setImportNotice(undefined)
    await onImport(imported)
    setMatchingError(undefined)
    setViewOriginal(false)
    const source = imported.proposed.catalogs[0]
    setImportNotice(`${source ? modCatalogTitle(source) : 'Matching JSON'} was imported and saved in this browser. Matching definitions update the preview when all required sources are available. The original checkpoint is unchanged.`)
  }
  useEffect(() => {
    let live = true
    setPreview(undefined)
    setError(undefined)
    void (async () => {
      const payload = useMatchingSources && matched ? matched : decodeSharePayload(encoded)
      const data = sharePreviewData(payload)
      const prepared = await prepareModCatalogs(data, catalogs)
      validateNativeLocalDataGraph(data, prepared)
      if (live) setPreview({ payload, localData: data, catalogs: prepared })
    })().catch(reason => {
      if (!live) return
      if (useMatchingSources) { setMatchingError(formatAppError(reason, 'The imported definitions could not be applied. The original checkpoint is preserved.')); setViewOriginal(true) }
      else setError(formatAppError(reason, 'The shared snapshot could not be opened.'))
    })
    return () => { live = false }
  }, [catalogs, encoded, matched, useMatchingSources])
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
  return <LocalArtworkContext value={artwork}><div className="stack shared-preview">
    <ScreenHeader description="A read-only snapshot from a share link. Save a copy to edit it in this browser." eyebrow={payload.kind === 'team' ? 'Shared team' : 'Shared build'} title={payload.title} actions={<Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save a copy'}</Button>}/>
    <p>Readiness and stock checks need your own Playthrough records.</p>
    {recovery?.missingSources.length ? <InlineNotice title="Mod definitions needed">Import matching JSON for: {recovery.missingSources.join(', ')}. Accepted files are saved in this browser and update the preview when all required sources are available.<Button onClick={() => setSourcesOpen(true)} tone="secondary" type="button">Upload mod JSON</Button></InlineNotice> : null}
    {recovery?.error && <InlineNotice title="Imported definitions not applied" tone="warning">{recovery.error} Save a copy to review source versions and replacement links in Game Setup.</InlineNotice>}
    {matchingError && <InlineNotice title="Imported definitions not applied" tone="danger">{matchingError} Save a copy to review its Game Setup, or upload matching JSON to retry.<Button onClick={() => setSourcesOpen(true)} tone="secondary" type="button">Upload mod JSON</Button></InlineNotice>}
    {matched && <InlineNotice title={useMatchingSources ? "Using matching local JSON" : "Original checkpoint"}>{useMatchingSources ? recovery?.changedInterpretation ? "This preview uses your imported definitions and the available base catalog. Its results may differ from the saved checkpoint. The original share link is unchanged." : "The view and saved copy use your local file revisions. The original share link keeps its saved pins." : "This view keeps the saved source pins. Your imported definitions remain available for the recovered preview."}<Button onClick={() => { setMatchingError(undefined); setViewOriginal(value => !value) }} tone="secondary">{useMatchingSources ? "View original checkpoint" : "View imported definitions"}</Button></InlineNotice>}
    {artworkError && <InlineNotice title="Artwork not added" tone="danger">{artworkError}</InlineNotice>}
    {saveError && <InlineNotice title="Copy not saved" tone="danger">{saveError} Your saved records are unchanged.</InlineNotice>}
    <div className={payload.kind === 'team' ? 'share-team-grid' : 'share-build-grid'}>{slots.map((id, index) => {
      const revision = id ? payload.records.buildRevisions[id] : undefined
      const build = revision ? payload.records.builds[revision.buildId] : undefined
      return <section aria-label={payload.kind === 'team' ? `Shared team slot ${index + 1}` : 'Shared build loadout'} className="panel" key={index}><header className="panel__header"><h2>{payload.kind === 'team' ? `${index + 1}. ` : ''}{build?.title ?? 'No build assigned'}</h2></header><div className="panel__body">{revision ? <SharedBuild preview={preview} revision={revision} onUploadMod={() => setSourcesOpen(true)}/> : <BuildLoadoutSummary catalogs={preview.catalogs} gameSetup={preview.localData.gameSetups[payload.teamGameSetupRevisionId!]} localData={preview.localData}/>}</div></section>
    })}</div>
    {sourcesOpen ? <Sheet open title="Restore mod definitions" description="Upload the matching JSON for the mods used by this snapshot." onClose={() => setSourcesOpen(false)}><SharedModSources catalogs={catalogs} importNotice={importNotice} localData={preview.localData} onArtwork={attachArtwork} onImport={importMod}/></Sheet> : <SharedModSources catalogs={catalogs} importNotice={importNotice} localData={preview.localData} onArtwork={attachArtwork} onImport={importMod}/>}
  </div></LocalArtworkContext>
}
