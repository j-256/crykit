import type { CharacterSnapshot, EntityRef, Knowledge, ObservedStat, Profile, SourceRef } from './types'

export type SnapshotValue =
  | { readonly kind: 'number'; readonly value: Knowledge<number>; readonly unit: string }
  | { readonly kind: 'reference'; readonly value: Knowledge<EntityRef> }
  | { readonly kind: 'references'; readonly value: Knowledge<readonly EntityRef[]> }
  | { readonly kind: 'selection'; readonly value: EntityRef | null | undefined }
  | { readonly kind: 'text'; readonly value: string | undefined }
  | { readonly kind: 'ruleset'; readonly value: CharacterSnapshot['rulesetRevisionId'] }
  | { readonly kind: 'sources'; readonly value: readonly SourceRef[] }
  | { readonly kind: 'unrecorded' }

export interface SnapshotComparisonRow {
  readonly key: string
  readonly label: string
  readonly slotId?: string
  readonly left: SnapshotValue
  readonly right: SnapshotValue
  readonly changed: boolean
  readonly delta?: number
}

export interface SnapshotSlot {
  readonly id: string
  readonly label: string
  readonly kind: 'equipment' | 'passive' | 'unmapped'
  readonly selection: EntityRef | null | undefined
}

export function snapshotSlots(profile: Profile, snapshot: CharacterSnapshot): readonly SnapshotSlot[] {
  const ruleset = snapshot.rulesetRevisionId && Object.hasOwn(profile.rulesets, snapshot.rulesetRevisionId) ? profile.rulesets[snapshot.rulesetRevisionId] : undefined
  const slots: SnapshotSlot[] = [...(ruleset?.slots ?? [])].sort((left, right) => left.order - right.order).map((slot) => ({
    id: slot.id,
    label: slot.label,
    kind: 'equipment',
    selection: Object.hasOwn(snapshot.equipment, slot.id) ? snapshot.equipment[slot.id] : undefined,
  }))
  const mapped = new Set(slots.map((slot) => slot.id))
  for (const [id, selection] of Object.entries(snapshot.equipment)) {
    if (!mapped.has(id)) slots.push({ id, label: `Slot ${id}`, kind: 'unmapped', selection })
  }
  return slots
}

function canonicalValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`).join(',')}}`
}

function statValue(stat: ObservedStat | undefined): SnapshotValue {
  return stat ? { kind: 'number', value: stat.value, unit: stat.unit } : { kind: 'unrecorded' }
}

export function compareCharacterSnapshots(left: CharacterSnapshot, right: CharacterSnapshot): readonly SnapshotComparisonRow[] {
  const rows: SnapshotComparisonRow[] = []
  const add = (key: string, label: string, a: SnapshotValue, b: SnapshotValue, slotId?: string) => {
    const difference = a.kind === 'number' && b.kind === 'number' && a.unit === b.unit && a.value.state === 'known' && b.value.state === 'known' ? b.value.value - a.value.value : undefined
    rows.push({ key, label, left: a, right: b, changed: canonicalValue(a) !== canonicalValue(b), ...(slotId === undefined ? {} : { slotId }), ...(difference === undefined || !Number.isFinite(difference) ? {} : { delta: difference }) })
  }
  add('level', 'Level', { kind: 'number', value: left.level, unit: '' }, { kind: 'number', value: right.level, unit: '' })
  add('primaryClass', 'Primary class', { kind: 'reference', value: left.primaryClass }, { kind: 'reference', value: right.primaryClass })
  add('secondaryClass', 'Secondary class', { kind: 'reference', value: left.secondaryClass }, { kind: 'reference', value: right.secondaryClass })
  const leftStats = new Map(Object.entries(left.displayedStats))
  const rightStats = new Map(Object.entries(right.displayedStats))
  for (const key of new Set([...leftStats.keys(), ...rightStats.keys()])) add(`stat:${key}`, key, statValue(leftStats.get(key)), statValue(rightStats.get(key)))
  const leftSelections = new Map(Object.entries(left.equipment))
  const rightSelections = new Map(Object.entries(right.equipment))
  for (const id of new Set([...leftSelections.keys(), ...rightSelections.keys()])) add(`slot:${id}`, `Slot ${id}`, { kind: 'selection', value: leftSelections.get(id) }, { kind: 'selection', value: rightSelections.get(id) }, id)
  const passiveRefs = (value: CharacterSnapshot['passives']) => value.state === 'known' ? value.value : []
  const leftPassives = passiveRefs(left.passives)
  const rightPassives = passiveRefs(right.passives)
  for (let index = 0; index < Math.max(leftPassives.length, rightPassives.length); index += 1) add(`passive:${index}`, `Equipped passive ${index + 1}`, { kind: 'selection', value: leftPassives[index] }, { kind: 'selection', value: rightPassives[index] })
  if (left.passives.state !== 'known' || right.passives.state !== 'known') add('passives', 'Equipped passives', { kind: 'references', value: left.passives }, { kind: 'references', value: right.passives })
  add('ruleset', 'Slot context', { kind: 'ruleset', value: left.rulesetRevisionId }, { kind: 'ruleset', value: right.rulesetRevisionId })
  add('observedAt', 'Observed on', { kind: 'text', value: left.observedAt }, { kind: 'text', value: right.observedAt })
  add('recordedAt', 'Recorded on', { kind: 'text', value: left.recordedAt }, { kind: 'text', value: right.recordedAt })
  add('note', 'Note', { kind: 'text', value: left.note }, { kind: 'text', value: right.note })
  add('sources', 'Observation sources', { kind: 'sources', value: left.sources }, { kind: 'sources', value: right.sources })
  return rows
}
