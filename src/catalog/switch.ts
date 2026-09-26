import type { CatalogEntity, EntityId, Knowledge, JsonValue, SourceRef } from '../domain/types'
import switchData from './switch-data.json' with { type: 'json' }

interface ConfirmedSwitchClass {
  readonly id: string
  readonly name: string
  readonly requiredMod: string | null
  readonly innate: { readonly id: string; readonly name: string; readonly learnableFromTree: boolean } | null
  readonly skills: readonly (readonly [string, 'ability' | 'passive', string])[]
}

export const SWITCH_CLASS_RECORDS: readonly ConfirmedSwitchClass[] = switchData.classes.map(record => ({
  ...record,
  skills: record.skills.map(skill => {
    const [id, kind, name] = skill
    if (skill.length !== 3 || !id || !name || (kind !== 'ability' && kind !== 'passive')) throw new Error(`Invalid confirmed Switch skill for ${record.name}`)
    return [id, kind, name] as const
  }),
}))
export const SWITCH_CLASS_SOURCE: SourceRef = switchData.source
const DETAILS_UNKNOWN = 'Only names, node kinds, and class associations were confirmed in game'
const MOD_UNKNOWN = 'The class source or required mod has not been confirmed'

function known(value: JsonValue, sources: readonly SourceRef[]): Knowledge<JsonValue> {
  return { state: 'known', value, sources }
}

export function confirmedSwitchDefinitions(existing: readonly CatalogEntity[]): readonly CatalogEntity[] {
  return SWITCH_CLASS_RECORDS.flatMap(record => {
    const sources = [{ ...SWITCH_CLASS_SOURCE, locator: `${record.name} class and skill identities` }]
    const unknown = { state: 'unknown' as const, reason: DETAILS_UNKNOWN, sources }
    const mod = record.requiredMod ? known(record.requiredMod, sources) : { state: 'unknown' as const, reason: MOD_UNKNOWN, sources }
    const previous = existing.find(entity => entity.id === record.id)
    const classEntity: CatalogEntity = {
      id: record.id as EntityId,
      kind: 'class',
      name: record.name,
      aliases: [],
      requirements: unknown,
      grants: unknown,
      ...previous,
      fields: {
        ...previous?.fields,
        'Source mod': mod,
        ...(!previous ? { Description: unknown, 'Stat growth': unknown, Weapons: unknown, Armor: unknown } : {}),
        'Innate passive(s)': record.innate ? known([record.innate.name], sources) : previous?.fields['Innate passive(s)'] ?? unknown,
      },
      sources: [...(previous?.sources ?? []), ...sources],
    }
    const skills: CatalogEntity[] = record.skills.map(([id, kind, name]) => ({
      id: id as EntityId,
      kind,
      name,
      aliases: [],
      fields: { Class: known(record.name, sources), 'Source mod': mod, Type: unknown, Description: unknown, 'MP cost': unknown, 'AP cost': unknown },
      ...(kind === 'passive' ? { ppCost: unknown, slotKinds: unknown, requirements: unknown, grants: unknown } : {}),
      sources,
    }))
    if (record.innate) skills.push({
      id: record.innate.id as EntityId,
      kind: 'innate',
      name: record.innate.name,
      aliases: [],
      fields: { Class: known(record.name, sources), 'Source mod': mod, Description: unknown, 'Learnable from this skill tree': known(record.innate.learnableFromTree, sources) },
      ppCost: unknown,
      slotKinds: unknown,
      requirements: unknown,
      grants: unknown,
      sources,
    })
    return [classEntity, ...skills]
  })
}
