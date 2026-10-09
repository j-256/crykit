import { battleCalculationReferences } from './battle-plan'
import type { BuildRevisionContent, EntityRef } from './types'

export function buildModReferences(content: BuildRevisionContent): readonly EntityRef[] {
  return [content.primaryClass, content.secondaryClass, ...Object.values(content.equipment).map(selection => selection?.ref), ...content.passives.map(selection => selection.ref), ...content.calculation?.growth.map(row => row.classRef) ?? [], ...content.calculation?.statuses ?? [], content.calculation?.ability, ...battleCalculationReferences(content.calculation?.battle).map(value => value.ref)].filter((ref): ref is EntityRef => Boolean(ref))
}
