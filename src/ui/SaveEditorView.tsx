import { useEffect, useMemo, useRef, useState } from 'react'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { CRYSTAL_SAVE_LIMITS, CRYSTAL_SAVE_MIN_VERSION, CRYSTAL_SAVE_VERSION, crystalSaveVersion, isSupportedCrystalSaveVersion, decodeCrystalSave, encodeCrystalSave, type CrystalSave } from '../interchange/crystal-save'
import { editSave, inspectSave, previewSaveChanges, saveEditorChoices, SAVE_EDITOR_MAX_CURRENCY, SAVE_EDITOR_MAX_LEVEL, type SaveEditCommand } from '../domain/save-editor'
import { Button, Field, InlineNotice, ScreenHeader } from './components'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { downloadBytes } from './model'
import './save-editor.css'

const INVENTORY_PAGE_SIZE = 30
const CHOICES = saveEditorChoices(SAVE_EDITOR_CATALOG)
const BULK_ACTIONS = [
  { type: 'overpowered', title: 'Overpowered preset', description: 'Raise the party to level 99, master classes and skills, and add money, travel items, and a broad equipment inventory. Keep the party\'s equipped loadouts.', button: 'Review overpowered preset' },
  { type: 'unlock-jobs', title: 'Unlock all classes', description: 'Make the base-game classes available to each party member. Keep their learned skills and equipped classes.', button: 'Review class unlocks' },
  { type: 'master-jobs', title: 'Master classes and skills', description: 'Learn the supported class abilities and learnable passives for every member, with class mastery and JP.', button: 'Review class mastery' },
  { type: 'reveal-maps', title: 'Reveal stored maps', description: 'Reveal the map regions already stored in this save. Areas absent from the save are not created.', button: 'Review map reveal' },
] as const

interface OpenSave {
  readonly filename: string
  readonly originalBytes: Uint8Array
  readonly original?: CrystalSave
  readonly draft?: CrystalSave
  readonly issue?: string
}

