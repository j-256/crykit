import { analyzeBuildEquipment, type DefinitionResolver, type EquipmentPermissionAssessment } from '../domain/build-mechanics'
import { effectivePpLimit } from '../domain/build-validity'
import { entityDefinitionKey } from '../domain/core'
import { equipmentFacts, isWeapon, passivePointCost } from '../domain/mechanics-facts'
import type { BuildRevisionContent, EntityRef, GameSetupRevision, SlotDefinition } from '../domain/types'
import { referenceCategoryKey } from './reference-categories'
import type { DefinitionOption } from './definitions'

export const PICKER_STAT_FIELDS = ['Attack', 'Defense', 'Resistance', 'Strength', 'Vitality', 'Dexterity', 'Agility', 'Mind', 'Spirit', 'HP', 'MP'] as const
const FLAT_UNITS = new Set(['displayed', 'listed flat value'])

export function pickerCategoryKey(option: DefinitionOption): string | undefined {
  const type = equipmentFacts(option.record).type
  return type ? referenceCategoryKey(type) : undefined
}

export function pickerHandedness(option: DefinitionOption): string | undefined {
  const facts = equipmentFacts(option.record)
  if (!facts.type || !isWeapon(facts.type)) return undefined
  return facts.twoHanded === true ? 'Two-handed: occupies both hands' : facts.twoHanded === false ? 'One-handed' : 'Hand occupancy unknown'
}

export function pickerListedStat(option: DefinitionOption, label: string): number | undefined {
  const field = option.record.fields[label]
  if (field?.state === 'known' && typeof field.value === 'number') return field.value
  const contribution = option.record.listedContributions?.[label]
  return contribution?.state === 'known' && !contribution.value.condition && FLAT_UNITS.has(contribution.value.unit.toLocaleLowerCase()) ? contribution.value.value : undefined
}

export function pickerAvailableForSetup(option: DefinitionOption, includeUnavailable: boolean, selectedKey?: string): boolean {
  return option.key === selectedKey || includeUnavailable || !option.modAvailability?.requiredMod || option.modAvailability.state === 'enabled'
}

export function pickerEquipmentAssessment(option: DefinitionOption, content: BuildRevisionContent, slot: SlotDefinition, slots: readonly SlotDefinition[], resolve: DefinitionResolver, identity: (ref: EntityRef) => string = entityDefinitionKey): EquipmentPermissionAssessment {
  const equipment = { ...content.equipment }
  const previous = equipment[slot.id]
  const baseline = analyzeBuildEquipment(content, slots, resolve, identity)
  const unchanged = previous && entityDefinitionKey(previous.ref) === option.key
  if (!unchanged) {
    if (previous?.allocationId) {
      const peers = slots.filter(peer => peer.id !== slot.id && equipment[peer.id]?.allocationId === previous.allocationId)
      if (peers.length === 1) {
        const peer = equipment[peers[0]!.id]!
        equipment[peers[0]!.id] = { ref: peer.ref, ...(peer.observedName === undefined ? {} : { observedName: peer.observedName }) }
      }
    }
    equipment[slot.id] = { ref: option.ref }
  }
  const signature = (issue: typeof baseline[number]) => JSON.stringify([issue.code, issue.status, issue.message, issue.slotId])
  const previousIssues = new Set(baseline.map(signature))
  const issues = analyzeBuildEquipment({ ...content, equipment }, slots, resolve, identity).filter(issue => issue.slotId === slot.id || !previousIssues.has(signature(issue)))
  return {
    status: issues.some(issue => issue.status === 'invalid') ? 'invalid' : issues.length ? 'undetermined' : 'valid',
    ...(issues.length ? { reason: [...new Set(issues.map(issue => issue.message))].join(' ') } : {}),
  }
}

export function pickerRemainingPp(content: BuildRevisionContent, passiveIndex: number, gameSetup: GameSetupRevision | undefined, resolve: DefinitionResolver): number | undefined {
  const limit = effectivePpLimit(gameSetup)
  if (limit.state !== 'known') return undefined
  let used = 0
  for (const [index, selection] of content.passives.entries()) {
    if (index === passiveIndex) continue
    const definition = resolve(selection.ref)
    const cost = definition && passivePointCost(definition)
    if (cost?.state !== 'known') return undefined
    used += cost.value
  }
  return limit.value - used
}
