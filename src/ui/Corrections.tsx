import { useRef, useState, type ChangeEvent } from 'react'
import { activeCorrections, correctionExportClosure, CORRECTION_DECISIONS, CORRECTION_STATUS_LABELS, MAX_CORRECTION_BYTES, correctionKey, correctionReviewIssues, correctionSource, correctionStatus, mergeCorrections, sameCorrectionValue, type CatalogCorrection } from '../domain/corrections'
import { exportCorrections, readCorrections } from '../interchange/corrections'
import { Badge, Button, Field, InlineNotice } from './components'
import { CorrectionDiff, CorrectionEditor } from './CorrectionEditor'
import { KnowledgeValue, SourceReferences } from './KnowledgeValue'
import { useCorrections } from './corrections-context'
import { downloadBytes, formatAppError } from './model'
import { routeWithOverlay, useNavigation } from './navigation'
import { Sheet } from './Sheet'

const CORRECTION_PAGE_SIZE = 30

export function CorrectionsButton() {
  const navigation = useNavigation()
  const { collection } = useCorrections()
  return <Button icon="edit" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'corrections' }))} tone="secondary">Corrections{activeCorrections(collection.entries).filter(entry => entry.changes.length).length ? ` (${activeCorrections(collection.entries).filter(entry => entry.changes.length).length})` : ''}</Button>
}

