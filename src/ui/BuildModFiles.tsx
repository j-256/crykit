import { modSourceMatch } from '../domain/mod-source-match'
import type { CatalogSnapshot, GameSetupRevision } from '../domain/types'
import { Button } from './components'
import './build-mod-files.css'

export function BuildModFiles({ setup, catalogs, onOpen, disabled = false }: { readonly setup: GameSetupRevision; readonly catalogs: readonly CatalogSnapshot[]; readonly onOpen?: () => void; readonly disabled?: boolean }) {
  const receipts = setup.modSourceReceipts
  if (!onOpen || !receipts?.length) return null
  // This lists the setup's recorded sources, not inferred dependencies of individual selections
  const missing = receipts.filter(receipt => !catalogs.some(catalog => modSourceMatch(receipt, catalog)))
  return <section aria-label="Build mod files" className="build-mod-files">
    <div><h3>Mod files</h3><p>{missing.length ? `Upload matching JSON for: ${missing.map(receipt => receipt.title).join(', ')}.` : 'Matching JSON is available in this browser.'}</p></div>
    <Button disabled={disabled} className="build-mod-files__upload" icon="upload" onClick={onOpen} tone="secondary" type="button">Upload mod JSON</Button>
  </section>
}
