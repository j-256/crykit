import type { CatalogEntity, CatalogSnapshot, JsonValue, Knowledge, KnowledgeClaim, SourceRef } from '../domain/types'
import { LEARNABLE_INNATE_FIELD } from './switch'
import innatesJson from './learnable-innates.json' with { type: 'json' }

interface InnateSource {
  readonly projectId: string
  readonly title: string
  readonly version: string
  readonly editorVersion: number
  readonly timestamp: string | null
  readonly sha256: string
}

interface InnateRecord {
  readonly classId: number
  readonly className: string
  readonly passive: Readonly<Record<string, JsonValue>>
  readonly positions: readonly { readonly column: number; readonly row: number; readonly prerequisites: { readonly left: boolean; readonly middle: boolean; readonly right: boolean } }[]
}

interface InnateData {
  readonly source: InnateSource
  readonly innates: readonly InnateRecord[]
}

const DATA = innatesJson as unknown as InnateData
const SOURCE_APPLICABILITY = 'Dated PC mod export from 2023; unlock costs and other values may predate the Nintendo Switch release and are not confirmation of current behavior'
const JP_FIELD = 'Learnable Innate Skill v1.0 JP cost'
const PP_FIELD = 'Learnable Innate Skill v1.0 PP cost'
const POSITION_FIELD = 'Learnable Innate Skill v1.0 tree position'
const SOURCE_RECORD_FIELD = 'Learnable Innate Skill v1.0 source record'
const CLASS_PLACEMENTS_FIELD = 'Learnable Innate Skill v1.0 placements'

export const LEARNABLE_INNATES_SOURCE: SourceRef = Object.freeze({
  sourceId: `crystal-edit-export:${DATA.source.projectId}`,
  locator: `${DATA.source.title} project export`,
  snapshot: `Version ${DATA.source.version}; Crystal Edit ${DATA.source.editorVersion}${DATA.source.timestamp ? `; exported ${DATA.source.timestamp}` : ''}; SHA-256 ${DATA.source.sha256}`,
  applicability: SOURCE_APPLICABILITY,
})

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function uniqueSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return Array.from(new Map(sources.map(source => [JSON.stringify(source), source])).values())
}

function sourceFor(record: InnateRecord): SourceRef {
  return { ...LEARNABLE_INNATES_SOURCE, locator: `${record.className} > ${String(record.passive.Name)}; passive model ID ${String(record.passive.ID)}` }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeCurrentFirst<Value>(current: Knowledge<Value> | undefined, datedValue: Value, source: SourceRef): Knowledge<Value> {
  if (!current || current.state === 'unknown') return { state: 'known', value: datedValue, sources: [source] }
  if (current.state === 'known') return sameValue(current.value, datedValue) ? { ...current, sources: uniqueSources([...(current.sources ?? []), source]) } : current
  return current
}

function mergeDatedField(current: Knowledge<JsonValue> | undefined, value: JsonValue, source: SourceRef): Knowledge<JsonValue> {
  if (!current || current.state === 'unknown') return { state: 'known', value, sources: [source] }
  if (current.state === 'known' && sameValue(current.value, value)) return { ...current, sources: uniqueSources([...(current.sources ?? []), source]) }
  if (current.state === 'known') {
    const claims: readonly KnowledgeClaim<JsonValue>[] = [
      { value: current.value, sources: current.sources ?? [], note: 'Existing catalog evidence' },
      { value, sources: [source], note: 'Dated Learnable Innate Skills v1.0 export' },
    ]
    return { state: 'conflicting', claims }
  }
  if (current.state === 'conflicting') return current
  return current
}

function findExactEntity(entities: Readonly<Record<string, CatalogEntity>>, kind: CatalogEntity['kind'], name: string): CatalogEntity {
  const matches = Object.values(entities).filter(entity => entity.kind === kind && normalizedIdentity(entity.name) === normalizedIdentity(name))
  if (matches.length !== 1) throw new Error(`Expected one ${kind} identity for ${name}, found ${matches.length}`)
  return matches[0]!
}

function enrichInnate(entity: CatalogEntity, record: InnateRecord): CatalogEntity {
  const source = sourceFor(record)
  const pp = record.passive.PP
  const jp = record.passive.JP
  if (typeof pp !== 'number' || !Number.isSafeInteger(pp) || pp < 0 || typeof jp !== 'number' || !Number.isSafeInteger(jp) || jp < 0) throw new Error(`Invalid dated cost evidence for ${entity.name}`)
  const fields: Record<string, Knowledge<JsonValue>> = {
    ...entity.fields,
    [LEARNABLE_INNATE_FIELD]: mergeDatedField(entity.fields[LEARNABLE_INNATE_FIELD], true, source),
    [JP_FIELD]: { state: 'known', value: jp, sources: [source] },
    [PP_FIELD]: { state: 'known', value: pp, sources: [source] },
    [POSITION_FIELD]: { state: 'known', value: record.positions, sources: [source] },
    [SOURCE_RECORD_FIELD]: { state: 'known', value: record.passive as JsonValue, sources: [source] },
  }
  const datedDescription = record.passive.Description
  if (typeof datedDescription === 'string' && datedDescription) fields['Learnable Innate Skill v1.0 description'] = { state: 'known', value: datedDescription, sources: [source] }
  return {
    ...entity,
    fields,
    ppCost: mergeCurrentFirst(entity.ppCost, pp, source),
    sources: uniqueSources([...entity.sources, source]),
    ...(!entity.rawDescription && typeof datedDescription === 'string' && datedDescription ? { rawDescription: datedDescription } : {}),
  }
}

export function addLearnableInnateFacts(base: CatalogSnapshot): CatalogSnapshot {
  const entities = { ...base.entities }
  const placementsByClass = new Map<string, { values: JsonValue[]; sources: SourceRef[] }>()
  for (const record of DATA.innates) {
    const name = String(record.passive.Name)
    const innate = findExactEntity(entities, 'innate', name)
    entities[innate.id] = enrichInnate(innate, record)
    const source = sourceFor(record)
    const placements = placementsByClass.get(record.className) ?? { values: [], sources: [] }
    placements.values.push({ innate: name, pp: record.passive.PP ?? null, jp: record.passive.JP ?? null, positions: record.positions })
    placements.sources.push(source)
    placementsByClass.set(record.className, placements)
  }
  for (const [className, placements] of placementsByClass) {
    const classEntity = findExactEntity(entities, 'class', className)
    const sources = uniqueSources(placements.sources)
    entities[classEntity.id] = {
      ...classEntity,
      fields: { ...classEntity.fields, [CLASS_PLACEMENTS_FIELD]: { state: 'known', value: placements.values, sources } },
      sources: uniqueSources([...classEntity.sources, ...sources]),
    }
  }
  return { ...base, entities }
}
