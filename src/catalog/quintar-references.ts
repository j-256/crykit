import { QUINTAR_STEP, type QuintarBreedingStepId } from './quintar-breeding'
import type { CatalogEntityKind } from '../domain/types'

export interface QuintarReferenceTarget {
  readonly entityId: string
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly label?: string
}

const REFERENCE = Object.freeze({
  babel: { entityId: 'base:item:167', kind: 'item', name: 'Babel Quintar' },
  ocarina: { entityId: 'base:item:115', kind: 'item', name: 'Quintar Ocarina' },
  egg: { entityId: 'base:monster:ref-801', kind: 'monster', name: 'Quintar Egg' },
  trustyBlue: { entityId: 'base:monster:ref-878', kind: 'monster', name: 'Trusty Quintar (Blue)' },
  trustyRed: { entityId: 'base:monster:ref-879', kind: 'monster', name: 'Trusty Quintar (Red)' },
  wokeRiver: { entityId: 'base:monster:ref-901', kind: 'monster', name: 'Woke Quintar (River)' },
  brutishDesert: { entityId: 'base:monster:ref-656', kind: 'monster', name: 'Brutish Quintar (Desert)' },
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
  [QUINTAR_STEP.trustyBlue]: [REFERENCE.trustyBlue, REFERENCE.egg, REFERENCE.yamagawa, REFERENCE.dione],
  [QUINTAR_STEP.trustyRed]: [REFERENCE.trustyRed, REFERENCE.egg, REFERENCE.overpass, REFERENCE.okimoto, REFERENCE.beach],
  [QUINTAR_STEP.wokeRiver]: [REFERENCE.wokeRiver, REFERENCE.egg, REFERENCE.riverCat],
  [QUINTAR_STEP.brutishDesert]: [REFERENCE.brutishDesert, REFERENCE.egg, REFERENCE.bazaar],
  [QUINTAR_STEP.fancyRed]: [REFERENCE.breeding, REFERENCE.egg, REFERENCE.trustyRed, REFERENCE.wokeRiver],
  [QUINTAR_STEP.fancyBlue]: [REFERENCE.breeding, REFERENCE.egg, REFERENCE.trustyBlue, REFERENCE.wokeRiver],
  [QUINTAR_STEP.wokeBlue]: [REFERENCE.breeding, REFERENCE.egg, REFERENCE.trustyBlue],
  [QUINTAR_STEP.brutishHighland]: [REFERENCE.breeding, REFERENCE.egg],
  [QUINTAR_STEP.fancyHighland]: [REFERENCE.breeding, REFERENCE.egg],
  [QUINTAR_STEP.brutishAqua]: [REFERENCE.breeding, REFERENCE.egg, REFERENCE.wokeRiver],
  [QUINTAR_STEP.wokeAqua]: [REFERENCE.breeding, REFERENCE.egg, REFERENCE.wokeRiver],
  [QUINTAR_STEP.fancyDesert]: [REFERENCE.breeding, REFERENCE.egg, REFERENCE.brutishDesert],
  [QUINTAR_STEP.brutishBlack]: [REFERENCE.breeding, REFERENCE.egg, REFERENCE.wokeRiver],
  [QUINTAR_STEP.fancyBlack]: [REFERENCE.breeding, REFERENCE.egg],
  [QUINTAR_STEP.golden]: [REFERENCE.breeding, REFERENCE.egg],
  [QUINTAR_STEP.summon]: [REFERENCE.ocarina, REFERENCE.breeding],
})
