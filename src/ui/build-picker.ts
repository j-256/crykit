import { analyzeBuildEquipment, type DefinitionResolver, type EquipmentPermissionAssessment } from '../domain/build-mechanics'
import { effectivePpLimit } from '../domain/build-validity'
import { entityDefinitionKey } from '../domain/core'
import { equipmentFacts, isWeapon, passivePointCost } from '../domain/mechanics-facts'
import type { BuildRevisionContent, EntityRef, GameSetupRevision, SlotDefinition } from '../domain/types'
import { referenceCategoryKey } from './reference-categories'
import type { DefinitionOption } from './definitions'
import { nativeListedStat, nativeStatSourceNotice, selectionSummaryLines } from './build-evidence'

export const PICKER_STAT_FIELDS = ['Attack', 'Defense', 'Resistance', 'Strength', 'Vitality', 'Dexterity', 'Agility', 'Mind', 'Spirit', 'HP', 'MP'] as const
const FLAT_UNITS = new Set(['displayed', 'listed flat value'])
const SEARCH_EXCERPT_LIMIT = 150
const SEARCH_MATCH_RANK = Object.freeze({ exactName: 0, namePrefix: 1, nameTokens: 2, alias: 3, details: 4, reference: 5 })

export interface PickerSearchEntry {
  readonly names: readonly string[]
  readonly aliases: readonly string[]
  readonly details: readonly string[]
  readonly referenceText?: string
  readonly conflictingReferenceStats: boolean
}

export function pickerSearchEntry(option: DefinitionOption, displayedName: string): PickerSearchEntry {
  return {
    names: [...new Set([displayedName, option.name])],
    aliases: option.aliases,
    details: selectionSummaryLines(option),
    referenceText: option.description,
    conflictingReferenceStats: Boolean(nativeStatSourceNotice(option.record)),
  }
}

export function pickerSearchMatch(entry: PickerSearchEntry, query: string): { readonly rank: number; readonly explanation?: string } | undefined {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return { rank: SEARCH_MATCH_RANK.exactName }
  const tokens = normalized.split(/\s+/)
  const matches = (text: string) => tokens.every(token => text.toLocaleLowerCase().includes(token))
  if (!matches([...entry.names, ...entry.aliases, ...entry.details, entry.referenceText ?? ''].join(' '))) return undefined
  if (entry.names.some(name => name.toLocaleLowerCase() === normalized)) return { rank: SEARCH_MATCH_RANK.exactName }
  if (entry.names.some(name => name.toLocaleLowerCase().startsWith(normalized))) return { rank: SEARCH_MATCH_RANK.namePrefix }
  if (entry.names.some(matches)) return { rank: SEARCH_MATCH_RANK.nameTokens }
  const alias = entry.aliases.find(matches)
  if (alias) return { rank: SEARCH_MATCH_RANK.alias, explanation: `Matched alias: ${alias.slice(0, SEARCH_EXCERPT_LIMIT)}` }
  if (!matches([...entry.names, ...entry.aliases, ...entry.details].join(' ')) && entry.referenceText) return {
    rank: SEARCH_MATCH_RANK.reference,
    explanation: entry.conflictingReferenceStats ? 'Matched supplemental reference text; see provenance for differing stat claims' : `Matched reference text: ${entry.referenceText.slice(0, SEARCH_EXCERPT_LIMIT)}`,
  }
  const detail = entry.details.find(matches) ?? entry.details.find(line => tokens.some(token => line.toLocaleLowerCase().includes(token)))
  return { rank: SEARCH_MATCH_RANK.details, explanation: detail ? `Matched details: ${detail.slice(0, SEARCH_EXCERPT_LIMIT)}` : 'Matched across name and aliases' }
}

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
  const nativeValue = nativeListedStat(option.record, label)
  if (nativeValue !== undefined) return nativeValue
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
