import { bundledModIdentity, bundledModRecord } from '../domain/bundled-mods'
import type { CatalogEntity } from '../domain/types'
import { SourceReferences } from './KnowledgeValue'

export function BundledModSourceDetails({ entity }: { entity: CatalogEntity }) {
  const identity = bundledModIdentity(entity)
  const record = bundledModRecord(entity)
  if (!identity || !record) return null
  return <div className="stack"><p>{identity.family} #{identity.modelId} · version {identity.version}</p><SourceReferences includeGameExports sources={entity.sources}/><details><summary>Complete mod source record</summary><pre className="native-source-record">{JSON.stringify(record, null, 2)}</pre></details></div>
}
