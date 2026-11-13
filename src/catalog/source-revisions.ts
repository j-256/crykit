import receipts from './source-revisions.json' with { type: 'json' }

export interface BundledSourceRevisionReceipt { readonly id: string; readonly revisionId: string; readonly checksum: string }

// Receipts outlive packaged bodies; exact historical definitions belong in saved workspace graphs
export const SOURCE_REVISION_RECEIPTS: readonly BundledSourceRevisionReceipt[] = Object.freeze(receipts.sources.map(receipt => Object.freeze(receipt)))