function Provenance({ entry }: { entry: CatalogCorrection }) {
  return <><dl className="correction-provenance">{[['Decision', CORRECTION_DECISIONS[entry.decision]], ['Why', entry.reason], ['Evidence', entry.evidence], ['Platform', entry.context.platform], ['Game version', entry.context.gameVersion], ['Mods / applicability', entry.context.mods]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Not recorded yet'}</dd></div>)}</dl>{entry.baselineClaims.length > 0 && <details><summary>Other original source claims</summary>{entry.baselineClaims.map((claim, index) => <div className="correction-baseline" key={`${claim.field}:${index}`}><strong>{claim.field}</strong><KnowledgeValue showSources value={claim.value}/><SourceReferences sources={claim.sources}/></div>)}</details>}</>
}

function CorrectionsManager({ layer }: { layer: number }) {
  const navigation = useNavigation()
  const { collection, baseline, save, error: loadError } = useCorrections()
  const [selected, setSelected] = useState(() => new Set(activeCorrections(collection.entries).filter(entry => entry.changes.length).map(entry => entry.id)))
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(CORRECTION_PAGE_SIZE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [removed, setRemoved] = useState<{ entry: CatalogCorrection; resetId: string }>()
  const [incoming, setIncoming] = useState<readonly CatalogCorrection[]>()
  const [importRevision, setImportRevision] = useState(0)
  const [importSelection, setImportSelection] = useState<ReadonlySet<string>>(new Set())
  const fileInput = useRef<HTMLInputElement>(null)
  const active = activeCorrections(collection.entries)
  const filtered = active.filter(entry => `${entry.baselineName} ${entry.reason} ${entry.evidence}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selectedActiveIds = new Set(active.filter(entry => correctionExportClosure(collection.entries, new Set([entry.id])).some(ancestor => selected.has(ancestor.id))).map(entry => entry.id))
  const selectedEntries = correctionExportClosure(collection.entries, selectedActiveIds)
  const previewRegistry = incoming ? [...collection.entries.filter(local => !incoming.some(entry => entry.id === local.id)), ...incoming] : collection.entries
  const selectEntry = (entry: CatalogCorrection) => setSelected(current => {
    if (!selectedActiveIds.has(entry.id)) return new Set([...current, entry.id])
    const ancestors = new Set(correctionExportClosure(collection.entries, new Set([entry.id])).map(value => value.id))
    return new Set([...current].filter(id => !ancestors.has(id)))
  })
  const toggle = (key: string, current: ReadonlySet<string>) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next }
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try { await operation() } catch (reason) { setError(formatAppError(reason, 'The correction operation failed.')) } finally { setBusy(false) }
  }
  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    await run(async () => {
      if (file.size > MAX_CORRECTION_BYTES) throw new Error('Choose a corrections JSON file of at most 4 MiB.')
      const entries = readCorrections(new Uint8Array(await file.arrayBuffer()))
      setIncoming(entries)
      setImportRevision(collection.revision)
      setImportSelection(new Set(entries.filter(entry => !collection.entries.some(local => local.id === entry.id) && !correctionExportClosure(entries, new Set([entry.id])).some(ancestor => ancestor.supersedes.some(id => active.some(local => local.id === id)))).map(entry => entry.id)))
      setMessage(undefined)
    })
  }
  const importSelected = () => run(async () => {
    const entries = incoming ? correctionExportClosure(incoming, importSelection) : []
    await save(mergeCorrections(collection.entries, entries), importRevision)
    setIncoming(undefined)
    setSelected(current => new Set([...current, ...entries.map(entry => entry.id)]))
    setMessage('Corrections imported locally.')
  })
  const restore = (entry: CatalogCorrection) => run(async () => {
    const resetId = crypto.randomUUID()
    await save(mergeCorrections(collection.entries, [{ ...entry, id: resetId, supersedes: active.filter(value => correctionKey(value) === correctionKey(entry)).map(value => value.id), updatedAt: new Date().toISOString(), changes: [] }]), collection.revision)
    setRemoved({ entry, resetId })
    setMessage(`${entry.baselineName} restored to the baseline.`)
  })
  const download = () => {
    try {
      downloadBytes(exportCorrections(selectedEntries), 'crystal-companion-corrections.json', 'application/json')
      setMessage('Selected corrections exported. You can keep editing locally.')
      setError(undefined)
    } catch (reason) { setError(formatAppError(reason, 'The corrections could not be exported.')) }
  }
  return <Sheet description="Small fixes, collected as you play. Review and export them when you are ready to improve the shared reference." layer={layer} onClose={() => navigation.close()} onRequestClose={() => !busy} open title="Corrections" width="wide"><div className="stack">
    {(error || loadError) && <InlineNotice title="Corrections unchanged" tone="danger">{error ?? loadError}</InlineNotice>}
    {message && <div className="correction-message" role="status"><span>{message}</span>{removed && active.some(entry => entry.id === removed.resetId) && <Button disabled={busy} onClick={() => void run(async () => { await save(mergeCorrections(collection.entries, [{ ...removed.entry, id: crypto.randomUUID(), supersedes: [removed.resetId], updatedAt: new Date().toISOString() }]), collection.revision); setRemoved(undefined); setMessage('Correction restored.'); })} tone="quiet">Undo restore</Button>}</div>}
    {incoming ? <section className="stack" aria-label="Correction import preview"><div className="split"><h3>Review incoming corrections</h3><Button disabled={busy} onClick={() => setIncoming(undefined)} tone="quiet">Cancel import</Button></div><p className="settings-section__intro">New decisions are selected. Competing decisions are held for an explicit choice; importing never chooses a winner.</p>{incoming.length === 0 && <p>This file has no corrections.</p>}{incoming.map(entry => {
      const key = entry.id
      const local = collection.entries.find(value => value.id === key)
      const identical = local && sameCorrectionValue(local, entry)
      return <article className="correction-card" key={key}><label className="check-row"><input checked={importSelection.has(key)} disabled={busy || Boolean(identical)} onChange={() => setImportSelection(current => toggle(key, current))} type="checkbox"/><span><strong>{entry.baselineName}</strong><small>{identical ? 'Already saved locally' : local ? 'This ID has changed content and cannot replace the original' : correctionExportClosure(incoming, new Set([entry.id])).some(ancestor => ancestor.supersedes.some(id => active.some(saved => saved.id === id))) ? 'Select to explicitly supersede saved decisions' : CORRECTION_STATUS_LABELS[correctionStatus(entry, baseline, previewRegistry)]}</small></span></label><details><summary>Compare changes & evidence</summary>{local && !identical && <><h4>My local correction</h4><CorrectionDiff changes={local.changes}/><Provenance entry={local}/><h4>Incoming correction</h4></>}<CorrectionDiff changes={entry.changes}/><Provenance entry={entry}/></details></article>
    })}{collection.revision !== importRevision && <InlineNotice title="Preview needs refreshing" tone="warning">Corrections changed after this preview. Cancel and choose the file again to compare against the latest local values.</InlineNotice>}<Button disabled={busy || Boolean(loadError) || !importSelection.size || collection.revision !== importRevision} icon="check" onClick={() => void importSelected()}>{busy ? 'Importing...' : `Import selected (${importSelection.size})`}</Button></section> : <>
      <div className="split"><p className="settings-section__intro">{active.length ? `${active.length} saved locally across your playthroughs` : 'No corrections yet. Turn on Edit reference and click a fact to make your first fix.'}</p><Button disabled={busy || Boolean(loadError)} icon="upload" onClick={() => fileInput.current?.click()} tone="quiet">Import corrections</Button></div>
      <input accept=".json,application/json" aria-label="Choose corrections file" className="sr-only" onChange={event => void chooseFile(event)} ref={fileInput} type="file"/>
      {collection.entries.length > 0 && <><div className="correction-toolbar"><Field label="Find a correction"><input onChange={event => { setQuery(event.target.value); setLimit(CORRECTION_PAGE_SIZE) }} placeholder="Search your corrections" type="search" value={query}/></Field><Button onClick={() => setSelected(new Set(filtered.map(entry => entry.id)))} tone="quiet">Select matches</Button><Button onClick={() => setSelected(new Set())} tone="quiet">Clear selection</Button></div>
        <div className="correction-list">{filtered.slice(0, limit).map(entry => {
          const key = entry.id
          const status = correctionStatus(entry, baseline, collection.entries)
          const issues = correctionReviewIssues(entry, baseline, collection.entries)
          return <article className="correction-card" key={key}><div className="split"><label className="check-row"><input checked={selectedActiveIds.has(key)} onChange={() => selectEntry(entry)} type="checkbox"/><span><strong>{entry.baselineName}</strong><small>{entry.changes.length} {entry.changes.length === 1 ? 'change' : 'changes'} · {entry.confidence === 'tentative' ? 'Tentative' : 'Confirmed by you'}</small></span></label><Badge tone={status === 'applied' ? 'info' : status === 'included' ? 'positive' : 'warning'}>{CORRECTION_STATUS_LABELS[status]}</Badge></div><details><summary>Changes & evidence</summary><CorrectionDiff changes={entry.changes}/><Provenance entry={entry}/><p className="settings-section__intro">{issues.length ? `To prepare a submission: ${issues.join('; ')}.` : 'Provenance recorded. A maintainer can review this for inclusion in the baseline.'}</p><small>Source: {entry.target.catalogId} · {entry.target.catalogRevisionId} · {entry.target.entityId}</small></details><div className="cluster"><Button disabled={busy || Boolean(loadError) || status === 'competing' || !correctionSource(baseline, entry.target)} icon="edit" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'correction-editor', ref: entry.target }))} tone="quiet">{status === 'review' ? 'Review baseline change' : 'Edit'}</Button><Button disabled={busy || Boolean(loadError) || !entry.changes.length} icon="history" onClick={() => void restore(entry)} tone="quiet">Restore baseline</Button>{status === 'competing' && <Button disabled={busy} onClick={() => void run(async () => { await save(mergeCorrections(collection.entries, [{ ...entry, id: crypto.randomUUID(), supersedes: active.filter(value => correctionKey(value) === correctionKey(entry)).map(value => value.id), updatedAt: new Date().toISOString() }]), collection.revision); setMessage('Decision saved with explicit supersession.'); })} tone="secondary">Use this decision</Button>}</div></article>
        })}</div>{filtered.length > limit && <Button onClick={() => setLimit(value => value + CORRECTION_PAGE_SIZE)} tone="quiet">Show more corrections</Button>}
        <section className="correction-export"><div><h3>Take your corrections with you</h3><p>Exports the selected changes, original values, evidence, and superseded decisions needed to explain them. No playthrough records or source files are included. Review your own text before sharing.</p><small>This file is safe to separate from your playthrough backup. Full backups also retain correction history.</small></div><Button disabled={!selectedEntries.length || busy || Boolean(loadError)} icon="download" onClick={download}>Export selected ({selectedActiveIds.size})</Button></section>
      </>}
    </>}
  </div></Sheet>
}

export function CorrectionSurfaces() {
  const { route } = useNavigation()
  const managerIndex = route.overlays.findIndex(overlay => overlay.kind === 'corrections')
  const editorIndex = route.overlays.findLastIndex(overlay => overlay.kind === 'correction-editor')
  const editor = route.overlays[editorIndex]
  return <>{managerIndex >= 0 && <CorrectionsManager layer={managerIndex + 1}/>} {editor?.kind === 'correction-editor' && <CorrectionEditor initialField={editor.field} key={`${correctionKey({ target: editor.ref })}:${editor.field ?? ''}`} layer={editorIndex + 1} target={editor.ref}/>}</>
}
