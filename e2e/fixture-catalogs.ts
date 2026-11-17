import { sameValue } from '../src/domain/definition-values'
import { sourcePayloadValid } from '../src/domain/source-fulfillment'
import type { CatalogSnapshot } from '../src/domain/types'

export function retainFixtureCatalog(catalogs: readonly CatalogSnapshot[], required: CatalogSnapshot): readonly CatalogSnapshot[] {
  if (!sourcePayloadValid(required)) throw new Error('The required fixture source has an invalid complete payload')
  const matches = catalogs.filter(catalog => catalog.id === required.id && catalog.revisionId === required.revisionId)
  if (matches.length > 1 || matches.some(catalog => !sameValue(catalog, required))) throw new Error('The fixture source identity has a different or duplicate body')
  // Planner ZIPs trim unreferenced sources before the fixture introduces its new personal reference
  // Add only the exact supplied source, without replacing a body already bound to that identity
  return matches.length ? catalogs : [...catalogs, required]
}
