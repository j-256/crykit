import { corroboratedFact } from '../catalog/source-corroboration'
import { bundledModIdentity } from '../domain/bundled-mods'
import { catalogEntity } from '../domain/entity-identities'
import { nativeDisplayName } from '../domain/native-game'
import { classRatingField } from '../domain/stat-ratings'
import type { CatalogSnapshot, EntityRef, LocalData } from '../domain/types'
import { KnowledgeValue, SourceReferences } from './KnowledgeValue'
import { resolveEntity } from './model'
import { Sources } from './Sources'

export function PrimaryClassGrowth({ primaryClass, catalogs, localData }: { readonly primaryClass: EntityRef | null; readonly catalogs: readonly CatalogSnapshot[]; readonly localData: LocalData }) {
  // Growth follows the selected primary class, never a picker preview or sub-command
  if (!primaryClass) return null
  const primary = resolveEntity(localData, catalogs, primaryClass)
  const name = primary ? nativeDisplayName(primary) : 'Primary class'
  const [field, ratings] = classRatingField(primary ?? { fields: {} })
  const catalog = primaryClass.kind === 'catalog' ? catalogs.find(catalog => catalog.id === primaryClass.catalogId && catalog.revisionId === primaryClass.catalogRevisionId) : undefined
  const entity = catalog && primaryClass.kind === 'catalog' ? catalogEntity(catalog, primaryClass.entityId) : undefined
  const verified = entity && catalog && !bundledModIdentity(entity) && corroboratedFact({ catalog, entity }, field, ratings)
  const sources = ratings.state === 'conflicting' || ratings.state === 'notApplicable' || verified ? [] : ratings.sources ?? []
  const chart = <KnowledgeValue field={field} value={ratings}/>
  return <section aria-label={`${name} growth`} className="primary-class-growth"><h4>{name} growth</h4>{sources.length ? <Sources anchor={chart} label={`Sources for ${name} growth`}><SourceReferences includeGameExports sources={sources}/></Sources> : chart}</section>
}
