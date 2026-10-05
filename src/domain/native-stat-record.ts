import combatData from '../catalog/native-combat-v1.json' with { type: 'json' }
import { NATIVE_DATA } from './calculation-rules'
import { definitionSourceRecord, type MechanicsDefinition } from './mechanics-facts'
import { nativeIdentity } from './native-game'
import { crystalEditPlanningRecord } from './crystal-edit-compatibility'
import type { EntityRef } from './types'

export type NativeRecord = Readonly<Record<string, unknown>>
type Family = 'job' | 'equipment' | 'passive' | 'gender' | 'ability' | 'status'
type Resolve = (ref: EntityRef) => MechanicsDefinition | undefined
const crystalRecord = (definition: MechanicsDefinition | undefined): NativeRecord | undefined => {
  return crystalEditPlanningRecord(definition)
}

export function nativeById(family: Family, id: number, mode: string): NativeRecord | undefined {
  const base = NATIVE_DATA.records[family].find(record => record.ID === id)
  const patch = mode === 'standard' ? undefined : NATIVE_DATA.patches.find(patch => patch.name.toLowerCase() === mode)?.records[family].find(record => record.ID === id)
  const combat = family === 'status' ? combatData.records.status.find(record => record.ID === id) : undefined
  const combatPatch = family === 'status' && mode !== 'standard' ? combatData.patches.find(patch => patch.name.toLowerCase() === mode)?.records.status.find(record => record.ID === id) : undefined
  return base ? { ...combat, ...base, ...patch, ...combatPatch } : undefined
}

export function nativeStatRecord(ref: EntityRef | null, family: Family, resolve: Resolve, mode = 'standard'): NativeRecord | undefined {
  if (!ref) return undefined
  const definition = resolve(ref)
  if (!definition || (family === 'job' ? definition.kind !== 'class' : family === 'passive' ? !['passive', 'innate'].includes(definition.kind) : family === 'equipment' ? definition.kind !== 'item' : family === 'ability' ? !['ability', 'monsterMagic'].includes(definition.kind) : family === 'status' ? definition.kind !== 'status' : false)) return undefined
  const explicit = crystalRecord(definition)
  if (explicit) return explicit
  const native = definitionSourceRecord(definition)
  if (native) {
    const identity = nativeIdentity(definition)
    const patch = identity?.database === family && identity.mode === 'base' && mode !== 'standard' ? NATIVE_DATA.patches.find(patch => patch.name.toLowerCase() === mode)?.records[family].find(record => record.ID === identity.databaseId) : undefined
    return { ...native, ...patch }
  }
  const bindings = NATIVE_DATA.bindings as Readonly<Record<string, { readonly family: string; readonly id: number }>>
  const binding = ref.kind === 'catalog' && ref.catalogId === NATIVE_DATA.catalogId ? bindings[ref.entityId] : undefined
  if (binding?.family === family) return nativeById(family, binding.id, mode)
  return undefined
}
