import type { CatalogEntity, EntityId, Knowledge, JsonValue, SourceRef } from '../domain/types'
import { nativeRecord } from '../domain/native-game'
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
export const SWITCH_PASSIVE_PP_SOURCE: SourceRef = switchData.passivePp.source
export const SWITCH_PASSIVE_PP_COSTS = switchData.passivePp.costs.map(record => {
  const id = record[0]
  const cost = record[1]
  if (record.length !== 2 || typeof id !== 'string' || !id || typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) throw new Error('Invalid confirmed Switch passive PP cost')
  return [id, cost] as const
})
export const SWITCH_INNATE_PP_NOT_APPLICABLE = switchData.passivePp.notApplicable.map(record => {
  const [id, reason] = record
  if (record.length !== 2 || !id || !reason) throw new Error('Invalid confirmed Switch innate PP availability')
  return [id, reason] as const
})
const passivePpFactIds = [...SWITCH_PASSIVE_PP_COSTS, ...SWITCH_INNATE_PP_NOT_APPLICABLE].map(([id]) => id)
if (new Set(passivePpFactIds).size !== passivePpFactIds.length) throw new Error('Duplicate confirmed Switch passive PP fact')
export const LEARNABLE_INNATE_FIELD = 'Learnable through Learnable Innate Skill'
const DETAILS_UNKNOWN = 'Only names, node kinds, and class associations were confirmed in game'
const MOD_UNKNOWN = 'The class source or required mod has not been confirmed'

function known(value: JsonValue, sources: readonly SourceRef[]): Knowledge<JsonValue> {
  return { state: 'known', value, sources }
}

function uniqueSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return Array.from(new Map(sources.map(source => [JSON.stringify(source), source])).values())
}

function passiveFactSource(entity: CatalogEntity, locator: string): SourceRef {
  const className = entity.fields.Class
  return {
    ...SWITCH_PASSIVE_PP_SOURCE,
    locator: `${className?.state === 'known' && typeof className.value === 'string' ? `${className.value} > ` : ''}${entity.name} > ${locator}`,
  }
}

function withConfirmedPpCost(entity: CatalogEntity, cost: number): CatalogEntity {
  if (entity.kind !== 'passive' && entity.kind !== 'innate') throw new Error(`Confirmed PP cost targets non-passive entity ${entity.id}`)
  if (entity.ppCost?.state === 'known' && entity.ppCost.value !== cost) throw new Error(`Confirmed PP cost conflicts with ${entity.id}`)
  if (entity.ppCost?.state === 'conflicting' || entity.ppCost?.state === 'notApplicable') throw new Error(`Confirmed PP cost cannot replace ${entity.ppCost.state} evidence for ${entity.id}`)
  const source = passiveFactSource(entity, entity.kind === 'innate' ? 'PP cost and Learnable Innate Skill availability' : 'PP cost')
  return {
    ...entity,
    fields: entity.kind === 'innate' ? { ...entity.fields, [LEARNABLE_INNATE_FIELD]: known(true, [source]) } : entity.fields,
    ppCost: { state: 'known', value: cost, sources: uniqueSources([...(entity.ppCost?.state === 'known' ? entity.ppCost.sources ?? [] : []), source]) },
    sources: uniqueSources([...entity.sources, source]),
  }
}

function withUnavailableInnate(entity: CatalogEntity, reason: string): CatalogEntity {
  if (entity.kind !== 'innate') throw new Error(`Confirmed innate availability targets ${entity.kind} entity ${entity.id}`)
  if (entity.ppCost?.state === 'known' || entity.ppCost?.state === 'conflicting') throw new Error(`Confirmed innate availability conflicts with PP evidence for ${entity.id}`)
  const source = passiveFactSource(entity, 'Learnable Innate Skill availability')
  return {
    ...entity,
    fields: { ...entity.fields, [LEARNABLE_INNATE_FIELD]: known(false, [source]) },
    ppCost: { state: 'notApplicable', reason },
    sources: uniqueSources([...entity.sources, source]),
  }
}

export function isPotentiallyLearnableInnate(entity: Pick<CatalogEntity, 'kind' | 'fields'>): boolean {
  if (entity.kind !== 'innate') return false
  const availability = entity.fields[LEARNABLE_INNATE_FIELD]
  if (availability?.state === 'known') return availability.value !== false
  const source = entity.fields['Crystal Edit source record'] ?? entity.fields['Native source record']
  if (source?.state === 'known' && nativeRecord(source.value) && typeof source.value.IsLearnable === 'boolean') return source.value.IsLearnable
  return true
}

export function confirmedSwitchDefinitions(existing: readonly CatalogEntity[], { includeModLearning = true }: { readonly includeModLearning?: boolean } = {}): readonly CatalogEntity[] {
  const definitions = SWITCH_CLASS_RECORDS.flatMap(record => {
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
  const allById = new Map([...existing, ...definitions].map(entity => [entity.id as string, entity]))
  const confirmedById = new Map(definitions.map(entity => [entity.id as string, entity]))
  const apply = (id: string, enrich: (entity: CatalogEntity) => CatalogEntity) => {
    const entity = allById.get(id)
    if (!entity) throw new Error(`Missing confirmed Switch passive PP identity ${id}`)
    const enriched = enrich(entity)
    allById.set(id, enriched)
    confirmedById.set(id, enriched)
  }
  for (const [id, cost] of SWITCH_PASSIVE_PP_COSTS) if (includeModLearning || allById.get(id)?.kind !== 'innate') apply(id, entity => withConfirmedPpCost(entity, cost))
  if (includeModLearning) for (const [id, reason] of SWITCH_INNATE_PP_NOT_APPLICABLE) apply(id, entity => withUnavailableInnate(entity, reason))
  return [...confirmedById.values()]
}
