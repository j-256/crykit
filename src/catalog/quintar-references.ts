import { nativeItemAcquisition } from './acquisition-guidance'
import { QUINTAR_BREEDING_STEPS, QUINTAR_STARTING_QUINTARS, QUINTAR_STEP, type QuintarBreedingStepId } from './quintar-breeding'
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
} as const satisfies Record<string, QuintarReferenceTarget>)

export const QUINTAR_STEP_REFERENCES: Readonly<Partial<Record<QuintarBreedingStepId, readonly QuintarReferenceTarget[]>>> = Object.freeze(Object.fromEntries(QUINTAR_BREEDING_STEPS.map(step => {
  if (step.id === QUINTAR_STEP.babel) return [step.id, [REFERENCE.babel]]
  if (step.id === QUINTAR_STEP.ocarina || step.id === QUINTAR_STEP.summon) return [step.id, [REFERENCE.ocarina]]
  const related = [step.result, ...(step.parents ?? [])].filter(quintar => quintar !== undefined)
  const wild = QUINTAR_STARTING_QUINTARS.filter(start => related.some(quintar => quintar.type === start.result.type && quintar.nature === start.result.nature))
  const monsters = wild.map(start => Object.values(REFERENCE).find(target => target.entityId === `base:monster:${start.monsterID}`)!)
  return [step.id, [REFERENCE.incubator, ...monsters]]
})))

export function quintarOcarinaPrice(catalog: CatalogSnapshot | undefined): number | undefined {
  const entity = catalog?.entities[REFERENCE.ocarina.entityId]
  if (!catalog || entity?.kind !== REFERENCE.ocarina.kind) return undefined
  const acquisition = nativeItemAcquisition(catalog, entity)
  if (!acquisition.worldMatched) return undefined
  const prices = new Set(acquisition.routes.filter(route => route.kind === 'shop' && route.price !== undefined).map(route => route.price!))
  return prices.size === 1 ? [...prices][0] : undefined
}
