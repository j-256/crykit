import type { CatalogEntity, CatalogEntityKind, CatalogSnapshot, EntityId, JsonValue, Knowledge, NumericContribution, SourceRef } from '../domain/types'
import expansionJson from './equipment-expansion.json' with { type: 'json' }

interface ExpansionSource {
  readonly projectId: string
  readonly title: string
  readonly author: string | null
  readonly version: string
  readonly editorVersion: number
  readonly timestamp: string | null
  readonly sha256: string
  readonly steamWorkshopFileId: string | null
}

interface ExpansionData {
  readonly source: ExpansionSource
  readonly equipmentTypes: readonly string[]
  readonly statModTags: Readonly<Record<string, string>>
  readonly families: Readonly<Record<string, readonly Readonly<Record<string, JsonValue>>[]>>
}

const DATA = expansionJson as unknown as ExpansionData
const FAMILY_KINDS: Readonly<Record<string, CatalogEntityKind>> = Object.freeze({ Equipment: 'item', Abilities: 'ability', Statuses: 'status', Recipes: 'recipe', Items: 'item', Monsters: 'monster' })
const ELEMENTS = Object.freeze(['Fire', 'Ice', 'Wind', 'Earth', 'Thunder', 'Water'])
const REACTIONS = Object.freeze(['On physical damage taken', 'On magical damage taken', 'On near death', 'On physical hit dodged', 'On physical critical hit taken', 'On each turn', 'On killed', 'On damage taken', 'On ability used', 'On skip turn', 'On healing taken', 'On physical ability used', 'On magical ability used', 'On healing used', 'On physical critical hit given', 'On basic ability used'])
const OMITTED_DETAIL_FIELDS = new Set(['ID', 'Name', 'Description', 'Flavor', 'Comments', 'StatMods', 'TexturePath', 'TextureIndex'])
const SOURCE_APPLICABILITY = 'Exact values from the supplied Equipment Expansion PC mod export; parity with the Nintendo Switch bundled revision is unverified'

export const EQUIPMENT_EXPANSION_SOURCE: SourceRef = Object.freeze({
  sourceId: `crystal-edit-export:${DATA.source.projectId}`,
  locator: `${DATA.source.title} project export`,
  snapshot: `Version ${DATA.source.version}; Crystal Edit ${DATA.source.editorVersion}${DATA.source.timestamp ? `; exported ${DATA.source.timestamp}` : ''}; SHA-256 ${DATA.source.sha256}`,
  applicability: SOURCE_APPLICABILITY,
})

function normalizedSlug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function entityId(family: string, name: string): EntityId {
  return `equipment-expansion:${FAMILY_KINDS[family]}:${normalizedSlug(name)}` as EntityId
}

function uniqueSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return Array.from(new Map(sources.map(source => [JSON.stringify(source), source])).values())
}

function known<Value extends JsonValue>(value: Value, source: SourceRef): Knowledge<Value> {
  return { state: 'known', value, sources: [source] }
}

function sourceFor(family: string, index: number, record: Readonly<Record<string, JsonValue>>): SourceRef {
  return { ...EQUIPMENT_EXPANSION_SOURCE, locator: `/${family}/${index}; model ID ${String(record.ID)}` }
}

function recordName(record: Readonly<Record<string, JsonValue>>): string {
  if (typeof record.Name !== 'string' || !record.Name) throw new Error('Equipment Expansion record has no name')
  return record.Name
}

function recordDetails(record: Readonly<Record<string, JsonValue>>): JsonValue {
  return Object.fromEntries(Object.entries(record).filter(([name]) => !OMITTED_DETAIL_FIELDS.has(name)))
}

function recordIndex(family: string): ReadonlyMap<number, string> {
  return new Map((DATA.families[family] ?? []).flatMap(record => typeof record.ID === 'number' && typeof record.Name === 'string' ? [[record.ID, record.Name] as const] : []))
}

const ABILITIES = recordIndex('Abilities')
const STATUSES = recordIndex('Statuses')

function resolvedValue(tag: number, value1: number, value2: number): { readonly value1?: string; readonly value2?: string } {
  if ([81, 400, 405].includes(tag)) return { value1: ELEMENTS[value1] ?? `Element #${value1}` }
  if ([82, 401, 402, 471, 545].includes(tag)) return { value1: STATUSES.get(value1) ?? `Status #${value1}` }
  if (tag === 403) return { value1: REACTIONS[value1] ?? `Reaction #${value1}`, value2: ABILITIES.get(value2) ?? `Ability #${value2}` }
  if (tag === 406) return { value1: DATA.equipmentTypes[value1] ?? `Equipment type #${value1}` }
  if (tag === 487) return { value1: ABILITIES.get(value1) ?? `Ability #${value1}` }
  return {}
}

