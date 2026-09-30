import { useEffect, useState } from 'react'
import { logicalEntityKey, requirePlaythrough, validateBuildContent } from '../domain'
import { equipmentFacts, equipmentRole } from '../domain/mechanics-facts'
import type { BuildId, BuildRevision, CatalogSnapshot, CharacterId, LocalData, ScenarioId } from '../domain'
import { decodeSharePayload, sharePreviewData, type SharePayload } from '../interchange/share'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { prepareModCatalogs } from '../persistence'
import { BuildLoadoutSummary } from './BuildLoadoutSummary'
import { BuildValidity } from './BuildValidity'
import { Button, Field, InlineNotice, ScreenHeader } from './components'
import { entityName, formatAppError, knowledgeLabel, resolveEntity } from './model'
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
  const calculation = revision.content.calculation
  return <div className="stack">
    <BuildLoadoutSummary catalogs={catalogs} content={revision.content} gameSetup={setup} localData={localData}/>
    <dl className="definition-list">{setup.slots.map(slot => <div className="definition-row" key={slot.id}><dt>{slot.label}</dt><dd>{revision.content.equipment[slot.id] ? entityName(localData, catalogs, revision.content.equipment[slot.id]!.ref) : twoHanded && equipmentRole(slot) === 'offHand' ? `Occupied by ${mainHandDefinition.name}` : 'Empty'}</dd></div>)}</dl>
    <BuildValidity report={report}/>
    {calculation && <details><summary>Calculation inputs</summary><dl className="definition-list"><div className="definition-row"><dt>Level</dt><dd>{calculation.level ?? 'Unknown'}</dd></div>{calculation.growth.map((growth, index) => <div className="definition-row" key={index}><dt>{entityName(localData, catalogs, growth.classRef, 'Unknown growth class')}</dt><dd>{growth.levels ?? 'Unknown'} levels</dd></div>)}<div className="definition-row"><dt>Stat bonuses</dt><dd>{calculation.bonuses.join(', ') || 'None selected'}</dd></div><div className="definition-row"><dt>Statuses</dt><dd>{calculation.statuses.map(ref => entityName(localData, catalogs, ref)).join(', ') || 'None selected'}</dd></div><div className="definition-row"><dt>Ability</dt><dd>{entityName(localData, catalogs, calculation.ability, 'None selected')}</dd></div><div className="definition-row"><dt>Target evasion</dt><dd>{calculation.targetEvasion ?? 'Unknown'}</dd></div></dl></details>}
    {(revision.note || revision.content.rotationNotes || revision.content.contextAssumptions.length > 0) && <details><summary>Build notes and assumptions</summary><div className="share-notes">{revision.note && <p>{revision.note}</p>}{revision.content.rotationNotes && <p>{revision.content.rotationNotes}</p>}{revision.content.contextAssumptions.map((note, index) => <p key={index}>{note}</p>)}</div></details>}
    <details><summary>Game Setup: {setup.label}</summary><dl className="definition-list"><div className="definition-row"><dt>Platform</dt><dd>{knowledgeLabel(setup.platform)}</dd></div><div className="definition-row"><dt>Game version</dt><dd>{knowledgeLabel(setup.gameVersion)}</dd></div><div className="definition-row"><dt>Mode</dt><dd>{knowledgeLabel(setup.mode)}</dd></div><div className="definition-row"><dt>Mods</dt><dd>{knowledgeLabel(setup.mods, mods => mods.join(', ') || 'None')}</dd></div></dl></details>
  </div>
}

export function SharedView({ encoded, localData, catalogs, onSave }: { readonly encoded: string; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly onSave: (payload: SharePayload, memberIds?: readonly CharacterId[]) => Promise<{ readonly buildId?: BuildId; readonly scenarioId?: ScenarioId }> }) {
  const navigation = useNavigation()
  const [preview, setPreview] = useState<SharedPreview>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [memberIds, setMemberIds] = useState<string[]>(['', '', '', ''])
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
      const result = await onSave(preview.payload, preview.payload.kind === 'team' ? memberIds as CharacterId[] : undefined)
      const page = result.scenarioId ? { page: 'builds' as const, view: 'scenario' as const, scenarioId: result.scenarioId } : { page: 'builds' as const, view: 'build' as const, buildId: result.buildId! }
      navigation.navigate({ page, overlays: [], query: {} })
    } catch (reason) { setSaveError(formatAppError(reason, 'The shared copy could not be saved.')) }
    finally { setBusy(false) }
  }
  if (error) return <section className="panel"><div className="panel__body stack"><h1>Shared snapshot unavailable</h1><InlineNotice title="Link could not be opened" tone="danger">{error} Missing catalog revisions are not replaced by another version.</InlineNotice><Button onClick={() => navigation.navigate({ page: { page: 'builds', view: 'library' }, overlays: [], query: {} })}>Open build library</Button></div></section>
  if (!preview) return <p role="status">Opening shared snapshot...</p>
  const { payload } = preview
  const characters = Object.values(requirePlaythrough(localData).characters)
  const slots = payload.kind === 'team' ? payload.slots! : [Object.values(payload.records.buildRevisions)[0]!.id]
  return <div className="stack shared-preview">
    <ScreenHeader description="A read-only snapshot from a share link. Save a copy to edit it in this browser." eyebrow={payload.kind === 'team' ? 'Shared team' : 'Shared build'} title={payload.title} actions={payload.kind === 'build' ? <Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save a copy'}</Button> : undefined}/>
    <p>Build rules use the pinned Game Setup. Character readiness and available stock need your own Playthrough records.</p>
    {saveError && <InlineNotice title="Copy not saved" tone="danger">{saveError} Your existing records were preserved.</InlineNotice>}
    <div className={payload.kind === 'team' ? 'share-team-grid' : 'share-build-grid'}>{slots.map((id, index) => {
      const revision = id ? payload.records.buildRevisions[id] : undefined
      const build = revision ? payload.records.builds[revision.buildId] : undefined
      return <section aria-label={payload.kind === 'team' ? `Shared team slot ${index + 1}` : 'Shared build loadout'} className="panel" key={index}><header className="panel__header"><h2>{payload.kind === 'team' ? `${index + 1}. ` : ''}{build?.title ?? 'No build assigned'}</h2></header><div className="panel__body">{revision ? <SharedBuild preview={preview} revision={revision}/> : <BuildLoadoutSummary catalogs={preview.catalogs} gameSetup={preview.localData.gameSetups[payload.teamGameSetupRevisionId!]} localData={preview.localData}/>}</div></section>
    })}</div>
    {payload.kind === 'team' && <section aria-label="Save shared team" className="panel"><div className="panel__body stack"><h2>Save a team copy</h2><p>Choose which of your characters fills each slot. This adds a draft team and its builds to your Playthrough.</p>{characters.length < slots.length && <InlineNotice title="Four characters needed">Add four characters to your Playthrough to save this team.</InlineNotice>}<div className="grid-2">{slots.map((_, index) => <Field key={index} label={`Team slot ${index + 1}`}><select aria-label={`Team slot ${index + 1}`} disabled={busy} onChange={event => setMemberIds(current => current.map((id, slot) => slot === index ? event.target.value : id))} value={memberIds[index]}><option value="">Choose character</option>{characters.map(character => <option disabled={memberIds.includes(character.id) && memberIds[index] !== character.id} key={character.id} value={character.id}>{character.name}</option>)}</select></Field>)}</div><Button disabled={busy || memberIds.some(id => !id) || new Set(memberIds).size !== slots.length} onClick={() => void save()}>{busy ? 'Saving...' : 'Save a copy'}</Button></div></section>}
  </div>
}
