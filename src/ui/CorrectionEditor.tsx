import { MoneyText } from './MoneyText'
import { useId, useState, type FormEvent } from 'react'
import { activeCorrections, bundledHiddenEntityKeys, CORRECTION_DECISIONS, correctionTargetChanged, correctedEntity, correctionKey, correctionSource, correctionStatus, type CatalogCorrection, type CorrectionChange } from '../domain/corrections'
import type { CatalogRef } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { correctionDraftFields, draftChanges, fieldDraft } from './correction-draft'
import { useCorrections } from './corrections-context'
import { KnowledgeValue } from './KnowledgeValue'
import { DefinitionFactsEditor, DefinitionOverviewEditor } from './DefinitionEditorFields'
import { DefinitionDraftNotice, useDefinitionDraft } from './definition-draft'
import { formatAppError } from './model'
import { useNavigation } from './navigation'
import { Sheet } from './Sheet'

function ChangeValue({ change, side }: { change: CorrectionChange; side: 'before' | 'after' }) {
  const value = change[side]
  if (value === null) return <span>{side === 'after' ? 'Hidden / removed' : 'Not supplied'}</span>
  if (change.path === 'field') return <KnowledgeValue field={change.field} value={change[side]!}/>
  if (change.path === 'visibility') return <span>{value ? 'Hidden from browsing and choices' : 'Visible'}</span>
  return <span className="correction-value"><MoneyText>{Array.isArray(value) ? value.join(', ') || 'None' : String(value)}</MoneyText></span>
}

export function CorrectionDiff({ changes }: { changes: readonly CorrectionChange[] }) {
  return <div className="correction-diff">{changes.map(change => <div className="correction-diff__entry" key={change.path === 'field' ? `field:${change.field}` : change.path}><strong>{change.path === 'field' ? change.field : change.path === 'description' ? 'Description' : change.path.charAt(0).toUpperCase() + change.path.slice(1)}</strong><div className="correction-diff__values"><div><small>Baseline</small><ChangeValue change={change} side="before"/></div><div><small>Correction</small><ChangeValue change={change} side="after"/></div></div></div>)}</div>
}

export function CorrectionEditor(props: { target: CatalogRef; initialField?: string; layer: number }) {
  const [generation, setGeneration] = useState(0)
  return <CorrectionForm {...props} key={generation} onReload={() => setGeneration(value => value + 1)}/>
}

