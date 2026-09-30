import { QUINTAR_STEP, type QuintarBreedingStepId } from './quintar-breeding'
import type { CatalogEntityKind } from '../domain/types'

export interface QuintarReferenceTarget {
  readonly entityId: string
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly label?: string
}

const REFERENCE = Object.freeze({
  babel: { entityId: 'wiki:item:babel-quintar', kind: 'item', name: 'Babel Quintar' },
  ocarina: { entityId: 'wiki:item:quintar-ocarina', kind: 'item', name: 'Quintar Ocarina' },
  egg: { entityId: 'wiki:monster:quintar-egg', kind: 'monster', name: 'Quintar Egg' },
  trustyBlue: { entityId: 'wiki:monster:trusty-quintar-blue', kind: 'monster', name: 'Trusty Quintar (Blue)' },
  trustyRed: { entityId: 'wiki:monster:trusty-quintar-red', kind: 'monster', name: 'Trusty Quintar (Red)' },
  wokeRiver: { entityId: 'wiki:monster:woke-quintar-river', kind: 'monster', name: 'Woke Quintar (River)' },
  brutishDesert: { entityId: 'wiki:monster:brutish-quintar-desert', kind: 'monster', name: 'Brutish Quintar (Desert)' },
  breeding: { entityId: 'wiki:other:quintar-breeding', kind: 'other', name: 'Quintar Breeding', label: 'Breeding method' },
  dione: { entityId: 'wiki:location:dione-shrine', kind: 'location', name: 'Dione Shrine' },
  mausoleum: { entityId: 'wiki:location:quintar-mausoleum', kind: 'location', name: 'Quintar Mausoleum' },
  reserve: { entityId: 'wiki:location:quintar-reserve', kind: 'location', name: 'Quintar Reserve' },
  shop: { entityId: 'wiki:location:quintar-shop', kind: 'location', name: 'Quintar Shop' },
  yamagawa: { entityId: 'wiki:location:yamagawa-m-a', kind: 'location', name: 'Yamagawa M.A.' },
  overpass: { entityId: 'wiki:location:overpass', kind: 'location', name: 'Overpass' },
  okimoto: { entityId: 'wiki:location:okimoto-n-s', kind: 'location', name: 'Okimoto N.S.' },
  beach: { entityId: 'wiki:location:sara-sara-beach', kind: 'location', name: 'Sara Sara Beach' },
  riverCat: { entityId: 'wiki:location:river-cat-s-ego', kind: 'location', name: "River Cat's Ego" },
  bazaar: { entityId: 'wiki:location:sara-sara-bazaar', kind: 'location', name: 'Sara Sara Bazaar' },
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
