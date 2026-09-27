import { useEffect, useRef, useState, type FormEvent, type PropsWithChildren } from 'react'
import { activeCorrections, CORRECTION_DECISIONS, correctionKey, correctionSource, correctionStatus, mergeCorrections, originalCorrectionValue, sameCorrectionValue, type CatalogCorrection, type CorrectionChange } from '../domain/corrections'
import type { CatalogRef, Knowledge, JsonValue } from '../domain/types'
import { Button, Field, InlineNotice } from './components'
import { draftFieldValue, fieldDraft, type CorrectionFieldDraft } from './correction-draft'
import { useCorrections } from './corrections-context'
import { formatAppError } from './model'
import { useNavigation, useNavigationBlocker } from './navigation'

export type EditableReferencePath = 'name' | 'description' | `field:${string}`

export function EditableReference({ editing, active, label, onActivate, target, path, onClose, children }: PropsWithChildren<{ editing: boolean; active: boolean; label: string; onActivate: () => void; target: CatalogRef; path: EditableReferencePath; onClose: () => void }>) {
  if (active) return <InlineCorrection key={path} label={label} onClose={onClose} path={path} target={target}/>
  if (!editing) return <>{children}</>
  return <div aria-label={`Edit ${label}`} className="reference-editable" onClick={event => { if (!(event.target as Element).closest('a, button, input, summary')) onActivate() }} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onActivate() } }} role="button" tabIndex={0}>{children}<span aria-hidden="true" className="reference-editable__hint">Edit</span></div>
}

