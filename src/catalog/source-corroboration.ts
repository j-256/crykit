import receipts from './source-corroboration.json' with { type: 'json' }
import { BUNDLED_CATALOGS } from './bundled'
import { sameCorrectionValue } from '../domain/corrections'
import { nativeIdentity, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import { bundledModIdentity } from '../domain/bundled-mods'
import type { CatalogEntity, CatalogSnapshot, Knowledge } from '../domain/types'

interface CorroborationReceipts {
  readonly proofs: readonly (readonly string[])[]
  readonly catalogs: readonly {
    readonly catalogId: string
    readonly revisionId: string
    readonly checksum: string
    readonly fields: Readonly<Record<string, Readonly<Record<string, number>>>>
  }[]
}

const key = (catalog: Pick<CatalogSnapshot, 'id' | 'revisionId' | 'checksum'>) => JSON.stringify([catalog.id, catalog.revisionId, catalog.checksum])
const baselines = new Map(BUNDLED_CATALOGS.map(catalog => [key(catalog), catalog]))
const audited = new Map((receipts as unknown as CorroborationReceipts).catalogs.map(catalog => [JSON.stringify([catalog.catalogId, catalog.revisionId, catalog.checksum]), catalog.fields]))

export interface CorroborationTarget {
  readonly catalog: CatalogSnapshot
  readonly entity: CatalogEntity
}

export function corroboratedFact(target: CorroborationTarget | undefined, field: string, knowledge: Knowledge<unknown>): boolean {
  if (!target || knowledge.state !== 'known') return false
  const catalogKey = key(target.catalog)
  const baseline = baselines.get(catalogKey)?.entities[target.entity.id]
  if (!baseline || baseline.kind !== target.entity.kind) return false
  if (baseline !== target.entity && !sameCorrectionValue(nativeIdentity(baseline), nativeIdentity(target.entity))) return false
  if (baseline.fields[field] !== knowledge && !sameCorrectionValue(baseline.fields[field], knowledge)) return false
  if (knowledge.sources?.length && knowledge.sources.every(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX))) return true
  if (bundledModIdentity(baseline) && knowledge.sources?.length && knowledge.sources.every(source => source.sourceId.startsWith('bundled-mod:') || source.sourceId.startsWith('crystal-edit-export:'))) return true
  const proof = audited.get(catalogKey)?.[target.entity.id]?.[field]
  return proof !== undefined && Boolean(receipts.proofs[proof]?.length)
}
