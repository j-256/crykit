import { useEffect, useRef, useState, type FormEvent } from 'react'
import { activeCorrections, bundledHiddenEntityKeys, CORRECTION_DECISIONS, mergeCorrections, correctedEntity, correctionKey, correctionSource, correctionStatus, type CatalogCorrection, type CorrectionChange } from '../domain/corrections'
import type { CatalogRef } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { correctionDraftFields, draftChanges, fieldDraft, type CorrectionFieldDraft } from './correction-draft'
import { useCorrections } from './corrections-context'
import { ClaimList, KnowledgeValue } from './KnowledgeValue'
import { formatAppError } from './model'
import { useNavigation, useNavigationBlocker } from './navigation'
import { Sheet } from './Sheet'

function ChangeValue({ change, side }: { change: CorrectionChange; side: 'before' | 'after' }) {
  const value = change[side]
  if (value === null) return <span>{side === 'after' ? 'Hidden / removed' : 'Not supplied'}</span>
  if (change.path === 'field') return <KnowledgeValue value={change[side]!}/>
  if (change.path === 'visibility') return <span>{value ? 'Hidden from browsing and choices' : 'Visible'}</span>
  return <span className="correction-value">{Array.isArray(value) ? value.join(', ') || 'None' : String(value)}</span>
}

export function CorrectionDiff({ changes }: { changes: readonly CorrectionChange[] }) {
  return <div className="correction-diff">{changes.map(change => <div className="correction-diff__entry" key={change.path === 'field' ? `field:${change.field}` : change.path}><strong>{change.path === 'field' ? change.field : change.path === 'description' ? 'Description' : change.path.charAt(0).toUpperCase() + change.path.slice(1)}</strong><div className="correction-diff__values"><div><small>Baseline</small><ChangeValue change={change} side="before"/></div><div><small>Correction</small><ChangeValue change={change} side="after"/></div></div></div>)}</div>
}

function FactEditor({ name, draft, onChange }: { name: string; draft: CorrectionFieldDraft; onChange: (draft: CorrectionFieldDraft) => void }) {
  const change = (patch: Partial<CorrectionFieldDraft>) => onChange({ ...draft, ...patch })
  const editingValue = draft.mode === 'known' || (draft.mode === 'keep' && draft.preserved?.state === 'known')
  return <div className="stack correction-fact-editor">
    <Field label={`How to correct ${name}`}><select onChange={event => change({ mode: event.target.value as CorrectionFieldDraft['mode'] })} value={editingValue ? 'known' : draft.mode}><option value="keep">Use baseline</option><option value="known">Set a value</option><option value="unknown">Unknown / needs research</option><option value="notApplicable">Not applicable</option><option value="hide">Hide this field</option>{draft.mode === 'conflicting' && <option value="conflicting">Keep these differing claims</option>}</select></Field>
    {draft.preserved?.state === 'conflicting' && <details><summary>Compare original claims</summary><ClaimList claims={draft.preserved.claims} selection={{ name: `correction-claim-${name}`, onChange: index => { const claim = draft.preserved?.state === 'conflicting' ? draft.preserved.claims[index] : undefined; if (claim) onChange(fieldDraft({ state: 'known', value: claim.value, sources: claim.sources }, true)) } }}/></details>}
    {editingValue && <><details><summary>Value format: {draft.type}</summary><Field label="Value type"><select onChange={event => change({ type: event.target.value as CorrectionFieldDraft['type'] })} value={draft.type}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes / No</option><option value="list">List (one per line)</option><option value="json">Structured JSON</option></select></Field></details><Field label={`Value for ${name}`} required>{draft.type === 'boolean' ? <select onChange={event => change({ mode: 'known', text: event.target.value })} required value={draft.text}><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select> : draft.type === 'number' ? <input inputMode="decimal" onChange={event => change({ mode: 'known', text: event.target.value })} step="any" type="number" value={draft.text}/> : <textarea onChange={event => change({ mode: 'known', text: event.target.value })} rows={draft.type === 'json' ? 6 : 3} value={draft.text}/>}</Field></>}
    {(draft.mode === 'unknown' || draft.mode === 'notApplicable') && <Field label={`Reason for ${name}`}><input onChange={event => change({ reason: event.target.value })} value={draft.reason}/></Field>}
    {draft.mode === 'hide' && <p className="settings-section__intro">This field leaves the local reference view and its filters. The original remains in the baseline comparison.</p>}
  </div>
}

