import combatData from '../catalog/native-combat-v1.json'
import type { DefinitionResolver } from './build-mechanics'
import { calculateBuildCombatPreview, type BuildCombatPreview } from './combat-preview'
import { calculationModResolver } from './calculation-mods'
import { entityDefinitionKey } from './core'
import { aggregateStatModifiers, applyAutomaticStatuses, collectEffectiveModifiers, type EffectiveModifierRecord } from './effective-modifiers'
import type { GameRuleResolution } from './game-rules'
import { definitionSourceRecord } from './mechanics-facts'
import { nativeIdentity } from './native-game'
import { nativeInteger } from './native-number'
import { nativeStatRecord } from './native-stat-record'
import type { BuildRevisionContent, EntityRef, SlotDefinition } from './types'

export interface ActiveStatusImpactChoice {
  readonly key: string
  readonly ref: EntityRef
  readonly name: string
  readonly recipient: 'user' | 'target'
}
export type StatusImpactValues = Pick<BuildCombatPreview, 'damage' | 'criticalDamage' | 'hitChance' | 'criticalChance' | 'costs' | 'unavailable'>
export interface ActiveStatusImpact {
  readonly current: StatusImpactValues
  readonly without: StatusImpactValues
  readonly automaticStatus: 'none' | 'retained' | 'uncertain' | 'unknown'
  readonly notes: readonly string[]
}

function statusIdentity(ref: EntityRef, resolve: DefinitionResolver, mode: string): { readonly key: string; readonly id?: number } {
  const id = nativeStatRecord(ref, 'status', resolve, mode)?.ID
  return nativeInteger(id) ? { key: `status:${id}`, id } : { key: entityDefinitionKey(ref) }
}

export function listActiveStatusImpactChoices(content: BuildRevisionContent, sourceResolve: DefinitionResolver, rules?: GameRuleResolution): readonly ActiveStatusImpactChoice[] {
  const plan = content.calculation
  const battle = plan?.battle
  if (!battle) return []
  const resolve = calculationModResolver(sourceResolve).resolve
  const mode = rules?.mode ?? plan.pcMode ?? 'standard'
  const seen = new Set<string>()
  const choices: ActiveStatusImpactChoice[] = []
  for (const recipient of ['user', 'target'] as const) {
    if (recipient === 'target' && battle.target === 'self') continue
    for (const { ref } of recipient === 'user' ? battle.statuses : battle.targetStatuses) {
      const key = `${recipient}:${statusIdentity(ref, resolve, mode).key}`
      if (seen.has(key)) continue
      seen.add(key)
      choices.push({ key, ref, recipient, name: sourceResolve(ref)?.name ?? 'Unresolved status' })
    }
  }
  return choices
}

