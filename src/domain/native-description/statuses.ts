import { nativeRecord, type NativeRecord } from '../native-game'
import type { NativeDescriptionContext } from './context.ts'
import { PERCENT } from './model.ts'

const PERMANENT_STATUS_COUNT = 255
const EXPLICIT_DURATION_STATUS_ID = 46
const STATUS_DECREMENTS = ['DecrementOnFixedInterval', 'DecrementOnEachUserTurn', 'DecrementOnDmgTaken', 'DecrementOnPDmgTaken', 'DecrementOnPDmgEvaded', 'DecrementOnPDmgGiven', 'DecrementOnMDmgTaken', 'DecrementOnMDmgEvaded', 'DecrementOnMDmgGiven', 'DecrementOnHealTaken', 'DecrementOnHealGiven', 'DecrementOnCritGiven', 'DecrementOnEffect'] as const

export function statusConditions(context: NativeDescriptionContext, status: NativeRecord, count: number): string | undefined {
  const { vocab, enumName } = context
  const conditions: string[] = []
  const keys: Readonly<Record<string, readonly [string, string]>> = {
    DecrementOnFixedInterval: ['INTERVAL', 'INTERVALS'], DecrementOnEachUserTurn: ['TURN', 'TURNS'],
    DecrementOnDmgTaken: ['DMG_TAKEN', 'DMGS_TAKEN'], DecrementOnPDmgTaken: ['PDMG_TAKEN', 'PDMGS_TAKEN'], DecrementOnMDmgTaken: ['MDMG_TAKEN', 'MDMGS_TAKEN'],
    DecrementOnPDmgGiven: ['PDMG_GIVEN', 'PDMGS_GIVEN'], DecrementOnMDmgGiven: ['MDMG_GIVEN', 'MDMGS_GIVEN'],
    DecrementOnPDmgEvaded: ['PEVA_TAKEN', 'PEVAS_TAKEN'], DecrementOnMDmgEvaded: ['MEVA_TAKEN', 'MEVAS_TAKEN'],
    DecrementOnHealTaken: ['HEAL_TAKEN', 'HEALS_TAKEN'], DecrementOnHealGiven: ['HEAL_GIVEN', 'HEALS_GIVEN'], DecrementOnCritGiven: ['CRIT_GIVEN', 'CRITS_GIVEN'],
  }
  for (const [field, pair] of Object.entries(keys)) if (status[field] === true) {
    const condition = vocab(`DESC_STATUS_${pair[count > 1 ? 1 : 0]}`)
    if (condition === undefined) return undefined
    conditions.push(condition)
  }
  if (status.DecrementOnEffect === true) {
    const survives = Array.isArray(status.StatMods) && status.StatMods.some(modifier => nativeRecord(modifier) && enumName('SangStatModTag', modifier.Tag) === 'CantBeOneHitKOd')
    const condition = survives ? vocab(`DESC_STATUS_${count > 1 ? 'HITS_SURVIVED' : 'HIT_SURVIVED'}`) : undefined
    if (condition === undefined) return undefined
    conditions.push(condition)
  }
  return conditions.length ? conditions.join(vocab('DESC_STATUS_DELIM_B') ?? ', or ') : undefined
}
export function statusApplication(context: NativeDescriptionContext, status: NativeRecord, count: number, chance: number, label: string | undefined): string | undefined {
  const { enumName } = context
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(chance) || chance < 0 || chance > PERCENT || count <= 0 || !label || typeof status.Name !== 'string') return undefined
  const instantKill = Array.isArray(status.StatMods) && status.StatMods.some(modifier => nativeRecord(modifier) && enumName('SangStatModTag', modifier.Tag) === 'InstantKill')
  // The exceptional status keeps duration semantics even when no standard decrement field is set
  const permanent = count === PERMANENT_STATUS_COUNT || (STATUS_DECREMENTS.every(key => status[key] === false) && enumName('SangStatusCategory', status.Category) !== 'Strict' && status.ID !== EXPLICIT_DURATION_STATUS_ID)
  let duration = ''
  if (!instantKill && !permanent && status.HideDurationFromDescription !== true) {
    const conditions = statusConditions(context, status, count)
    if (!conditions) return undefined
    duration = ` for ${count} ${conditions}`
  }
  return `${label}: ${status.Name}${duration}${permanent && !instantKill ? ' (permanent)' : ''}${chance !== PERCENT ? ` (${chance}% chance)` : ''}.`
}

export function describeStatus(context: NativeDescriptionContext, record: NativeRecord): void {
  const { depth, add, vocab, enumName, join } = context
    if (record.RemoveOnDmgTaken === true) add(vocab('DESC_STATUS_REMOVED_BY_DAMAGE'), 'Status removal')
    if (record.ReApplyResistance === true) add(vocab(enumName('SangStatusCategory', record.Category) === 'Debuff' ? 'DESC_STATUS_RESIST_REINFLICT' : 'DESC_STATUS_RESIST_REAPPLY'), 'Status resistance')
    if (depth === 0 && record.HideDurationFromDescription !== true && STATUS_DECREMENTS.some(key => record[key] === true)) add(join(vocab('DESC_STATUS_GENERIC_DURATION'), ' ', statusConditions(context, record, 1), '.'), 'Status duration')
}
