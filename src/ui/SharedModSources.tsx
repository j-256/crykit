import { useMemo, useState } from 'react'
import { jsonRecord } from '../domain/crystal-edit'
import { entityDefinitionKey } from '../domain/core'
import { modSourceInterpretationMatches, modSourceMatch } from '../domain/mod-source-match'
import type { BuildReferenceName, CatalogSnapshot, LocalData, ModSourceReceipt } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import type { ImportPreview } from '../interchange/types'
import { buildDefinitionOptions } from './definitions'
import { BuildSelectionDetails } from './BuildSelectionDetails'
import { Field, InlineNotice } from './components'
import { formatAppError } from './model'

const MAX_SHARED_MOD_FILE_BYTES = 32 * 1024 * 1024

export function SharedModSources({ localData, catalogs, importNotice, onImport, onArtwork }: { readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly importNotice?: string; readonly onImport: (preview: ImportPreview) => Promise<void>; readonly onArtwork: (entry: BuildReferenceName, file: File | undefined) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const receipts = useMemo(() => [...new Map(Object.values(localData.gameSetups).flatMap(setup => setup.modSourceReceipts ?? []).map(receipt => [JSON.stringify([receipt.catalogId, receipt.catalogRevisionId]), receipt])).values()], [localData])
  const entries = useMemo(() => [...new Map(Object.values(localData.buildRevisions).flatMap(revision => revision.content.referenceNames ?? []).map(entry => [entityDefinitionKey(entry.ref), entry])).values()], [localData])
  const importFile = async (receipt: ModSourceReceipt, file: File) => {
    setBusy(true)
    setError(undefined)
    try {
      if (file.size > MAX_SHARED_MOD_FILE_BYTES) throw new Error('This mod file exceeds the 32 MB import limit.')
      const preview = await previewCrystalEdit(new Uint8Array(await file.arrayBuffer()), file.name)
      const catalog = preview.proposed.catalogs[0]
      if (!catalog || !modSourceMatch(receipt, catalog)) throw new Error('This JSON does not match the saved mod content and project identity. Your saved records are unchanged.')
      await onImport(preview)
    } catch (reason) { setError(formatAppError(reason, 'The matching mod could not be imported.')) }
    finally { setBusy(false) }
  }
  if (!receipts.length) return null
  return <section aria-label="Mod sources" className="panel"><header className="panel__header"><h2>Mod sources</h2></header><div className="panel__body stack">
    <p>The snapshot keeps selected names and identities. Import your matching JSON to inspect its definitions. Formatting and object-key order can differ; source content and array order must match.</p>
    {error && <InlineNotice title="Mod not imported" tone="danger">{error}</InlineNotice>}
    {busy && <p role="status">Checking and saving matching JSON...</p>}
    {importNotice && !error && !busy && <p role="status">{importNotice}</p>}
    {receipts.map(receipt => {
      const matching = catalogs.filter(catalog => modSourceMatch(receipt, catalog))
      const source = matching.find(catalog => catalog.revisionId === receipt.catalogRevisionId) ?? matching[0]
      const exact = source?.revisionId === receipt.catalogRevisionId
      const options = source ? buildDefinitionOptions(localData, [source]) : []
      const identities = source && jsonRecord(source.legacy) && jsonRecord(source.legacy.crystalEditIdentities) ? source.legacy.crystalEditIdentities : {}
      return <div className="stack" key={JSON.stringify([receipt.catalogId, receipt.catalogRevisionId])}>
        <h3>{receipt.title}</h3>
        <p>{source ? exact ? 'The saved source revision is available.' : modSourceInterpretationMatches(receipt, source) ? 'Matching content is available in another file revision.' : 'Matching JSON is saved. The original checkpoint uses an older interpretation; the recovered preview uses the imported definitions.' : 'Definitions are unavailable until you supply the matching source.'}</p>
        <Field label={`Matching JSON for ${receipt.title}`}><input accept=".json,application/json" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(receipt, file) }} type="file"/></Field>
        <details><summary>Source identity</summary><dl className="definition-list"><div><dt>Project</dt><dd>{receipt.catalogId}</dd></div><div><dt>Saved revision</dt><dd>{receipt.catalogRevisionId}</dd></div>{receipt.contentFingerprint && <div><dt>Content fingerprint</dt><dd>{receipt.contentFingerprint}</dd></div>}</dl></details>
        {entries.filter(entry => entry.projectId === receipt.catalogId).map(entry => {
          const entityId = entry.modelKey ? identities[entry.modelKey] : undefined
          const option = options.find(option => option.ref.kind === 'catalog' && option.ref.entityId === entityId)
          return <details key={entityDefinitionKey(entry.ref)}><summary>{entry.name}</summary><div className="stack"><p>{entry.modelKey}</p>{option ? <><p>Definition from your local JSON</p><BuildSelectionDetails catalogs={source ? [source] : []} localData={localData} option={option}/></> : <p>Definition unavailable. The saved name does not supply stats or effects.</p>}<Field label={`Local artwork for ${entry.name}`}><input accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; onArtwork(entry, file) }} type="file"/></Field></div></details>
        })}
      </div>
    })}
    <p className="field__hint">Artwork stays in this view. Imported JSON is saved in this browser. Save a copy keeps the source versions used by the preview; the original link stays unchanged.</p>
  </div></section>
}