function statModifiers(record: Readonly<Record<string, JsonValue>>): JsonValue {
  if (!Array.isArray(record.StatMods)) return []
  return record.StatMods.map((modifier): JsonValue => {
    if (!modifier || typeof modifier !== 'object' || Array.isArray(modifier)) return { Modifier: 'Invalid source modifier', Source: modifier }
    const source = modifier as Readonly<Record<string, JsonValue>>
    const tag = typeof source.Tag === 'number' ? source.Tag : -1
    const value1 = typeof source.Value1 === 'number' ? source.Value1 : 0
    const value2 = typeof source.Value2 === 'number' ? source.Value2 : 0
    const resolved = resolvedValue(tag, value1, value2)
    const row: Record<string, JsonValue> = {
      Modifier: DATA.statModTags[String(tag)] ?? `Unknown tag ${tag}`,
      Tag: tag,
      'Value 1': source.Value1 ?? null,
      'Value 2': source.Value2 ?? null,
      'Value 3': source.Value3 ?? null,
      'Resolved value 1': resolved.value1 ?? '',
      'Resolved value 2': resolved.value2 ?? '',
    }
    return row
  })
}

const DIRECT_CONTRIBUTIONS: Readonly<Record<number, readonly [label: string, unit: string]>> = Object.freeze({
  0: ['Max HP', 'listed flat value'], 1: ['Max MP', 'listed flat value'], 6: ['Strength', 'listed flat value'], 7: ['Vitality', 'listed flat value'], 8: ['Dexterity', 'listed flat value'], 9: ['Agility', 'listed flat value'], 10: ['Mind', 'listed flat value'], 11: ['Spirit', 'listed flat value'], 12: ['Speed', 'listed flat value'], 13: ['Luck', 'listed flat value'],
  20: ['Max HP', 'percent'], 21: ['Max MP', 'percent'], 26: ['Strength', 'percent'], 27: ['Vitality', 'percent'], 28: ['Dexterity', 'percent'], 29: ['Agility', 'percent'], 30: ['Mind', 'percent'], 31: ['Spirit', 'percent'], 32: ['Speed', 'percent'], 33: ['Luck', 'percent'],
  40: ['Attack', 'listed flat value'], 41: ['Def. Pierce', 'percentage points'], 42: ['Defense', 'listed flat value'], 43: ['Crit. Chance', 'percentage points'], 44: ['Crit. Damage', 'percentage points'], 45: ['Accuracy', 'listed flat value'], 46: ['Evasion', 'listed flat value'], 47: ['Res. Pierce', 'percentage points'], 48: ['Resistance', 'listed flat value'],
  60: ['Attack', 'percent'], 61: ['Def. Pierce', 'percentage points'], 62: ['Defense', 'percent'], 65: ['Accuracy', 'percent'], 66: ['Evasion', 'percent'], 67: ['Res. Pierce', 'percentage points'], 68: ['Resistance', 'percent'],
})

function listedContributions(record: Readonly<Record<string, JsonValue>>, source: SourceRef): Readonly<Record<string, Knowledge<NumericContribution>>> | undefined {
  if (!Array.isArray(record.StatMods)) return undefined
  const sums = new Map<string, { label: string; unit: string; value: number }>()
  for (const modifier of record.StatMods) {
    if (!modifier || typeof modifier !== 'object' || Array.isArray(modifier) || typeof modifier.Tag !== 'number' || typeof modifier.Value1 !== 'number') continue
    const mapped = DIRECT_CONTRIBUTIONS[modifier.Tag]
    if (!mapped) continue
    const [label, unit] = mapped
    const key = `${label}\u0000${unit}`
    const previous = sums.get(key)
    sums.set(key, { label, unit, value: (previous?.value ?? 0) + modifier.Value1 })
  }
  if (!sums.size) return undefined
  return Object.fromEntries([...sums.values()].map(({ label, unit, value }) => [`${label}${unit === 'listed flat value' ? '' : ` (${unit})`}`, { state: 'known', value: { value, unit }, sources: [source] }]))
}

function commonFields(family: string, record: Readonly<Record<string, JsonValue>>, source: SourceRef): Readonly<Record<string, Knowledge<JsonValue>>> {
  const description = typeof record.Description === 'string' && record.Description ? known(record.Description, source) : { state: 'unknown' as const, reason: 'No description is supplied in this export', sources: [source] }
  return {
    'Source mod': known('Equipment Expansion', source),
    'Mod version': known(DATA.source.version, source),
    'Crystal Edit model ID': known(record.ID ?? null, source),
    'Crystal Edit model type': known(family, source),
    Description: description,
    ...(typeof record.Flavor === 'string' && record.Flavor ? { Flavor: known(record.Flavor, source) } : {}),
    ...(typeof record.Comments === 'string' && record.Comments ? { 'Author comments': known(record.Comments, source) } : {}),
    'Definition details': known(recordDetails(record), source),
    'Crystal Edit source record': known(record as JsonValue, source),
  }
}

