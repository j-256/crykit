import worldJson from './world-acquisition-v1.json' with { type: 'json' }
import conditionJson from './acquisition-condition-facts.json' with { type: 'json' }
import routeFactJson from './acquisition-route-facts.json' with { type: 'json' }
import { bundledCatalogForSnapshot } from './bundled'
import { sameValue } from '../domain/definition-values'
import { itemAcquisition, type AcquisitionConditionFacts, type AcquisitionRoute, type ItemAcquisition, type WorldAcquisitionSnapshot } from '../domain/item-acquisition'
import { nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot } from '../domain/types'

const WORLD = worldJson as WorldAcquisitionSnapshot
const CONDITIONS = conditionJson as AcquisitionConditionFacts
const NATIVE_SCOPE_FIELDS = ['Game platform', 'Game version', 'Mode data', 'Native source record'] as const
const ROUTE_FACTS = routeFactJson as unknown as { readonly source: typeof routeFactJson.source; readonly prices: readonly { readonly entityId: string; readonly expectedRoute: AcquisitionRoute; readonly price: number; readonly evidence: readonly string[] }[] }
const ROUTE_SOURCE_MATCHES = ROUTE_FACTS.source.worldContentDigest === WORLD.contentDigest && ROUTE_FACTS.source.worldSha256 === WORLD.source.world.sha256 && ROUTE_FACTS.source.gameExecutableSha256 === WORLD.source.gameExecutableSha256 && ROUTE_FACTS.source.nativeContentDigest === WORLD.source.nativeContentDigest && ROUTE_FACTS.source.platform === WORLD.source.platform && ROUTE_FACTS.source.gameVersion === WORLD.source.gameVersion
function reviewedNativeEntity(catalog: CatalogSnapshot, entity: CatalogEntity): boolean {
  const snapshot = bundledCatalogForSnapshot(catalog)
  const baseline = snapshot?.entities[entity.id]
  return Boolean(snapshot && baseline && entity.kind === baseline.kind && sameValue(entity.sources, baseline.sources) && sameValue(nativeIdentity(baseline), nativeIdentity(entity)) && sameValue(nativeSourceRecord(baseline), nativeSourceRecord(entity)) && NATIVE_SCOPE_FIELDS.every(field => sameValue(entity.fields[field], baseline.fields[field])))
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