function CorrectionForm({ target, initialField, layer, onReload }: { target: CatalogRef; initialField?: string; layer: number; onReload: () => void }) {
  const navigation = useNavigation()
  const { baseline, collection, saveDraft, error: loadError } = useCorrections()
  const [startingCollection] = useState(collection)
  const [source] = useState(() => correctionSource(baseline, target))
  const candidates = activeCorrections(startingCollection.entries).filter(entry => correctionKey(entry) === correctionKey({ target }))
  const existing = candidates.length === 1 ? candidates[0] : undefined
  const [decisionId] = useState(() => crypto.randomUUID())
  const [baselineHidden] = useState(() => bundledHiddenEntityKeys(baseline).has(correctionKey({ target })))
  const entity = source?.entity
  const effective = entity && existing ? correctedEntity(entity, existing) : entity
  const [name, setName] = useState(effective?.name ?? '')
  const [description, setDescription] = useState(effective?.rawDescription ?? '')
  const [aliases, setAliases] = useState(effective?.aliases.join('\n') ?? '')
  const [fields, setFields] = useState(() => entity ? correctionDraftFields(entity, existing) : {})
  const [hidden, setHidden] = useState(existing?.changes.find(change => change.path === 'visibility')?.after ?? baselineHidden)
  const [decision, setDecision] = useState<CatalogCorrection['decision']>(existing?.decision ?? 'correction')
  const [confidence, setConfidence] = useState<CatalogCorrection['confidence']>(existing?.confidence ?? 'tentative')
  const [reason, setReason] = useState(existing?.reason ?? '')
  const [evidence, setEvidence] = useState(existing?.evidence ?? '')
  const [context, setContext] = useState(existing?.context ?? { platform: '', gameVersion: '', mods: '' })
  const [error, setError] = useState<string>()
  const [scope] = useState(navigation.route)
  const draft = useDefinitionDraft(scope)
  const formId = useId()
  const changed = () => { draft.markDirty(); setConfidence('tentative') }
  const close = () => draft.complete(() => { navigation.close() })
  let changes: readonly CorrectionChange[] = []
  let draftError: string | undefined
  try { if (entity) changes = draftChanges(entity, name, description, aliases, hidden, fields, baselineHidden) } catch (reason) { draftError = reason instanceof Error ? reason.message : 'Check the correction values.' }
  const targetChanged = correctionTargetChanged(startingCollection, collection, target)
  const stale = existing && correctionStatus(existing, baseline, startingCollection.entries) === 'review'
  const saveDisabled = Boolean(loadError) || targetChanged || !entity || candidates.length > 1 || (!existing && !changes.length && !draftError) || (!draft.dirty && !stale)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (draft.busy || saveDisabled) return
    if (draftError) { setError(draftError); return }
    draft.pending(true)
    setError(undefined)
    try {
      const correction: CatalogCorrection = { id: decisionId, supersedes: existing ? [existing.id] : [], decision, baselineSources: entity!.sources, baselineClaims: source!.claims, target, baselineChecksum: source!.catalog.checksum, baselineName: entity!.name, confidence, reason: reason.trim(), evidence: evidence.trim(), context: { platform: context.platform.trim(), gameVersion: context.gameVersion.trim(), mods: context.mods.trim() }, updatedAt: new Date().toISOString(), changes }
      await saveDraft(correction, startingCollection)
      draft.complete(() => { navigation.close() })
    } catch (reason) { setError(formatAppError(reason, 'The correction could not be saved.')) } finally { draft.pending(false) }
  }
  const footer = <div className="definition-editor-footer"><DefinitionDraftNotice draft={draft} formId={formId} onDiscard={close} saveDisabled={saveDisabled} title="Correction draft still open"/>{(error || loadError || (draft.dirty && draftError)) && <InlineNotice title="Correction not saved" tone="danger">{error ?? loadError ?? draftError} Your draft remains here.</InlineNotice>}<small>All playthroughs in this browser. Saved builds keep their pinned rules.</small><div className="form-actions"><Button disabled={draft.busy} onClick={close} tone="quiet" type="button">{draft.dirty ? 'Discard draft' : 'Cancel'}</Button><Button disabled={draft.busy || saveDisabled} form={formId} icon="check" type="submit">{draft.busy ? 'Saving...' : existing && !changes.length && !draftError ? 'Restore baseline' : 'Save correction'}</Button></div></div>
  return <Sheet description="Update the reference for every playthrough in this browser. Evidence can be added whenever you have it." footer={footer} layer={layer} onClose={close} onRequestClose={draft.requestClose} open title={`Correct shared reference: ${entity?.name ?? 'definition'}`} width="wide">
    {(candidates.length > 1 || !entity) ? <InlineNotice title="Source unavailable" tone="warning">Choose between competing corrections in the corrections list, or install the missing source before editing. Your decisions remain available for export.</InlineNotice> : <form className="stack definition-editor" id={formId} onSubmit={submit}>
      {targetChanged && <InlineNotice title="This definition changed in another tab" tone="warning"><p>Your draft is preserved. Compare the latest saved correction before discarding this draft and reloading.</p><details><summary>Latest saved changes</summary>{activeCorrections(collection.entries).filter(entry => correctionKey(entry) === correctionKey({ target })).map(entry => <CorrectionDiff changes={entry.changes} key={entry.id}/>)}</details><Button disabled={draft.busy} onClick={onReload} tone="secondary" type="button">Discard draft and reload</Button></InlineNotice>}
      {stale && <InlineNotice title="Review against the changed baseline" tone="warning">Your previous proposal is shown against the installed source. Saving confirms this comparison and updates its baseline.</InlineNotice>}
      <fieldset className="definition-editor-fields stack" disabled={draft.busy}>
        <DefinitionOverviewEditor aliases={aliases} description={description} name={name} onAliases={value => { setAliases(value); changed() }} onDescription={value => { setDescription(value); const field = Object.keys(fields).find(field => field.toLocaleLowerCase() === 'description'); if (field) setFields(current => ({ ...current, [field]: fieldDraft(value ? { state: 'known', value } : null, true) })); changed() }} onName={value => { setName(value); changed() }}/>
        <DefinitionFactsEditor fields={fields} initialField={initialField} onChange={value => { setFields(value); const field = Object.keys(value).find(field => field.toLowerCase() === 'description'); if (field && value[field] !== fields[field]) setDescription(value[field]?.mode === 'keep' ? entity.rawDescription ?? '' : value[field]?.mode === 'known' && value[field]?.type === 'text' ? value[field].text : ''); changed() }} source={entity.fields}/>
        <details className="correction-disclosure"><summary>Visibility</summary><label className="check-row"><input checked={hidden} onChange={event => { setHidden(event.target.checked); changed() }} type="checkbox"/><span>Hide from browsing and choices<small>Existing records and direct links remain accessible.</small></span></label></details>
        <details className="correction-disclosure"><summary>Evidence & game context <span className="correction-optional">Optional</span></summary><div className="stack" onChange={draft.markDirty}><Field label="Why this correction"><textarea onChange={event => setReason(event.target.value)} value={reason}/></Field><Field label="Evidence / provenance"><textarea onChange={event => setEvidence(event.target.value)} placeholder="Source link, screenshot identifier, or steps to verify in game" value={evidence}/></Field><div className="grid-2"><Field label="Decision"><select onChange={event => setDecision(event.target.value as CatalogCorrection['decision'])} value={decision}>{Object.entries(CORRECTION_DECISIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Confidence"><select onChange={event => setConfidence(event.target.value as CatalogCorrection['confidence'])} value={confidence}><option value="tentative">Tentative / needs verification</option><option value="confirmed">Confirmed by me</option></select></Field><Field label="Platform"><input onChange={event => setContext(value => ({ ...value, platform: event.target.value }))} value={context.platform}/></Field><Field label="Game version"><input onChange={event => setContext(value => ({ ...value, gameVersion: event.target.value }))} value={context.gameVersion}/></Field></div><Field label="Enabled mods / applicability"><textarea onChange={event => setContext(value => ({ ...value, mods: event.target.value }))} value={context.mods}/></Field></div></details>
        <details open={Boolean(stale)}><summary>Review changes ({changes.length})</summary>{changes.length ? <CorrectionDiff changes={changes}/> : <p>Matches the baseline. Saving restores the baseline for this entry.</p>}</details>
      </fieldset>
    </form>}
  </Sheet>
}
