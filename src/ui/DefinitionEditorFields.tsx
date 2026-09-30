import { useId, useState, type ReactNode } from 'react'
import type { CatalogEntity } from '../domain/types'
import { sameCorrectionValue } from '../domain/corrections'
import { Button, Field, InlineNotice } from './components'
import { ClaimList, KnowledgeValue } from './KnowledgeValue'
import { fieldDraft, type CorrectionFieldDraft } from './correction-draft'

export function DefinitionOverviewEditor({ name, description, aliases, onName, onDescription, onAliases, children }: { name: string; description: string; aliases: string; onName: (value: string) => void; onDescription: (value: string) => void; onAliases: (value: string) => void; children?: ReactNode }) {
  return <section aria-label="Definition overview" className="stack"><div className="grid-2"><Field label="Definition name" required><input autoFocus onChange={event => onName(event.target.value)} required value={name}/></Field>{children}</div><Field label="Description"><textarea onChange={event => onDescription(event.target.value)} rows={3} value={description}/></Field><Field hint="One alternate name per line." label="Aliases"><textarea onChange={event => onAliases(event.target.value)} rows={2} value={aliases}/></Field></section>
}

export function DefinitionFactEditor({ name, draft, onChange }: { name: string; draft: CorrectionFieldDraft; onChange: (draft: CorrectionFieldDraft) => void }) {
  const claimId = useId()
  const change = (patch: Partial<CorrectionFieldDraft>) => onChange({ ...draft, ...patch })
  const editingValue = draft.mode === 'known' || (draft.mode === 'keep' && draft.preserved?.state === 'known')
  const shown = draft.mode === 'keep' ? fieldDraft(draft.preserved) : draft
  const claims = draft.preserved?.state === 'conflicting' ? draft.preserved.claims : undefined
  const selected = claims?.findIndex(claim => {
    const sourceDraft = fieldDraft({ state: 'known', value: claim.value })
    return draft.mode === 'known' && sourceDraft.type === draft.type && sourceDraft.text === draft.text && sameCorrectionValue(claim.sources, draft.selectedSources)
  })
  return <div className="stack definition-fact-editor">
    <Field label={`Knowledge for ${name}`}><select onChange={event => change({ mode: event.target.value as CorrectionFieldDraft['mode'] })} value={draft.mode}><option value="keep">Keep saved value</option><option value="known">Set a value</option><option value="unknown">Unknown / needs research</option><option value="notApplicable">Not applicable</option><option value="hide">Remove this fact</option>{draft.mode === 'conflicting' && <option value="conflicting">Keep differing claims</option>}</select></Field>
    {claims && <fieldset className="claim-review"><legend>{name} claims</legend><label className="check-row"><input checked={draft.mode === 'keep' || draft.mode === 'conflicting'} name={claimId} onChange={() => onChange(fieldDraft(draft.preserved))} type="radio"/><span>Keep unresolved<small>Preserve every source claim.</small></span></label><ClaimList claims={claims} field={name} selection={{ name: claimId, index: selected === -1 ? undefined : selected, onChange: index => { const claim = claims[index]!; onChange({ ...fieldDraft({ state: 'known', value: claim.value, sources: claim.sources }, true), preserved: draft.preserved, selectedSources: claim.sources }) } }}/></fieldset>}
    {editingValue && <><Field label={`Value for ${name}`}>{shown.type === 'boolean' ? <select onChange={event => change({ mode: 'known', text: event.target.value })} value={shown.text}><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select> : shown.type === 'number' ? <input inputMode="decimal" onChange={event => change({ mode: 'known', text: event.target.value })} step="any" type="number" value={shown.text}/> : <textarea onChange={event => change({ mode: 'known', text: event.target.value })} rows={shown.type === 'json' ? 6 : 3} value={shown.text}/>}</Field><Field label={`Value format for ${name}`}><select onChange={event => change({ mode: 'known', type: event.target.value as CorrectionFieldDraft['type'] })} value={shown.type}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes / No</option><option value="list">List (one per line)</option><option value="json">Structured JSON</option></select></Field></>}
    {(draft.mode === 'unknown' || draft.mode === 'notApplicable') && <Field label={`Reason for ${name}`}><input onChange={event => change({ reason: event.target.value })} value={draft.reason}/></Field>}
    {draft.mode === 'hide' && <p className="settings-section__intro">This removes the fact from the edited definition. The saved source remains available.</p>}
    {draft.mode === 'keep' && !editingValue && !claims && <KnowledgeValue field={name} value={draft.preserved ?? { state: 'unknown' }}/>}
  </div>
}

export function DefinitionFactsEditor({ fields, source, onChange, initialField }: { fields: Readonly<Record<string, CorrectionFieldDraft>>; source: CatalogEntity['fields']; onChange: (fields: Readonly<Record<string, CorrectionFieldDraft>>) => void; initialField?: string }) {
  const names = Object.keys(fields).sort()
  const [active, setActive] = useState(initialField ?? names.find(name => fields[name]?.preserved?.state === 'conflicting') ?? names[0] ?? '')
  const [newField, setNewField] = useState('')
  const [error, setError] = useState<string>()
  const add = () => {
    const candidate = newField.trim()
    if (!candidate || ['__proto__', 'constructor', 'prototype'].includes(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) { setError('Enter a valid fact name.'); return }
    const present = Object.keys(fields).find(name => name.toLocaleLowerCase() === candidate.toLocaleLowerCase())
    if (!present) onChange({ ...fields, [candidate]: fieldDraft({ state: 'unknown' }, true) })
    setActive(present ?? candidate)
    setNewField('')
    setError(undefined)
  }
  const draft = fields[active]
  return <section aria-label="Definition facts" className="stack definition-facts-editor"><div><h3>Definition facts</h3><p className="settings-section__intro">Edit values, keep uncertainty explicit, or add a missing fact.</p></div>{names.length > 0 && <Field label="Fact to edit"><select onChange={event => setActive(event.target.value)} value={active}>{names.map(name => <option key={name} value={name}>{name}{fields[name]?.mode === 'keep' ? '' : ' (edited)'}</option>)}</select></Field>}
    {draft && <><DefinitionFactEditor draft={draft} key={active} name={active} onChange={value => onChange({ ...fields, [active]: value })}/><details className="correction-disclosure"><summary>Compare with the source</summary><div className="correction-baseline">{source[active] ? <KnowledgeValue field={active} showSources value={source[active]}/> : 'Not supplied'}</div><Button onClick={() => onChange({ ...fields, [active]: fieldDraft(source[active]) })} tone="quiet" type="button">Restore source value</Button></details></>}
    <div className="cluster"><Field label="New fact name"><input onChange={event => setNewField(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} placeholder="For example, Acquisition" value={newField}/></Field><Button disabled={!newField.trim()} icon="plus" onClick={add} tone="secondary" type="button">Add fact</Button></div>{error && <InlineNotice title="Fact not added" tone="danger">{error}</InlineNotice>}
  </section>
}
