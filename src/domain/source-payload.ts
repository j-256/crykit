import type { CatalogSnapshot } from './types'

export function sourcePayloadContent(catalog: Omit<CatalogSnapshot, 'checksum'>) {
  const { payloadSource, ...content } = catalog
  // A bundle descriptor names an unchanged imported payload; its receipt binds both identities
  // Changing only the descriptor must never rewrite entities, citations, or interpretation metadata
  return payloadSource ? { ...content, id: payloadSource.catalogId, revisionId: payloadSource.catalogRevisionId } : content
}
