import worldJson from './world-acquisition-v1.json' with { type: 'json' }
import conditionJson from './acquisition-condition-facts.json' with { type: 'json' }
import receiptJson from './acquisition-guidance-receipts.json' with { type: 'json' }
import routeFactJson from './acquisition-route-facts.json' with { type: 'json' }
import { DEFAULT_CATALOG } from './bundled'
import { sameValue } from '../domain/definition-values'
import { itemAcquisition, type AcquisitionConditionFacts, type AcquisitionKind, type AcquisitionRoute, type ItemAcquisition, type WorldAcquisitionSnapshot } from '../domain/item-acquisition'
import { nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, JsonValue, Knowledge } from '../domain/types'

const WORLD = worldJson as WorldAcquisitionSnapshot
const CONDITIONS = conditionJson as AcquisitionConditionFacts
const NATIVE_SCOPE_FIELDS = ['Game platform', 'Game version', 'Mode data', 'Native source record'] as const
const ROUTE_FACTS = routeFactJson as unknown as { readonly source: typeof routeFactJson.source; readonly prices: readonly { readonly entityId: string; readonly expectedRoute: AcquisitionRoute; readonly price: number; readonly evidence: readonly string[] }[] }
const ROUTE_SOURCE_MATCHES = ROUTE_FACTS.source.worldContentDigest === WORLD.contentDigest && ROUTE_FACTS.source.worldSha256 === WORLD.source.world.sha256 && ROUTE_FACTS.source.gameExecutableSha256 === WORLD.source.gameExecutableSha256 && ROUTE_FACTS.source.nativeContentDigest === WORLD.source.nativeContentDigest && ROUTE_FACTS.source.platform === WORLD.source.platform && ROUTE_FACTS.source.gameVersion === WORLD.source.gameVersion
interface GuidanceReceipt {
  readonly entityId: string
  readonly field: string
  readonly value: JsonValue
  readonly routes: readonly AcquisitionRoute[]
  readonly evidence: readonly string[]
}
interface GuidanceDifference extends GuidanceReceipt {
  readonly summary: string
  readonly absentKinds: readonly AcquisitionKind[]
}
const RECEIPTS = receiptJson as unknown as { readonly worldContentDigest: string; readonly receipts: readonly GuidanceReceipt[]; readonly disagreements: readonly GuidanceDifference[] }

export interface AcquisitionGuidanceProjection {
  readonly replacedFields: readonly string[]
  readonly originalGuides: readonly { readonly field: string; readonly knowledge: Knowledge<JsonValue>; readonly evidence: readonly string[] }[]
  readonly retainedGuides: ItemAcquisition['guides']
  readonly acquisition: ItemAcquisition
  readonly disagreements: readonly { readonly field: string; readonly knowledge: Knowledge<JsonValue>; readonly summary: string; readonly evidence: readonly string[] }[]
}

function reviewedNativeEntity(catalog: CatalogSnapshot, entity: CatalogEntity): boolean {
  const baseline = DEFAULT_CATALOG.entities[entity.id]
  return Boolean(catalog.id === DEFAULT_CATALOG.id && catalog.revisionId === DEFAULT_CATALOG.revisionId && catalog.checksum === DEFAULT_CATALOG.checksum && baseline && entity.kind === baseline.kind && sameValue(entity.sources, baseline.sources) && sameValue(nativeIdentity(baseline), nativeIdentity(entity)) && sameValue(nativeSourceRecord(baseline), nativeSourceRecord(entity)) && NATIVE_SCOPE_FIELDS.every(field => sameValue(entity.fields[field], baseline.fields[field])))
}

export function nativeItemAcquisition(catalog: CatalogSnapshot, entity: CatalogEntity, mode = nativeIdentity(entity)?.mode ?? 'base'): ItemAcquisition {
  const acquisition = itemAcquisition(catalog, entity, WORLD, mode, CONDITIONS)
  if (mode !== 'base' || !acquisition.worldMatched || !ROUTE_SOURCE_MATCHES || !reviewedNativeEntity(catalog, entity)) return acquisition
  const routes = acquisition.routes.map(route => {
    const fact = ROUTE_FACTS.prices.find(entry => entry.entityId === entity.id && sameValue(entry.expectedRoute, route))
    return fact ? { ...route, price: fact.price, evidence: `${route.evidence}; ${fact.evidence.join('; ')}` } : route
  })
  return { ...acquisition, routes }
}

export function projectAcquisitionGuidance(catalog: CatalogSnapshot, entity: CatalogEntity, mode = nativeIdentity(entity)?.mode ?? 'base'): AcquisitionGuidanceProjection {
  const acquisition = nativeItemAcquisition(catalog, entity, mode)
  const originalGuides: AcquisitionGuidanceProjection['originalGuides'][number][] = []
  const disagreements: AcquisitionGuidanceProjection['disagreements'][number][] = []
  const baseline = DEFAULT_CATALOG.entities[entity.id]
  const eligible = mode === 'base' && nativeIdentity(entity)?.mode === 'base' && acquisition.worldMatched && RECEIPTS.worldContentDigest === WORLD.contentDigest && reviewedNativeEntity(catalog, entity)
  const matchesReceipt = (receipt: GuidanceReceipt): boolean => {
    const knowledge = entity.fields[receipt.field]
    return Boolean(eligible && knowledge?.state === 'known' && sameValue(knowledge, baseline?.fields[receipt.field]) && sameValue(knowledge.value, receipt.value) && receipt.routes.length && receipt.routes.every(expected => acquisition.routes.some(route => sameValue(route, expected))))
  }
  for (const receipt of RECEIPTS.receipts.filter(entry => entry.entityId === entity.id)) {
    if (matchesReceipt(receipt)) originalGuides.push({ field: receipt.field, knowledge: entity.fields[receipt.field]!, evidence: receipt.evidence })
  }
  for (const receipt of RECEIPTS.disagreements.filter(entry => entry.entityId === entity.id)) {
    if (matchesReceipt(receipt) && acquisition.unresolved.length === 0 && !acquisition.routes.some(route => receipt.absentKinds.includes(route.kind))) disagreements.push({ field: receipt.field, knowledge: entity.fields[receipt.field]!, summary: receipt.summary, evidence: receipt.evidence })
  }
  const replacedFields = originalGuides.map(guide => guide.field)
  return { acquisition, replacedFields, originalGuides, disagreements, retainedGuides: acquisition.guides.filter(guide => !replacedFields.includes(guide.field)) }
}