function automaticStatusAfterRemoval(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, recipient: ActiveStatusImpactChoice['recipient'], id: number | undefined, rules: GameRuleResolution | undefined, unknownInputs: readonly string[], unknownSecondaryClass: boolean): ActiveStatusImpact['automaticStatus'] {
  const plan = content.calculation!
  const battle = plan.battle!
  if (!battle.automaticStatuses) return 'none'
  if (id === undefined || rules?.issues.length) return 'unknown'
  const mode = rules?.mode ?? plan.pcMode ?? 'standard'
  let modifiers
  if (recipient === 'user') {
    if (unknownInputs.length || unknownSecondaryClass) return 'unknown'
    modifiers = collectEffectiveModifiers(content, slots, resolve, { mode, turnCount: battle.turnCount, statuses: battle.statuses.map(status => status.ref), includeAutomaticStatuses: true, previouslyAppliedStatuses: battle.userPreviouslyAppliedStatuses, currentHP: battle.user.hp })
  } else {
    if (!battle.target || battle.target === 'self') return 'unknown'
    const definition = resolve(battle.target)
    let record = definition?.kind === 'monster' ? definitionSourceRecord(definition) : undefined
    const identity = definition && nativeIdentity(definition)
    const targetMode = rules?.mode ?? 'standard'
    if (identity?.database === 'monster' && identity.mode === 'base' && record) {
      const patch = combatData.patches.find(patch => patch.name.toLowerCase() === targetMode)?.records.monster.find(entry => entry.ID === identity.databaseId)
      record = { ...record, ...patch }
    }
    const records: EffectiveModifierRecord[] = [{ record: record ?? {}, ref: battle.target, label: definition?.name ?? 'Target', group: 'equipment' }]
    const seen = new Set<number>()
    for (const status of battle.targetStatuses) {
      const statusRecord = nativeStatRecord(status.ref, 'status', resolve, mode)
      if (nativeInteger(statusRecord?.ID)) {
        if (seen.has(statusRecord.ID)) continue
        seen.add(statusRecord.ID)
      }
      records.push({ record: statusRecord ?? {}, ref: status.ref, label: resolve(status.ref)?.name ?? 'Unresolved target status', group: 'status' })
    }
    const level = nativeInteger(record?.Level) ? record.Level : null
    modifiers = applyAutomaticStatuses(aggregateStatModifiers(records, level, battle.targetTurnCount), level, resolve, { mode: targetMode, turnCount: battle.targetTurnCount, statuses: battle.targetStatuses.map(status => status.ref), includeAutomaticStatuses: true, previouslyAppliedStatuses: battle.previouslyAppliedStatuses, currentHP: battle.targetResources.hp })
  }
  const matching = modifiers.automaticStatuses.filter(status => status.id === id)
  if (matching.some(status => status.applied)) return 'retained'
  if (matching.some(status => status.uncertain)) return 'uncertain'
  return modifiers.unknownFields.has('*') || modifiers.unknownFields.has('StatusAuto') ? 'unknown' : 'none'
}

function values(preview: BuildCombatPreview): StatusImpactValues {
  const { damage, criticalDamage, hitChance, criticalChance, costs, unavailable } = preview
  return { damage, criticalDamage, hitChance, criticalChance, costs, unavailable }
}

export function compareActiveStatusImpact(content: BuildRevisionContent, slots: readonly SlotDefinition[], sourceResolve: DefinitionResolver, choice: ActiveStatusImpactChoice, rules?: GameRuleResolution, unknownInputs: readonly string[] = [], unknownSecondaryClass = false, currentPreview?: BuildCombatPreview): ActiveStatusImpact | undefined {
  const selected = listActiveStatusImpactChoices(content, sourceResolve, rules).find(entry => entry.key === choice.key)
  const plan = content.calculation
  const battle = plan?.battle
  if (!selected || !plan || !battle) return undefined
  const resolve = calculationModResolver(sourceResolve).resolve
  const mode = rules?.mode ?? plan.pcMode ?? 'standard'
  const identity = statusIdentity(selected.ref, resolve, mode)
  const field = selected.recipient === 'user' ? 'statuses' : 'targetStatuses'
  const remaining = battle[field].filter(status => statusIdentity(status.ref, resolve, mode).key !== identity.key)
  const withoutContent: BuildRevisionContent = { ...content, calculation: { ...plan, battle: { ...battle, [field]: remaining } } }
  const current = currentPreview ?? calculateBuildCombatPreview(content, slots, sourceResolve, rules, unknownInputs, unknownSecondaryClass)
  const without = calculateBuildCombatPreview(withoutContent, slots, sourceResolve, rules, unknownInputs, unknownSecondaryClass)
  const automaticStatus = automaticStatusAfterRemoval(withoutContent, slots, resolve, selected.recipient, identity.id, rules, unknownInputs, unknownSecondaryClass)
  const notes: string[] = []
  if (battle[field].length - remaining.length > 1) notes.push('All selections of this status were removed together.')
  if (battle.target === 'self') notes.push('When targeting yourself, removing a status changes both sides of the calculation.')
  if (automaticStatus === 'retained') notes.push(`${selected.name} is still applied automatically after its explicit selection is removed.`)
  else if (automaticStatus === 'uncertain') notes.push(`${selected.name} may still be applied automatically after removing this selection.`)
  else if (automaticStatus === 'unknown') notes.push('Automatic reapplication is unknown. Removing this selection may leave the status active.')
  return { current: values(current), without: values(without), automaticStatus, notes }
}