function equipmentFields(record: Readonly<Record<string, JsonValue>>, source: SourceRef): Readonly<Record<string, Knowledge<JsonValue>>> {
  const equipmentType = typeof record.EquipmentType === 'number' ? DATA.equipmentTypes[record.EquipmentType] : undefined
  if (!equipmentType) throw new Error(`Invalid Equipment Expansion type for ${recordName(record)}`)
  return {
    ...commonFields('Equipment', record, source),
    Category: known([equipmentType, 'Equipment Expansion'], source),
    'Equipment type': known(equipmentType, source),
    Level: known(record.Level ?? null, source),
    Cost: known(record.Cost ?? null, source),
    'Maximum capacity': known(record.MaxCapacity ?? null, source),
    Unique: known(record.IsOneOnly ?? false, source),
    ...(typeof record.EquipmentType === 'number' && record.EquipmentType <= 10 ? { Hands: known(record.IsTwoHanded === true ? '2-Handed' : '1-Handed', source) } : {}),
    'Prevent automatic equip': known(record.PreventAutoEquip ?? false, source),
    'Stat modifiers': known(statModifiers(record), source),
    'Texture reference': known({ path: record.TexturePath ?? null, index: record.TextureIndex ?? null }, source),
  }
}

function addRecord(base: CatalogEntity | undefined, family: string, record: Readonly<Record<string, JsonValue>>, index: number): CatalogEntity {
  const name = recordName(record)
  const kind = FAMILY_KINDS[family]
  const id = entityId(family, name)
  if (!kind) throw new Error(`Unsupported Equipment Expansion family ${family}`)
  if (base && (base.id !== id || base.kind !== kind || base.name !== name)) throw new Error(`Equipment Expansion identity collision for ${name}`)
  const source = sourceFor(family, index, record)
  const fields = { ...(base?.fields ?? {}) }
  delete fields['Wiki coverage']
  Object.assign(fields, family === 'Equipment' ? equipmentFields(record, source) : commonFields(family, record, source))
  const contributions = family === 'Equipment' ? listedContributions(record, source) : undefined
  return {
    ...base,
    id,
    kind,
    name,
    aliases: base?.aliases ?? [],
    fields,
    ...(typeof record.Description === 'string' && record.Description ? { rawDescription: record.Description } : base?.rawDescription ? { rawDescription: base.rawDescription } : {}),
    ...(contributions ? { listedContributions: contributions } : base?.listedContributions ? { listedContributions: base.listedContributions } : {}),
    sources: uniqueSources([...(base?.sources ?? []), source]),
    legacy: { ...(base?.legacy && typeof base.legacy === 'object' && !Array.isArray(base.legacy) ? base.legacy : {}), equipmentExpansion: { family, modelId: record.ID ?? null } },
  }
}

export const EQUIPMENT_EXPANSION_ENTITY_IDS: readonly string[] = Object.freeze(Object.entries(DATA.families).flatMap(([family, records]) => records.map(record => entityId(family, recordName(record)) as string)))
export const EQUIPMENT_EXPANSION_EQUIPMENT_IDS: readonly string[] = Object.freeze((DATA.families.Equipment ?? []).map(record => entityId('Equipment', recordName(record)) as string))

export function addEquipmentExpansionFacts(base: CatalogSnapshot): CatalogSnapshot {
  const entities = { ...base.entities }
  delete entities['equipment-expansion:item:tarot-accessories']
  for (const [family, records] of Object.entries(DATA.families)) for (const [index, record] of records.entries()) {
    const id = entityId(family, recordName(record))
    entities[id] = addRecord(entities[id], family, record, index)
  }
  const coverage = entities['wiki:other:catalog-coverage-gaps']
  const gaps = coverage?.fields['Known catalog families without full details']
  if (coverage && gaps?.state === 'known' && Array.isArray(gaps.value)) {
    const value = gaps.value.map(gap => gap && typeof gap === 'object' && !Array.isArray(gap) && gap.subject === 'Equipment Expansion' ? { ...gap, missing: 'Verification against the Switch-bundled revision' } : gap)
    entities[coverage.id] = { ...coverage, fields: { ...coverage.fields, 'Known catalog families without full details': { ...gaps, value } } }
  }
  return { ...base, entities }
}