interface ReviewedChange {
  readonly title: string
  readonly draft: CrystalSave
  readonly changes: readonly string[]
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function wholeNumber(value: string, label: string) {
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a whole number of zero or more.`)
  return Number(value)
}

function invalidWholeNumber(value: string | undefined) {
  return value !== undefined && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)))
}

function exportFilename(filename: string) {
  return `${filename.replace(/\.sav$/i, '')}-edited.sav`
}

function currencyDisplay(copper: number) {
  return `${Math.floor(copper / 10_000).toLocaleString()} gold · ${Math.floor(copper / 100) % 100} silver · ${copper % 100} copper`
}

function savedDate(save: CrystalSave) {
  const date = save.header.lastUpdated
  if (!date) return 'Not stored in this format'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.year}-${pad(date.month)}-${pad(date.day)} ${pad(date.hour)}:${pad(date.minute)}:${pad(date.second)}`
}

function playTime(save: CrystalSave) {
  const time = save.header.playTime
  return `${time.days ? `${time.days}d ` : ''}${time.hours}h ${time.minutes}m`
}

export function SaveEditorView({ onDraftChange }: { readonly onDraftChange?: DraftChangeHandler } = {}) {
  const [opened, setOpened] = useState<OpenSave>()
  const [pending, setPending] = useState<Record<string, string>>({})
  const [revision, setRevision] = useState(0)
  const [exportedRevision, setExportedRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [review, setReview] = useState<ReviewedChange>()
  const [query, setQuery] = useState('')
  const [inventoryKind, setInventoryKind] = useState('all')
  const [stockFilter, setStockFilter] = useState('all')
  const [inventoryLimit, setInventoryLimit] = useState(INVENTORY_PAGE_SIZE)
  const fileInput = useRef<HTMLInputElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const reviewTrigger = useRef<HTMLButtonElement | null>(null)
  const openRequest = useRef(0)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useMemo<DraftActions>(() => ({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() }), [])
  const summary = useMemo(() => opened?.draft ? inspectSave(opened.draft, SAVE_EDITOR_CATALOG) : undefined, [opened?.draft])
  const changes = useMemo(() => opened?.original && opened.draft && opened.original !== opened.draft ? previewSaveChanges(opened.original, opened.draft, SAVE_EDITOR_CATALOG) : [], [opened?.original, opened?.draft])
  const hasPending = Object.keys(pending).length > 0
  const dirty = revision !== exportedRevision || hasPending || busy
  const locked = busy || !summary?.editable || !!review
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const inventory = (summary?.inventory ?? []).filter(row => (inventoryKind === 'all' || row.kind === inventoryKind)
    && (stockFilter === 'all' || row.count > 0)
    && `${row.name} ${row.id}`.toLocaleLowerCase().includes(normalizedQuery))

  useEffect(() => {
    actionsRef.current = { save: async () => exportEdited(), discard: resetDraft }
  })
  useEffect(() => { onDraftChange?.(dirty, registeredActions) }, [dirty, onDraftChange, registeredActions])
  useEffect(() => () => { openRequest.current++; onDraftChange?.(false) }, [onDraftChange])
  useEffect(() => {
    if (review) previewHeading.current?.focus()
    else if (reviewTrigger.current) { reviewTrigger.current.focus(); reviewTrigger.current = null }
  }, [review])

  function resetDraft() {
    openRequest.current++
    setOpened(value => value ? { ...value, draft: value.original } : value)
    setPending({}); setRevision(0); setExportedRevision(0); setReview(undefined); setError(undefined); setStatus(undefined); setBusy(false)
    onDraftChange?.(false)
  }

  function setField(key: string, value: string, original: string) {
    setPending(current => {
      const next = { ...current }
      if (value === original) delete next[key]
      else next[key] = value
      return next
    })
    setStatus(undefined)
  }

  function apply(command: SaveEditCommand, fields: readonly string[]) {
    if (!opened?.draft || locked) return
    try {
      const draft = editSave(opened.draft, SAVE_EDITOR_CATALOG, command)
      const nextChanges = previewSaveChanges(opened.draft, draft, SAVE_EDITOR_CATALOG)
      if (nextChanges.length) { setOpened({ ...opened, draft }); setRevision(value => value + 1) }
      setPending(current => { const next = { ...current }; fields.forEach(key => { delete next[key] }); return next })
      setError(undefined); setStatus(nextChanges.length ? 'Changes applied to the draft. Export a save to use them in the game.' : 'This value already matches the draft.')
    } catch (reason) { setError(errorMessage(reason)) }
  }

  async function openFile(file: File) {
    if ((revision !== exportedRevision || hasPending) && !window.confirm('Open another save and discard the changes that have not been exported?')) return
    const request = ++openRequest.current
    if (file.size > CRYSTAL_SAVE_LIMITS.maxFileBytes) { setBusy(false); setError('This file exceeds the 64 MiB save editor limit. The open draft has not changed.'); return }
    if (!file.size) { setBusy(false); setError('This file is empty. Choose a Crystal Project .sav file.'); return }
    setBusy(true); setError(undefined); setStatus(undefined)
    try {
      const originalBytes = new Uint8Array(await file.arrayBuffer())
      if (request !== openRequest.current) return
      if (originalBytes.byteLength > CRYSTAL_SAVE_LIMITS.maxFileBytes) throw new Error('This file exceeds the 64 MiB save editor limit.')
      let next: OpenSave
      const version = crystalSaveVersion(originalBytes[0])
      if (!isSupportedCrystalSaveVersion(version)) next = { filename: file.name, originalBytes, issue: `Save format ${version} is newer than the inspected native reader. Supported formats are ${CRYSTAL_SAVE_MIN_VERSION} to ${CRYSTAL_SAVE_VERSION}. The original file is available unchanged.` }
      else {
        const original = decodeCrystalSave(originalBytes)
        next = { filename: file.name, originalBytes, original, draft: original }
      }
      setOpened(next); setPending({}); setRevision(0); setExportedRevision(0); setReview(undefined)
      setQuery(''); setInventoryKind('all'); setStockFilter('all'); setInventoryLimit(INVENTORY_PAGE_SIZE)
      setStatus('Save opened. The original remains unchanged.')
    } catch (reason) { if (request === openRequest.current) setError(`${errorMessage(reason)}${opened ? ' The open draft has not changed.' : ''}`) }
    finally { if (request === openRequest.current) setBusy(false) }
  }

  function exportEdited() {
    if (!opened?.draft || !summary?.editable || busy) return false
    if (hasPending) { setError('Apply or discard pending input before exporting. Pending input has not been included in the draft.'); return false }
    if (review) { setError('Apply or cancel the reviewed changes before exporting.'); return false }
    try {
      const now = new Date()
      const exported = changes.length && opened.draft.header.lastUpdated ? {
        ...opened.draft,
        header: { ...opened.draft.header, lastUpdated: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(), hour: now.getUTCHours(), minute: now.getUTCMinutes(), second: now.getUTCSeconds() } },
      } : opened.draft
      const bytes = encodeCrystalSave(exported)
      downloadBytes(bytes, exportFilename(opened.filename))
      setExportedRevision(revision); setError(undefined); setStatus('Download started. Keep the original as a backup before replacing a game save.')
      onDraftChange?.(false)
      return true
    } catch (reason) { setError(`Export failed: ${errorMessage(reason)}`); return false }
  }

  function downloadOriginal() {
    if (!opened) return
    try {
      downloadBytes(opened.originalBytes, `original-${opened.filename}`)
      setError(undefined); setStatus('Original download started. The draft and pending input have not changed.')
    } catch (reason) { setError(`Original download failed: ${errorMessage(reason)}`) }
  }

  function prepareReview(action: typeof BULK_ACTIONS[number], trigger: HTMLButtonElement) {
    if (!opened?.draft || locked || hasPending) return
    try {
      const draft = editSave(opened.draft, SAVE_EDITOR_CATALOG, { type: action.type })
      reviewTrigger.current = trigger
      setReview({ title: action.title, draft, changes: previewSaveChanges(opened.draft, draft, SAVE_EDITOR_CATALOG) })
      setError(undefined); setStatus(undefined)
    } catch (reason) { setError(errorMessage(reason)) }
  }

  function applyReview() {
    if (!review || !opened) return
    setOpened({ ...opened, draft: review.draft })
    if (review.changes.length) setRevision(value => value + 1)
    setReview(undefined); setError(undefined); setStatus('Reviewed changes applied. Export a save to use them in the game.')
  }

  return <div className="save-editor">
    <ScreenHeader eyebrow="Tools" title="Save editor" description="Edit a Crystal Project save in your browser, then download a separate copy." unsavedObject={dirty} actions={<><Button tone="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>{opened ? 'Open another save' : 'Open save'}</Button>{opened?.draft && <Button disabled={locked || hasPending} icon="download" onClick={exportEdited}>Export edited save</Button>}</>}/>
    <input className="save-editor__file-input" type="file" accept=".sav,application/octet-stream" aria-label="Open Crystal Project save" ref={fileInput} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void openFile(file) }}/>
    {!opened && <section className="save-editor__panel save-editor__intro"><div><h2>A save with room to experiment</h2><p>Change party members, add inventory, unlock classes, or preview the overpowered preset. Open a <code>.sav</code> file to get started.</p><Button disabled={busy} onClick={() => fileInput.current?.click()}>Choose a save file</Button></div><div className="save-editor__scope"><strong>Browser-local, original preserved</strong><p>Your file stays in this tab. Nothing is uploaded or added to your Playthrough. Closing the editor discards its session; export the changes you want to keep.</p><p>Open and edit every save format recognized by the native reader, including legacy saves. Exports keep the original format. Unsupported game configurations remain read-only.</p></div></section>}
    {busy && <InlineNotice title="Opening save">Reading and validating the selected file...</InlineNotice>}
    {error && <InlineNotice title="Save editor needs attention" tone="danger">{error}</InlineNotice>}
    {status && !error && <p className="save-editor__note" role="status">{status}</p>}
    {opened && <>
      <section className="save-editor__panel" aria-label="Open save details"><div className="save-editor__file-heading"><h2>{opened.filename}</h2><span className="save-editor__state">{dirty ? 'Changes not exported' : revision > 0 ? 'Draft exported' : 'Original open'}</span></div><dl className="save-editor__facts"><div><dt>Original size</dt><dd>{opened.originalBytes.byteLength.toLocaleString()} bytes</dd></div><div><dt>Save format</dt><dd>{opened.original?.header.version ?? crystalSaveVersion(opened.originalBytes[0])}</dd></div><div><dt>Editing rules</dt><dd>Windows PC 1.6.9</dd></div>{opened.original && <><div><dt>Saved date</dt><dd>{savedDate(opened.original)}</dd></div><div><dt>Play time</dt><dd>{playTime(opened.original)}</dd></div></>}{summary && <><div><dt>Party</dt><dd>{summary.members.length} members</dd></div><div><dt>Stored maps</dt><dd>{summary.mapCount}</dd></div><div><dt>Level cap</dt><dd>{summary.levelCap}</dd></div></>}</dl><div className="save-editor__actions" style={{ marginTop: 16 }}><Button tone="secondary" onClick={downloadOriginal}>Download original</Button>{opened.draft && <Button tone="quiet" disabled={busy || (!changes.length && !hasPending && !review)} onClick={() => { if (window.confirm('Reset all draft edits and pending input to the original save?')) resetDraft() }}>Reset to original</Button>}</div></section>
      {(opened.issue || summary && !summary.editable) && <InlineNotice title="Read-only save" tone="warning">{opened.issue ?? <><p>The editor cannot safely apply its base-game rules to this save.</p><ul className="save-editor__error-list">{summary!.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></>}</InlineNotice>}
      {hasPending && <InlineNotice title="Pending input"><div className="save-editor__pending"><p>Apply the edited fields before reviewing bulk changes or exporting.</p><Button tone="secondary" disabled={busy} onClick={() => { setPending({}); setError(undefined) }}>Discard pending input</Button></div></InlineNotice>}
      {review && <section className="save-editor__panel save-editor__preview" aria-label="Review bulk changes"><h2 ref={previewHeading} tabIndex={-1}>Review: {review.title}</h2><p>These changes compare your draft with the proposed result. Apply them to the draft, then export when ready.</p>{review.changes.length ? <ul className="save-editor__changes">{review.changes.map((change, index) => <li key={index}>{change}</li>)}</ul> : <p>The draft already matches this preset.</p>}<div className="save-editor__actions"><Button disabled={busy || !review.changes.length} onClick={applyReview}>Apply reviewed changes</Button><Button tone="secondary" onClick={() => { setReview(undefined); setError(undefined) }}>Cancel review</Button></div></section>}
      {summary && <>
        <section className="save-editor__panel" aria-label="Money"><h2>Money</h2><form className="save-editor__money" onSubmit={event => { event.preventDefault(); try { apply({ type: 'currency', value: wholeNumber(pending.currency ?? String(summary.currency), 'Copper') }, ['currency']) } catch (reason) { setError(errorMessage(reason)) } }}><Field label="Copper" hint={`${currencyDisplay(summary.currency)} · maximum ${SAVE_EDITOR_MAX_CURRENCY.toLocaleString()} copper`}><input aria-label="Copper" inputMode="numeric" aria-invalid={invalidWholeNumber(pending.currency) || undefined} disabled={locked} value={pending.currency ?? String(summary.currency)} onChange={event => setField('currency', event.target.value, String(summary.currency))}/></Field><Button type="submit" tone="secondary" disabled={locked || pending.currency === undefined}>Apply currency</Button></form></section>
        <section className="save-editor__panel" aria-label="Party editor"><h2>Party</h2><p>Apply each member's changes to the draft. Changing class or subclass returns equipped gear to inventory; choose your loadout in-game. Changing the main class also uses it for future growth. Existing growth levels are retained.</p><div className="save-editor__members">{summary.members.map(member => {
          const prefix = `member.${member.index}.`
          const keys = ['name', 'level', 'jobId', 'subJobId'].map(key => `${prefix}${key}`)
          const memberPending = keys.some(key => pending[key] !== undefined)
          return <form className="save-editor__member" key={member.index} onSubmit={event => {
            event.preventDefault()
            try {
              apply({ type: 'member', index: member.index,
                ...(pending[`${prefix}name`] !== undefined ? { name: pending[`${prefix}name`] } : {}),
                ...(pending[`${prefix}level`] !== undefined ? { level: wholeNumber(pending[`${prefix}level`], 'Level') } : {}),
                ...(pending[`${prefix}jobId`] !== undefined ? { jobId: wholeNumber(pending[`${prefix}jobId`], 'Class') } : {}),
                ...(pending[`${prefix}subJobId`] !== undefined ? { subJobId: pending[`${prefix}subJobId`] === '' ? null : wholeNumber(pending[`${prefix}subJobId`], 'Subclass') } : {}),
              }, keys)
            } catch (reason) { setError(errorMessage(reason)) }
          }}><h3>{member.index + 1}. {member.name}</h3><div className="save-editor__fields"><Field label="Name"><input aria-label={`Member ${member.index + 1} name`} disabled={locked} value={pending[`${prefix}name`] ?? member.name} onChange={event => setField(`${prefix}name`, event.target.value, member.name)}/></Field><Field label="Level" hint={summary.levelCap < SAVE_EDITOR_MAX_LEVEL ? `Above ${summary.levelCap} enables the level-cap assist, up to ${SAVE_EDITOR_MAX_LEVEL}` : `1 to ${SAVE_EDITOR_MAX_LEVEL}`}><input aria-label={`Member ${member.index + 1} level`} inputMode="numeric" aria-invalid={invalidWholeNumber(pending[`${prefix}level`]) || undefined} disabled={locked} value={pending[`${prefix}level`] ?? String(member.level)} onChange={event => setField(`${prefix}level`, event.target.value, String(member.level))}/></Field><Field label="Class"><select aria-label={`Member ${member.index + 1} class`} disabled={locked} value={pending[`${prefix}jobId`] ?? String(member.jobId)} onChange={event => setField(`${prefix}jobId`, event.target.value, String(member.jobId))}>{!CHOICES.jobs.some(job => job.id === member.jobId) && <option value={member.jobId}>Unknown class #{member.jobId}</option>}{CHOICES.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></Field><Field label="Subclass"><select aria-label={`Member ${member.index + 1} subclass`} disabled={locked} value={pending[`${prefix}subJobId`] ?? (member.subJobId === null ? '' : String(member.subJobId))} onChange={event => setField(`${prefix}subJobId`, event.target.value, (member.subJobId === null ? '' : String(member.subJobId)))}><option value="">None</option>{member.subJobId !== null && !CHOICES.jobs.some(job => job.id === member.subJobId) && <option value={member.subJobId}>Unknown class #{member.subJobId}</option>}{CHOICES.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></Field></div><p className="save-editor__member-summary">{member.unlockedJobs} classes unlocked · {member.masteredJobs} mastered<br/>{member.learnedAbilities} abilities · {member.learnedPassives} passives learned</p><Button type="submit" tone="secondary" disabled={locked || !memberPending}>Apply member {member.index + 1}</Button></form>
        })}</div></section>
        {summary.editable && <section className="save-editor__panel" aria-label="Unlocks and presets"><h2>Unlocks and presets</h2><p>Review every bulk change before applying it to the draft.</p><div className="save-editor__bulk">{BULK_ACTIONS.map(action => <article key={action.type} className={action.type === 'overpowered' ? 'save-editor__power' : undefined}><h3>{action.title}</h3><p>{action.description}</p><Button tone="secondary" disabled={locked || hasPending} onClick={event => prepareReview(action, event.currentTarget)}>{action.button}</Button></article>)}</div></section>}
        <section className="save-editor__panel" aria-label="Inventory editor"><h2>Inventory</h2><p>Edit carried stock, including items absent from the save. Equipment limits account for copies the party has equipped.</p><div className="save-editor__inventory-tools"><Field label="Search inventory"><input type="search" value={query} placeholder="Item name or ID" onChange={event => { setQuery(event.target.value); setInventoryLimit(INVENTORY_PAGE_SIZE) }}/></Field><Field label="Inventory category"><select value={inventoryKind} onChange={event => { setInventoryKind(event.target.value); setInventoryLimit(INVENTORY_PAGE_SIZE) }}><option value="all">All categories</option><option value="item">Items</option><option value="equipment">Equipment</option></select></Field><Field label="Stock filter"><select value={stockFilter} onChange={event => { setStockFilter(event.target.value); setInventoryLimit(INVENTORY_PAGE_SIZE) }}><option value="all">All stock</option><option value="carried">Carried stock only</option></select></Field></div><p className="save-editor__note" role="status">{inventory.length.toLocaleString()} matching entries</p><div className="save-editor__inventory-list">{inventory.slice(0, inventoryLimit).map(row => {
          const key = `stock.${row.kind}.${row.id}`
          return <form className="save-editor__inventory-row" key={key} onSubmit={event => { event.preventDefault(); try { apply({ type: 'stock', kind: row.kind, id: row.id, count: wholeNumber(pending[key] ?? String(row.count), `${row.name} stock`) }, [key]) } catch (reason) { setError(errorMessage(reason)) } }}><div><strong>{row.name}</strong><small>{row.kind === 'item' ? 'Item' : 'Equipment'} #{row.id} · stock limit {row.capacity}{row.equipped ? ` · ${row.equipped} equipped` : ''}</small></div><Field label="Stock"><input aria-label={`${row.name} stock`} inputMode="numeric" aria-invalid={invalidWholeNumber(pending[key]) || undefined} disabled={locked} value={pending[key] ?? String(row.count)} onChange={event => setField(key, event.target.value, String(row.count))}/></Field><Button aria-label={`Apply ${row.name} stock`} type="submit" tone="secondary" disabled={locked || pending[key] === undefined}>Apply</Button></form>
        })}</div>{!inventory.length && <p>No matching items. Try another name, ID, or filter.</p>}{inventory.length > inventoryLimit && <Button tone="secondary" onClick={() => setInventoryLimit(value => value + INVENTORY_PAGE_SIZE)}>Show more inventory ({inventory.length - inventoryLimit} remaining)</Button>}</section>
      </>}
      {opened.draft && <details className="save-editor__panel save-editor__review" open><summary>Original to draft review{changes.length ? ` (${changes.length})` : ''}</summary>{changes.length ? <ul className="save-editor__changes">{changes.map((change, index) => <li key={index}>{change}</li>)}</ul> : <p>The draft matches the original save.</p>}<div className="save-editor__actions"><Button disabled={locked || hasPending} icon="download" onClick={exportEdited}>Export edited save</Button><small>A separate .sav download. The original file stays unchanged.</small></div></details>}
      <p className="save-editor__note">This session lives in this tab. Editing uses base-game Windows PC 1.6.9 rules. A save format number does not identify the game version or platform that created the file. Download your original before replacing a game save, and close the game while replacing it.</p>
    </>}
  </div>
}
