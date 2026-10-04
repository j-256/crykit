import { nativeItemAcquisition } from './acquisition-guidance'
import { QUINTAR_STEP, type QuintarBreedingStepId } from './quintar-breeding'
import type { CatalogEntityKind, CatalogSnapshot } from '../domain/types'

export interface QuintarReferenceTarget {
  readonly entityId: string
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly label?: string
}

const REFERENCE = Object.freeze({
  babel: { entityId: 'base:item:167', kind: 'item', name: 'Babel Quintar' },
  ocarina: { entityId: 'base:item:115', kind: 'item', name: 'Quintar Ocarina' },
  incubator: { entityId: 'base:item:201', kind: 'item', name: 'Incubator' },
  trustyBlue: { entityId: 'base:monster:317', kind: 'monster', name: 'Trusty Quintar', label: 'Trusty Quintar (Blue)' },
  trustyRed: { entityId: 'base:monster:304', kind: 'monster', name: 'Trusty Quintar', label: 'Trusty Quintar (Red)' },
  wokeRiver: { entityId: 'base:monster:318', kind: 'monster', name: 'Woke Quintar', label: 'Woke Quintar (River)' },
  brutishDesert: { entityId: 'base:monster:316', kind: 'monster', name: 'Brutish Quintar', label: 'Brutish Quintar (Desert)' },
  breeding: { entityId: 'base:other:ref-929', kind: 'other', name: 'Quintar Breeding', label: 'Breeding method' },
  dione: { entityId: 'base:location:ref-249', kind: 'location', name: 'Dione Shrine' },
  mausoleum: { entityId: 'base:location:ref-289', kind: 'location', name: 'Quintar Mausoleum' },
  reserve: { entityId: 'base:location:ref-291', kind: 'location', name: 'Quintar Reserve' },
  shop: { entityId: 'base:location:ref-294', kind: 'location', name: 'Quintar Shop' },
  yamagawa: { entityId: 'base:location:ref-337', kind: 'location', name: 'Yamagawa M.A.' },
  overpass: { entityId: 'base:location:ref-281', kind: 'location', name: 'Overpass' },
  okimoto: { entityId: 'base:location:ref-280', kind: 'location', name: 'Okimoto N.S.' },
  beach: { entityId: 'base:location:ref-303', kind: 'location', name: 'Sara Sara Beach' },
  riverCat: { entityId: 'base:location:ref-295', kind: 'location', name: "River Cat's Ego" },
  bazaar: { entityId: 'base:location:ref-302', kind: 'location', name: 'Sara Sara Bazaar' },
} as const satisfies Record<string, QuintarReferenceTarget>)

export const QUINTAR_STEP_REFERENCES: Readonly<Record<QuintarBreedingStepId, readonly QuintarReferenceTarget[]>> = Object.freeze({
  [QUINTAR_STEP.babel]: [REFERENCE.babel, REFERENCE.mausoleum, REFERENCE.reserve],
  [QUINTAR_STEP.ocarina]: [REFERENCE.ocarina, REFERENCE.shop, REFERENCE.dione],
  [QUINTAR_STEP.trustyBlue]: [REFERENCE.trustyBlue, REFERENCE.incubator, REFERENCE.yamagawa, REFERENCE.dione],
  [QUINTAR_STEP.trustyRed]: [REFERENCE.trustyRed, REFERENCE.incubator, REFERENCE.overpass, REFERENCE.okimoto, REFERENCE.beach],
  [QUINTAR_STEP.wokeRiver]: [REFERENCE.wokeRiver, REFERENCE.incubator, REFERENCE.riverCat],
  [QUINTAR_STEP.brutishDesert]: [REFERENCE.brutishDesert, REFERENCE.incubator, REFERENCE.bazaar],
  [QUINTAR_STEP.fancyRed]: [REFERENCE.breeding, REFERENCE.incubator, REFERENCE.trustyRed, REFERENCE.wokeRiver],
  [QUINTAR_STEP.fancyBlue]: [REFERENCE.breeding, REFERENCE.incubator, REFERENCE.trustyBlue, REFERENCE.wokeRiver],
  [QUINTAR_STEP.wokeBlue]: [REFERENCE.breeding, REFERENCE.incubator, REFERENCE.trustyBlue],
  [QUINTAR_STEP.brutishHighland]: [REFERENCE.breeding, REFERENCE.incubator],
  [QUINTAR_STEP.fancyHighland]: [REFERENCE.breeding, REFERENCE.incubator],
  [QUINTAR_STEP.brutishAqua]: [REFERENCE.breeding, REFERENCE.incubator, REFERENCE.wokeRiver],
  [QUINTAR_STEP.wokeAqua]: [REFERENCE.breeding, REFERENCE.incubator, REFERENCE.wokeRiver],
  [QUINTAR_STEP.fancyDesert]: [REFERENCE.breeding, REFERENCE.incubator, REFERENCE.brutishDesert],
  [QUINTAR_STEP.brutishBlack]: [REFERENCE.breeding, REFERENCE.incubator, REFERENCE.wokeRiver],
  [QUINTAR_STEP.fancyBlack]: [REFERENCE.breeding, REFERENCE.incubator],
  [QUINTAR_STEP.golden]: [REFERENCE.breeding, REFERENCE.incubator],
  [QUINTAR_STEP.summon]: [REFERENCE.ocarina, REFERENCE.breeding],
})

export function quintarOcarinaPrice(catalog: CatalogSnapshot | undefined): number | undefined {
  const entity = catalog?.entities[REFERENCE.ocarina.entityId]
  if (!catalog || entity?.kind !== REFERENCE.ocarina.kind) return undefined
  const acquisition = nativeItemAcquisition(catalog, entity)
  if (!acquisition.worldMatched) return undefined
  const prices = new Set(acquisition.routes.filter(route => route.kind === 'shop' && route.price !== undefined).map(route => route.price!))
  return prices.size === 1 ? [...prices][0] : undefined
}