function InlineCorrection({ target, path, label, onClose }: { target: CatalogRef; path: EditableReferencePath; label: string; onClose: () => void }) {
  const { collection, baseline, catalogs, save, error: loadError } = useCorrections()
  const navigation = useNavigation()
  const [startingCollection] = useState(collection)
  const [source] = useState(() => correctionSource(baseline, target))
  const [effective] = useState(() => correctionSource(catalogs, target)?.entity)
  const candidates = activeCorrections(startingCollection.entries).filter(entry => correctionKey(entry) === correctionKey({ target }))
  const existing = candidates.length === 1 ? candidates[0] : undefined
  const field = path.startsWith('field:') ? path.slice(6) : path === 'description' ? Object.keys(source?.entity.fields ?? {}).find(name => name.toLocaleLowerCase() === 'description') : undefined
  const fieldChange = existing?.changes.find(change => change.path === 'field' && change.field === field)
  const originalValue = fieldChange?.path === 'field' ? fieldChange.after : field && source && Object.hasOwn(source.entity.fields, field) ? source.entity.fields[field] : undefined
  const [format, setFormat] = useState<CorrectionFieldDraft['type']>(() => fieldDraft(originalValue).type)
  const [mode, setMode] = useState<'known' | 'unknown' | 'notApplicable' | 'hide'>('known')
  const [valueEdited, setValueEdited] = useState(false)
  const [text, setText] = useState(() => path === 'name' ? effective?.name ?? '' : path === 'description' ? effective?.rawDescription ?? '' : fieldDraft(originalValue).text)
  const [reason, setReason] = useState(existing?.reason ?? '')
  const [evidence, setEvidence] = useState(existing?.evidence ?? '')
  const [context, setContext] = useState(existing?.context ?? { platform: '', gameVersion: '', mods: '' })
  const [confidence, setConfidence] = useState<CatalogCorrection['confidence']>(existing?.confidence ?? 'tentative')
  const [decision, setDecision] = useState<CatalogCorrection['decision']>(existing?.decision ?? 'correction')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const pendingRef = useRef(false)
  const input = useRef<HTMLDivElement>(null)
  const [scope] = useState(navigation.route)
  const markDirty = () => { dirtyRef.current = true; setDirty(true) }
  useNavigationBlocker(scope, () => dirtyRef.current || pendingRef.current, () => setError('Save this edit or choose Cancel before leaving.'))
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.textContent = text
    element.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    // Keep the editable DOM stable while typing so the selection is not reset
  }, [])
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!source || loadError) return
    setError(undefined)
    try {
      let change: CorrectionChange
      if (path === 'name') {
        if (!text.trim()) throw new Error('Enter a name before saving.')
        change = { path: 'name', before: source.entity.name, after: text.trim() }
      } else if (path === 'description' && !field) change = { path: 'description', before: source.entity.rawDescription ?? null, after: text.trim() || null }
      else {
        const before = Object.hasOwn(source.entity.fields, field!) ? source.entity.fields[field!]! : null
        const after = valueEdited ? draftFieldValue({ mode, type: format, text, reason: '', ...(originalValue ? { preserved: originalValue } : {}) }) as Knowledge<JsonValue> | null : originalValue ?? null
        change = { path: 'field', field: field!, before, after }
      }
      const isDescription = (value: CorrectionChange) => value.path === 'description' || (value.path === 'field' && value.field.toLocaleLowerCase() === 'description')
      const changes = (existing?.changes ?? []).filter(value => !(isDescription(value) && isDescription(change)) && (value.path !== change.path || (value.path === 'field' && change.path === 'field' && value.field !== change.field)))
      if (!sameCorrectionValue(originalCorrectionValue(source.entity, change), change.after)) changes.push(change)
      if (!changes.length && !existing) { dirtyRef.current = false; onClose(); return }
      const correction: CatalogCorrection = { id: crypto.randomUUID(), supersedes: existing ? [existing.id] : [], decision, target, baselineChecksum: source.catalog.checksum, baselineName: source.entity.name, baselineSources: source.entity.sources, baselineClaims: source.claims, confidence, reason, evidence, context, updatedAt: new Date().toISOString(), changes }
      pendingRef.current = true
      setBusy(true)
      await save(mergeCorrections(startingCollection.entries, [correction]), startingCollection.revision)
      dirtyRef.current = false
      pendingRef.current = false
      onClose()
    } catch (reason) { setError(formatAppError(reason, 'Your edit could not be saved.')) } finally { pendingRef.current = false; setBusy(false) }
  }
  const blocked = !source || candidates.length > 1 || (existing && correctionStatus(existing, baseline, startingCollection.entries) === 'review')
  if (blocked) return <div className="stack"><InlineNotice title="Review the saved decisions first" tone="warning">The source changed or more than one correction applies. Use Corrections to compare them before editing.</InlineNotice><Button onClick={onClose} tone="quiet">Close edit</Button></div>
  return <form aria-label={`Correct ${label} in place`} className="inline-correction" onInput={markDirty} onSubmit={submit}>
    <div aria-label={`New ${label}`} aria-multiline="true" className={`inline-correction__text${path === 'name' ? ' inline-correction__text--name' : ''}`} contentEditable={!busy && mode === 'known'} data-placeholder="Type the corrected value..." onInput={event => { setText(event.currentTarget.innerText); setValueEdited(true); setConfidence('tentative') }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.closest('form')?.requestSubmit() } }} onPaste={event => {
      event.preventDefault()
      const selection = window.getSelection()
      if (!selection?.rangeCount) return
      const range = selection.getRangeAt(0)
      if (!input.current?.contains(range.commonAncestorContainer)) return
      range.deleteContents()
      const plain = document.createTextNode(event.clipboardData.getData('text/plain'))
      range.insertNode(plain)
      range.setStartAfter(plain)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      setText(event.currentTarget.innerText)
      setValueEdited(true)
      setConfidence('tentative')
      markDirty()
    }} ref={input} role="textbox" suppressContentEditableWarning tabIndex={0}/>
    <div className="inline-correction__actions"><Button disabled={busy || Boolean(loadError) || collection.revision !== startingCollection.revision} icon="check" type="submit">{busy ? 'Saving...' : 'Save'}</Button><Button disabled={busy} onClick={() => { dirtyRef.current = false; onClose() }} tone="quiet" type="button">Cancel</Button><small>Only this browser · add detail whenever you like</small></div>
    <details className="correction-disclosure"><summary>Add evidence or detail <span className="correction-optional">Optional</span></summary><div className="stack">
      {field && <div className="grid-2"><Field label="Knowledge"><select onChange={event => { setMode(event.target.value as typeof mode); setValueEdited(true); setConfidence('tentative') }} value={mode}><option value="known">Use my value</option><option value="unknown">Unknown</option><option value="notApplicable">Not applicable</option><option value="hide">Hide this fact</option></select></Field><Field label="Value format"><select onChange={event => { setFormat(event.target.value as typeof format); setValueEdited(true); setConfidence('tentative') }} value={format}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean (true / false)</option><option value="list">List (one per line)</option><option value="json">Structured JSON</option></select></Field></div>}
      <Field label="Evidence / provenance"><textarea onChange={event => setEvidence(event.target.value)} placeholder="Source link, screenshot identifier, or how to verify this in game" value={evidence}/></Field><Field label="Why this correction"><textarea onChange={event => setReason(event.target.value)} value={reason}/></Field>
      <div className="grid-2"><Field label="Decision"><select onChange={event => setDecision(event.target.value as CatalogCorrection['decision'])} value={decision}>{Object.entries(CORRECTION_DECISIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Confidence"><select onChange={event => setConfidence(event.target.value as CatalogCorrection['confidence'])} value={confidence}><option value="tentative">Tentative</option><option value="confirmed">Confirmed by me</option></select></Field></div>
      <details><summary>Game version & applicability</summary><div className="stack"><Field label="Platform"><input onChange={event => setContext(value => ({ ...value, platform: event.target.value }))} value={context.platform}/></Field><Field label="Game version"><input onChange={event => setContext(value => ({ ...value, gameVersion: event.target.value }))} value={context.gameVersion}/></Field><Field label="Enabled mods / applicability"><textarea onChange={event => setContext(value => ({ ...value, mods: event.target.value }))} value={context.mods}/></Field></div></details>
    </div></details>
    {collection.revision !== startingCollection.revision && <InlineNotice title="Another correction was saved" tone="warning">Your text remains here. Copy it, cancel, and reopen this edit to use the latest baseline of local decisions.</InlineNotice>}
    {(error || loadError) && <InlineNotice title="Edit still open" tone="danger">{error ?? loadError}</InlineNotice>}
  </form>
}
