import type { Ref } from 'react'
import { publicKnowledge } from '../domain/public-source-context'
import type { PublicEnrichedEntry, PublicEnrichment } from '../interchange/public-share-enrichment'
import { publicRefKey, type PublicSnapshot } from '../interchange/public-share-schema'
import { Field } from './components'
import { decisionFacts } from './build-evidence'
import { KnowledgeValue } from './KnowledgeValue'
import { PrivateArtwork } from './mods/PrivateArtwork'

export function PublicSelectionEvidence({ entry }: { readonly entry?: PublicEnrichedEntry }) {
  if (!entry?.definition) return <p>Definition unavailable. The saved name supplies no mechanics.</p>
  return <div className="stack">
    {entry.viewerRef?.kind === 'catalog' && entry.artwork && <PrivateArtwork catalogId={entry.viewerRef.catalogId} catalogRevisionId={entry.viewerRef.catalogRevisionId} entity={{ ...entry.definition, id: entry.viewerRef.entityId }} detailed fallback={null}/>}
    {entry.definition.rawDescription && <p>{entry.definition.rawDescription}</p>}
    <dl className="definition-list">{decisionFacts(entry.definition).map(({ label, value }) => <div className="definition-row" key={label}><dt>{label}</dt><dd><KnowledgeValue value={value}/></dd></div>)}</dl>
  </div>
}

export function PublicShareSources({ snapshot, enrichment, open, onToggle, detailsRef, canImport, busy, ready, onImport }: {
  readonly snapshot: PublicSnapshot
  readonly enrichment?: PublicEnrichment
  readonly open: boolean
  readonly onToggle: (open: boolean) => void
  readonly detailsRef: Ref<HTMLDetailsElement>
  readonly canImport: boolean
  readonly busy: boolean
  readonly ready: boolean
  readonly onImport: (layer: PublicSnapshot['setup']['layers'][number], file: File) => void
}) {
  return <details aria-label="Game Setup and sources" className="share-sources" open={open} onToggle={event => onToggle(event.currentTarget.open)} ref={detailsRef} tabIndex={-1}>
    <summary>Game Setup &amp; sources</summary>
    <div className="stack share-sources__body">
      {enrichment && <p role="status">{enrichment.resolved ? 'All selected definitions are available.' : 'Some selected definitions or sources are unavailable.'}</p>}
      <dl className="definition-list">
        <div className="definition-row"><dt>Mode</dt><dd><KnowledgeValue value={publicKnowledge(snapshot.setup.mode)}/></dd></div>
        <div className="definition-row"><dt>Difficulty</dt><dd><KnowledgeValue value={publicKnowledge(snapshot.setup.difficulty ?? { state: 'unknown' })}/></dd></div>
        <div className="definition-row"><dt>Passive PP limit</dt><dd><KnowledgeValue value={publicKnowledge(snapshot.setup.ppLimit ?? { state: 'unknown' })}/></dd></div>
        <div className="definition-row"><dt>Nonnegative PP costs</dt><dd><KnowledgeValue value={publicKnowledge(snapshot.setup.ppCostsNonNegative)}/></dd></div>
      </dl>
      <section aria-label="Required sources"><h3>Required sources</h3>
        {snapshot.setup.baseline && <p>Baseline: {snapshot.setup.baseline.catalogId} · {snapshot.setup.baseline.catalogRevisionId}</p>}
        {!snapshot.setup.layers.length && <p>No mod sources required.</p>}
        {snapshot.receipts.some(receipt => receipt.ref.kind === 'personal') && <p>Selected personal definitions require matching content fingerprints.</p>}
        {snapshot.setup.layers.length > 0 && <section aria-label="Matching sources" className="stack">{snapshot.setup.layers.map(layer => <div className="share-sources__file" key={JSON.stringify([layer.catalogId, layer.catalogRevisionId])}>
          <h4>{layer.title}</h4><p className="field__hint">{layer.catalogId} · {layer.catalogRevisionId}</p>
          <p>{!enrichment ? 'Reading your library...' : enrichment.missingSources.some(source => source.catalogId === layer.catalogId && source.catalogRevisionId === layer.catalogRevisionId) ? 'This exact source is missing from your library.' : 'Matching content is available in your library.'}</p>
          {canImport && <Field label={`Matching JSON for ${layer.title}`}><input type="file" accept=".json,application/json" disabled={busy || !ready} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) onImport(layer, file) }}/></Field>}
        </div>)}{busy && <p role="status">Saving matching source...</p>}{canImport && <p className="field__hint">Files are saved to your own library. Your active Playthrough and enabled mods stay unchanged.</p>}</section>}
      </section>
      {enrichment && <section aria-label="Your matching definitions"><h3>Selected definitions</h3><p className="field__hint">Available details come from matching sources in your library.</p>{enrichment.entries.map(entry => <details key={publicRefKey(entry.receipt.ref)}><summary>{entry.receipt.name}{!entry.definition && <span className="share-sources__unknown"> · Unavailable</span>}</summary><PublicSelectionEvidence entry={entry}/></details>)}</section>}
      <details><summary>Selected entry requirements</summary>{snapshot.receipts.map(receipt => <p key={publicRefKey(receipt.ref)}>{receipt.name} · {receipt.origin ? <>{receipt.origin.projectId} · {receipt.origin.sourceRevisionId} · {receipt.origin.catalogRevisionId}{receipt.origin.modelKey ? ` · ${receipt.origin.modelKey}` : ''}</> : 'Source identity unavailable'}</p>)}</details>
    </div>
  </details>
}