export function CorrectionEditor({ target, initialField, layer }: { target: CatalogRef; initialField?: string; layer: number }) {
  const navigation = useNavigation()
  const { baseline, collection, save, error: loadError } = useCorrections()
  const source = correctionSource(baseline, target)
  const [startingCollection] = useState(collection)
  const candidates = activeCorrections(startingCollection.entries).filter(entry => correctionKey(entry) === correctionKey({ target }))
  const existing = candidates.length === 1 ? candidates[0] : undefined
  const [decisionId] = useState(() => crypto.randomUUID())
  const [decision, setDecision] = useState<CatalogCorrection['decision']>(existing?.decision ?? 'correction')
  const [initialSource] = useState(source)
  const [baselineHidden] = useState(() => bundledHiddenEntityKeys(baseline).has(correctionKey({ target })))
  const entity = initialSource?.entity
  const effective = entity && existing ? correctedEntity(entity, existing) : entity
  const [name, setName] = useState(effective?.name ?? '')
  const [description, setDescription] = useState(effective?.rawDescription ?? '')
  const [aliases, setAliases] = useState(effective?.aliases.join('\n') ?? '')
  const [fields, setFields] = useState(() => entity ? correctionDraftFields(entity, existing) : {})
  const [activeField, setActiveField] = useState(initialField ? `field:${initialField}` : 'description')
  const [newField, setNewField] = useState('')
  const [hidden, setHidden] = useState(existing?.changes.find(change => change.path === 'visibility')?.after ?? baselineHidden)
  const [confidence, setConfidence] = useState<CatalogCorrection['confidence']>(existing?.confidence ?? 'tentative')
  const [reason, setReason] = useState(existing?.reason ?? '')
  const [evidence, setEvidence] = useState(existing?.evidence ?? '')
  const [context, setContext] = useState(existing?.context ?? { platform: '', gameVersion: '', mods: '' })
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [closeWarning, setCloseWarning] = useState(false)
  const [scope] = useState(navigation.route)
  const initialFocus = useRef<HTMLSelectElement>(null)
  const pendingRef = useRef(false)
  const markDirty = () => { dirtyRef.current = true; setDirty(true); setCloseWarning(false) }
  useNavigationBlocker(scope, () => dirtyRef.current || pendingRef.current, () => setCloseWarning(true))
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  const close = () => { if (busy) return; dirtyRef.current = false; navigation.close() }
  const requestClose = () => { if (!dirtyRef.current && !busy) return true; setCloseWarning(true); return false }
  let changes: readonly CorrectionChange[] = []
  let draftError: string | undefined
  try { if (entity) changes = draftChanges(entity, name, description, aliases, hidden, fields, baselineHidden) } catch (reason) { draftError = reason instanceof Error ? reason.message : 'Check the correction values.' }
  const makeCorrection = (): CatalogCorrection => ({ id: decisionId, supersedes: existing ? [existing.id] : [], decision, baselineSources: entity!.sources, baselineClaims: initialSource!.claims, target, baselineChecksum: initialSource!.catalog.checksum, baselineName: entity!.name, confidence, reason: reason.trim(), evidence: evidence.trim(), context: { platform: context.platform.trim(), gameVersion: context.gameVersion.trim(), mods: context.mods.trim() }, updatedAt: new Date().toISOString(), changes })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (draftError) { setError(draftError); return }
    if (!entity || !initialSource || loadError) return
    setBusy(true)
    pendingRef.current = true
    setError(undefined)
    try {
      await save(mergeCorrections(startingCollection.entries, [makeCorrection()]), startingCollection.revision)
      dirtyRef.current = false
      pendingRef.current = false
      navigation.close()
    } catch (reason) { setError(formatAppError(reason, 'The correction could not be saved.')) } finally { pendingRef.current = false; setBusy(false) }
  }
  const addField = () => {
    const candidate = newField.trim()
    if (!candidate || ['__proto__', 'constructor', 'prototype'].includes(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) { setError('Enter a valid fact name.'); return }
    const present = Object.keys(fields).find(field => field.toLocaleLowerCase() === candidate.toLocaleLowerCase())
    if (present) { setActiveField(`field:${present}`); setNewField(''); return }
    setFields(current => ({ ...current, [candidate]: fieldDraft({ state: 'unknown' }, true) }))
    setConfidence('tentative')
    setActiveField(`field:${candidate}`)
    setNewField('')
    markDirty()
  }
  const factName = activeField.startsWith('field:') ? activeField.slice(6) : undefined
  const descriptionField = Object.keys(fields).find(field => field.toLocaleLowerCase() === 'description')
  const descriptionDraft = descriptionField ? fields[descriptionField] : undefined
  const descriptionText = descriptionDraft && descriptionDraft.mode !== 'keep' ? descriptionDraft.text : description
  const stale = existing && correctionStatus(existing, baseline, startingCollection.entries) === 'review'
  return <Sheet description="A small fix now, a better reference for everyone later. Saved in this browser." initialFocusRef={initialFocus} layer={layer} onClose={close} onRequestClose={requestClose} open title={`Correction details: ${entity?.name ?? 'reference'}`} width="standard">
    {(candidates.length > 1 || !entity) ? <InlineNotice title="Source unavailable" tone="warning">Choose between competing corrections in the corrections list, or install the missing source before editing. Your decisions remain available for export.</InlineNotice> : <form className="stack" onInput={markDirty} onSubmit={submit}>
      {closeWarning && <InlineNotice title="Correction draft still open" tone="warning">Save your correction or choose Discard draft before leaving.</InlineNotice>}
      {collection.revision !== startingCollection.revision && <InlineNotice title="Corrections changed in another tab" tone="warning">Your draft is preserved. Copy any unsaved text, then reopen this editor to review the newer corrections before saving.</InlineNotice>}
      {stale && <InlineNotice title="Review against the changed baseline" tone="warning">Your previous proposal is shown against the installed source. Saving confirms this comparison and updates its baseline.</InlineNotice>}
      <Field label="What to correct"><select onChange={event => setActiveField(event.target.value)} ref={initialFocus} value={activeField}><optgroup label="Overview"><option value="description">Description</option><option value="name">Name</option><option value="aliases">Alternate names</option><option value="visibility">Where this appears</option></optgroup><optgroup label="Facts">{Object.keys(fields).sort().map(field => <option key={field} value={`field:${field}`}>{field}{fields[field]?.mode === 'keep' ? '' : ' (edited)'}</option>)}</optgroup></select></Field>
      {activeField === 'name' && <Field label="Reference name" required><input onChange={event => { setName(event.target.value); setConfidence('tentative') }} required value={name}/></Field>}
      {activeField === 'description' && <Field label="Reference description"><textarea onChange={event => { const text = event.target.value; setDescription(text); if (descriptionField && descriptionDraft) setFields(current => ({ ...current, [descriptionField]: { ...descriptionDraft, mode: 'known', type: 'text', text } })); setConfidence('tentative') }} rows={4} value={descriptionText}/></Field>}
      {activeField === 'aliases' && <Field hint="One alternate name per line." label="Reference aliases"><textarea onChange={event => { setAliases(event.target.value); setConfidence('tentative') }} value={aliases}/></Field>}
      {activeField === 'visibility' && <label className="check-row"><input checked={hidden} onChange={event => { setHidden(event.target.checked); setConfidence('tentative') }} type="checkbox"/><span>Hide from browsing and choices<small>Existing records and direct links remain accessible. Uncheck to restore visibility.</small></span></label>}
      {factName && fields[factName] && <><FactEditor draft={fields[factName]} name={factName} onChange={draft => { markDirty(); setConfidence('tentative'); setFields(current => ({ ...current, [factName]: draft })) }}/><details className="correction-disclosure"><summary>Compare with the source</summary><div className="correction-baseline">{entity.fields[factName] ? <KnowledgeValue showSources value={entity.fields[factName]}/> : <span>Not supplied</span>}</div></details></>}
      <details className="correction-disclosure"><summary>Add a missing fact</summary><div className="cluster"><Field label="New fact name"><input onChange={event => setNewField(event.target.value)} placeholder="For example, Acquisition" value={newField}/></Field><Button disabled={!newField.trim()} icon="plus" onClick={addField} tone="secondary" type="button">Add fact</Button></div></details>
      <details className="correction-disclosure"><summary>Evidence & game context <span className="correction-optional">Optional</span></summary><div className="stack"><p className="settings-section__intro">Include enough detail for someone else to verify this delta. Use a source URL, screenshot identifier, or reproducible in-game steps. Attach permitted evidence separately when submitting.</p><Field label="Decision"><select onChange={event => setDecision(event.target.value as CatalogCorrection['decision'])} value={decision}>{Object.entries(CORRECTION_DECISIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Confidence"><select onChange={event => setConfidence(event.target.value as CatalogCorrection['confidence'])} value={confidence}><option value="tentative">Tentative / needs verification</option><option value="confirmed">Confirmed by me</option></select></Field><Field label="Why this correction"><textarea onChange={event => setReason(event.target.value)} value={reason}/></Field><Field label="Evidence / provenance"><textarea onChange={event => setEvidence(event.target.value)} placeholder="Source, observation date, and how to reproduce or locate the evidence" value={evidence}/></Field><div className="grid-2"><Field label="Platform"><input onChange={event => setContext(value => ({ ...value, platform: event.target.value }))} placeholder="For example, Nintendo Switch" value={context.platform}/></Field><Field label="Game version"><input onChange={event => setContext(value => ({ ...value, gameVersion: event.target.value }))} placeholder="Leave blank if unknown" value={context.gameVersion}/></Field></div><Field label="Enabled mods / applicability"><textarea onChange={event => setContext(value => ({ ...value, mods: event.target.value }))} placeholder="List enabled mods and relevant settings, or explicitly state None" value={context.mods}/></Field></div></details>
      <details open={stale}><summary>Review delta ({changes.length} {changes.length === 1 ? 'change' : 'changes'})</summary>{changes.length ? <CorrectionDiff changes={changes}/> : <p>Matches the baseline. Saving restores the baseline for this entry.</p>}</details>
      {changes.length > 0 && <p className="settings-section__intro"><Badge tone={confidence === 'tentative' ? 'warning' : 'info'}>{confidence === 'tentative' ? 'Tentative correction' : 'User-confirmed correction'}</Badge> You can add more detail later.</p>}
      {(error || loadError || (dirty && draftError)) && <InlineNotice title="Correction not saved" tone="danger">{error ?? loadError ?? draftError} Your draft remains here.</InlineNotice>}
      <div className="form-actions"><Button disabled={busy} onClick={close} tone="quiet" type="button">{dirty ? 'Discard draft' : 'Cancel'}</Button><Button disabled={busy || Boolean(loadError) || collection.revision !== startingCollection.revision || (!existing && !changes.length)} icon="check" type="submit">{busy ? 'Saving...' : changes.length ? 'Save correction' : 'Restore baseline'}</Button></div>
    </form>}
  </Sheet>
}
