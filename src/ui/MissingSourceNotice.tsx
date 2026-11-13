import { SOURCE_REVISION_RECEIPTS } from '../catalog/source-revisions'
import { fulfillSource } from '../domain/source-fulfillment'
import type { CatalogSnapshot, EntityRef } from '../domain/types'
import { Button, InlineNotice } from './components'
import './missing-source.css'

export function MissingSourceNotice({ reference, catalogs, onImport, onReturn }: {
  readonly reference?: EntityRef
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onImport: () => void
  readonly onReturn: () => void
}) {
  const exact = reference?.kind === 'catalog' ? reference : undefined
  const source = exact && fulfillSource(exact, catalogs)?.catalog
  const receipt = exact && SOURCE_REVISION_RECEIPTS.find(entry => entry.id === exact.catalogId && entry.revisionId === exact.catalogRevisionId)
  return <InlineNotice title={source ? 'Source record unavailable' : 'Exact source unavailable'} tone="warning">
    <p>{exact ? source ? 'This source revision does not contain the requested record.' : 'Import the matching source file or restore a supported backup containing this exact revision.' : 'Restore a supported backup containing this personal definition.'}</p>
    {exact && <dl className="missing-source-identity"><dt>Source</dt><dd>{exact.catalogId}</dd><dt>Revision</dt><dd>{exact.catalogRevisionId}</dd><dt>Record</dt><dd>{exact.entityId}</dd>{receipt && <><dt>Payload checksum</dt><dd>{receipt.checksum}</dd></>}</dl>}
    <Button onClick={onImport}>Import source or backup</Button> <Button onClick={onReturn} tone="quiet">Return to reference</Button>
  </InlineNotice>
}
