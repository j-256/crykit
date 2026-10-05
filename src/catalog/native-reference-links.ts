import manifestJson from './native-reference-links.json' with { type: 'json' }
import { BUNDLED_CATALOG, bundledCatalogForSnapshot } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeIdentity, nativeRecord, nativeSourceRecord, type NativeGameSnapshot } from '../domain/native-game'
import { formatNativeTemplate } from '../domain/native-description'
import type { CatalogEntity, CatalogSnapshot, EntityId, JsonValue } from '../domain/types'

export type NativeReferenceRelation = 'same-definition' | 'command-of-class'
export type NativeReferenceDisposition = 'native-linked' | 'mod-source-review' | 'native-mechanics-review' | 'native-geography-review' | 'article-review' | 'native-identity-review'

interface RelatedRecordEvidence {
  readonly entityId: string
  readonly nativeFields: Readonly<Record<string, JsonValue>>
}

export interface NativeReferenceLink {
  readonly sourceId: string
  readonly targetId: string
  readonly relation: NativeReferenceRelation
  readonly review: string
  readonly basis: string
  readonly evidence: {
    readonly sourceName: string
    readonly sourceKind: CatalogEntity['kind']
    readonly sourceFields: Readonly<Record<string, JsonValue>>
    readonly nativeFields: Readonly<Record<string, JsonValue>>
    readonly relatedRecords: readonly RelatedRecordEvidence[]
  }
}

export interface NativeReferenceLinksManifest {
  readonly schemaVersion: number
  readonly catalog: { readonly id: string; readonly revisionId: string; readonly checksum: string }
  readonly native: {
    readonly contentDigest: string
    readonly executableSha256: string
    readonly files: readonly { readonly path: string; readonly sha256: string }[]
  }
  readonly links: readonly NativeReferenceLink[]
  readonly dispositions: readonly { readonly entityId: string; readonly disposition: NativeReferenceDisposition }[]
}

export const NATIVE_REFERENCE_LINKS = manifestJson as unknown as NativeReferenceLinksManifest
const LINKS = new Map(NATIVE_REFERENCE_LINKS.links.map(link => [link.sourceId, link]))
const DISPOSITIONS = new Map(NATIVE_REFERENCE_LINKS.dispositions.map(entry => [entry.entityId, entry.disposition]))
const REVIEWS = new Set(['class-membership', 'class-command', 'equipment-facts', 'item-text', 'map-item', 'monster-facts', 'recipe-ingredients', 'status-facts'])
const DISPOSITION_VALUES = new Set<NativeReferenceDisposition>(['native-linked', 'mod-source-review', 'native-mechanics-review', 'native-geography-review', 'article-review', 'native-identity-review'])

function sameValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

function matchesCatalog(catalog: CatalogSnapshot, manifest = NATIVE_REFERENCE_LINKS): boolean {
  const exactPin = catalog.id === manifest.catalog.id && catalog.revisionId === manifest.catalog.revisionId && catalog.checksum === manifest.catalog.checksum
  const compatiblePin = manifest === NATIVE_REFERENCE_LINKS && Boolean(bundledCatalogForSnapshot(catalog))
  return (exactPin || compatiblePin) && nativeRecord(catalog.legacy) && catalog.legacy.sourceContentDigest === manifest.native.contentDigest
}

function matchesBaseline(catalog: CatalogSnapshot, entityId: string): boolean {
  const entity = catalog.entities[entityId]
  const baseline = BUNDLED_CATALOG.entities[entityId]
  return Boolean(entity && baseline && sameValue(entity, baseline))
}

function matchesRecordFields(entity: CatalogEntity | undefined, fields: Readonly<Record<string, JsonValue>>): boolean {
  const record = entity && nativeSourceRecord(entity)
  return Boolean(record && Object.entries(fields).every(([field, value]) => sameValue(record[field], value)))
}

const MONSTER_IDENTITY_STATS = ['Level', 'HP', 'MP', 'Str', 'Vit', 'Dex', 'Agi', 'Mnd', 'Spi', 'Spd', 'Lck'] as const
const EQUIPMENT_SOURCE_CATEGORIES = ['Swords', 'Axes', 'Daggers', 'Rapiers', 'Katanas', 'Spears', 'Scythes', 'Bows', 'Staves', 'Wands', 'Books', 'Shields', 'Heavy helmets', 'Medium headgear', 'Light hats', 'Heavy armor', 'Medium armor', 'Light armor', 'Accessories']
const EQUIPMENT_PROOF_STATS: Readonly<Record<string, string>> = { Attack: 'Flat_PAtk', Defense: 'Flat_PDef', Resistance: 'Flat_MDef' }
const COPPER_PER_UNIT: Readonly<Record<string, number>> = { Gold: 10_000, Silver: 100, Copper: 1 }

function proofPrice(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value !== 'string' || !/^(?:\d+ (?:Gold|Silver|Copper)(?:\s+|$))+$/.test(value)) return undefined
  return [...value.matchAll(/(\d+) (Gold|Silver|Copper)/g)].reduce((sum, match) => sum + Number(match[1]) * COPPER_PER_UNIT[match[2]!]!, 0)
}

function proofSufficient(link: NativeReferenceLink, source: CatalogEntity, target: CatalogEntity, catalog: CatalogSnapshot, snapshot: NativeGameSnapshot): boolean {
  const { sourceFields: original, nativeFields: native, relatedRecords } = link.evidence
  const identity = nativeIdentity(target)
  const fieldsPresent = (fields: Readonly<Record<string, JsonValue>>, names: readonly string[]) => names.every(name => Object.hasOwn(fields, name))
  const sameName = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
  const related = (family: string, id: JsonValue | undefined) => relatedRecords.find(entry => {
    const relatedIdentity = nativeIdentity(catalog.entities[entry.entityId]!)
    return relatedIdentity?.database === family && relatedIdentity.databaseId === id && relatedIdentity.mode === 'base' && fieldsPresent(entry.nativeFields, ['ID', 'Name']) && typeof entry.nativeFields.Name === 'string'
  })?.nativeFields
  const sorted = (values: readonly unknown[]) => values.map(value => JSON.stringify(value)).sort()
  if (!identity || identity.mode !== 'base' || !fieldsPresent(native, ['ID', 'Name']) || typeof native.Name !== 'string') return false
  if (link.review === 'class-command') return source.kind === 'command' && identity.database === 'job' && fieldsPresent(native, ['AbilitiesName', 'AbilityIDs']) && sameName(original.Class, native.Name) && source.name === native.AbilitiesName && Array.isArray(native.AbilityIDs) && native.AbilityIDs.length > 0
  if (link.review === 'class-membership') {
    if (!['innate', 'passive'].includes(source.kind) || identity.database !== 'passive' || !fieldsPresent(native, ['IsInnate', 'IsLearnable', 'PP']) || !sameName(source.name, native.Name) || source.ppCost?.state !== 'known' || source.ppCost.value !== native.PP) return false
    return relatedRecords.some(entry => {
      const job = related('job', entry.nativeFields.ID)
      return job && fieldsPresent(job, ['PassiveIDs']) && sameName(original.Class, job.Name) && Array.isArray(job.PassiveIDs) && job.PassiveIDs.includes(native.ID!)
    })
  }
  if (link.review === 'map-item') return source.kind === 'item' && identity.database === 'item' && source.name.endsWith(' Map') && sameName(source.name.slice(0, -4), native.Name) && fieldsPresent(native, ['MapForBiomeID']) && Boolean(related('biome', native.MapForBiomeID))
  if (link.review === 'equipment-facts') {
    if (source.kind !== 'item' || identity.database !== 'equipment' || !sameName(source.name, native.Name) || typeof native.EquipmentType !== 'number' || !Array.isArray(original.Category) || !original.Category.includes(EQUIPMENT_SOURCE_CATEGORIES[native.EquipmentType]!)) return false
    const costs = ['Cost', 'Value'].filter(field => Object.hasOwn(original, field))
    const stats = Object.keys(EQUIPMENT_PROOF_STATS).filter(field => Object.hasOwn(original, field))
    if (!costs.length && !stats.length || costs.some(field => !Object.hasOwn(native, 'Cost') || proofPrice(original[field]) !== native.Cost)) return false
    return stats.every(field => Array.isArray(native.StatMods) && typeof original[field] === 'number' && native.StatMods.filter(nativeRecord).filter(modifier => snapshot.enums.SangStatModTag?.[String(modifier.Tag)] === EQUIPMENT_PROOF_STATS[field]).reduce((sum, modifier) => sum + (typeof modifier.Value1 === 'number' ? modifier.Value1 : Number.NaN), 0) === original[field])
  }
  if (link.review === 'item-text') return source.kind === 'item' && identity.database === 'item' && sameName(source.name, native.Name) && Object.values(original).some(value => typeof value === 'string' && value.length > 0 && ['Flavor', 'Description'].some(field => Object.hasOwn(native, field) && native[field] === value))
  if (link.review === 'monster-facts') {
    const sourceName = source.name.replace(/ \((Blue|Red|River|Desert)\)$/, '')
    if (source.kind !== 'monster' || identity.database !== 'monster' || !sameName(sourceName, native.Name) || !MONSTER_IDENTITY_STATS.every(field => typeof original[field] === 'number' && original[field] === native[field]) || !Array.isArray(original.Abilities) || !original.Abilities.length || !Array.isArray(native.Actions) || !native.Actions.length) return false
    const actionNames = native.Actions.map(action => nativeRecord(action) ? related('ability', action.AbilityID)?.Name : undefined)
    if (actionNames.some(name => typeof name !== 'string') || !sameValue(sorted([...new Set(actionNames)]), sorted([...new Set(original.Abilities)]))) return false
    const lootFields = [['Drops', 'ItemDrops'], ['Steals', 'ItemSteals']] as const
    const supplied = lootFields.filter(([field]) => Object.hasOwn(original, field))
    return supplied.length > 0 && supplied.every(([field, nativeField]) => {
      const list = native[nativeField]
      const sourceList = original[field]
      if (!Array.isArray(list) || !Array.isArray(sourceList) || !list.length || !sourceList.length) return false
      const rows = list.map(loot => {
        if (!nativeRecord(loot) || ![1, 2].includes(loot.LootType as number) || typeof loot.LootChance !== 'number') return undefined
        const item = related(loot.LootType === 1 ? 'item' : 'equipment', loot.LootType === 1 ? loot.ItemID : loot.EquipmentID)
        return item ? { item: item.Name, chance: `${loot.LootChance}%` } : undefined
      })
      return rows.every(Boolean) && sourceList.every(nativeRecord) && sameValue(sorted(rows), sorted(sourceList.map(loot => ({ item: loot.item, chance: loot.chance }))))
    })
  }
  if (link.review === 'recipe-ingredients') {
    if (source.kind !== 'recipe' || identity.database !== 'recipe' || !sameName(source.name, native.Name) || !fieldsPresent(native, ['LootType', 'LootID', 'Cost', 'Ingredients']) || !Array.isArray(original.Ingredients) || !original.Ingredients.every(value => typeof value === 'string') || !Array.isArray(native.Ingredients) || !native.Ingredients.length) return false
    const ingredients = native.Ingredients.map(ingredient => {
      if (!nativeRecord(ingredient) || ![1, 2].includes(ingredient.LootType as number) || typeof ingredient.LootQuantity !== 'number') return undefined
      const item = related(ingredient.LootType === 1 ? 'item' : 'equipment', ingredient.LootID)
      return item ? `${ingredient.LootQuantity} ${item.Name}` : undefined
    })
    const sourceIngredients = original.Ingredients.filter(value => !/^\d+ (?:Silver|Gold|Copper)$/.test(value)).map(value => value.replace(/ \(.*\)$/, '').replace('Woke Quintar Eyes', 'Woke Quintar Eye'))
    const cost = original.Ingredients.filter(value => /^\d+ (?:Silver|Gold|Copper)$/.test(value)).reduce((sum, value) => sum + (proofPrice(value) ?? Number.NaN), 0)
    return ingredients.every(Boolean) && sameValue(sorted(ingredients), sorted(sourceIngredients)) && cost === native.Cost
  }
  if (link.review === 'status-facts') {
    const sourceName = source.name.replace(/ \((?:stance|buff|debuff)\)$/, '')
    const category = typeof native.Category === 'number' ? ({ 1: 'Buffs', 2: 'Debuffs', 3: 'Stances' } as Readonly<Record<number, string>>)[native.Category] : undefined
    if (source.kind !== 'status' || identity.database !== 'status' || !sameName(sourceName, native.Name) || !category || !Array.isArray(original.Category) || !original.Category.includes(category) || typeof original.Effect !== 'string' || !Array.isArray(native.StatMods) || !native.StatMods.length) return false
    const system = snapshot.databases.system
    const vocabulary = nativeRecord(system) && nativeRecord(system.Vocab) ? system.Vocab : {}
    const general = nativeRecord(vocabulary.General) ? vocabulary.General : {}
    const texts = native.StatMods.map(modifier => {
      if (!nativeRecord(modifier) || typeof modifier.Tag !== 'number' || typeof modifier.Value1 !== 'number' || typeof modifier.Value2 !== 'number' || !Array.isArray(vocabulary.StatModText)) return undefined
      const template = vocabulary.StatModText[modifier.Tag]
      return typeof template === 'string' ? formatNativeTemplate(template, general, modifier.Value1, modifier.Value2) : undefined
    })
    const normalize = (value: string) => value.toLowerCase().replace(/[.:%]/g, '').replace(/\s+/g, ' ').trim()
    return texts.every(text => text !== undefined) && normalize(texts.join(' ')) === normalize(original.Effect)
  }
  return false
}

export function validateNativeReferenceLinks(manifest: NativeReferenceLinksManifest, catalog: CatalogSnapshot = BUNDLED_CATALOG, snapshot: NativeGameSnapshot = NATIVE_GAME_DATA): void {
  if (manifest.schemaVersion !== 1 || !matchesCatalog(catalog, manifest) || !sameValue(manifest.catalog, NATIVE_REFERENCE_LINKS.catalog)) throw new Error('Native reference catalog pin differs')
  const expectedNative = { contentDigest: snapshot.contentDigest, executableSha256: snapshot.source.executable.sha256, files: snapshot.source.files.map(({ path, sha256 }) => ({ path, sha256 })) }
  if (!sameValue(manifest.native, expectedNative) || !sameValue(snapshot, NATIVE_GAME_DATA)) throw new Error('Native reference source fingerprints differ')
  const sourceIds = new Set<string>()
  const targetIds = new Set<string>()
  for (const link of manifest.links) {
    const source = catalog.entities[link.sourceId]
    const target = catalog.entities[link.targetId]
    const identity = target && nativeIdentity(target)
    if (sourceIds.has(link.sourceId) || targetIds.has(`${link.relation}:${link.targetId}`)) throw new Error('Native reference identity collision')
    sourceIds.add(link.sourceId)
    targetIds.add(`${link.relation}:${link.targetId}`)
    if (!source || !target || !link.sourceId.startsWith('base:') || !link.targetId.startsWith('base:') || nativeIdentity(source) || !identity || !REVIEWS.has(link.review) || !link.basis.trim()) throw new Error(`Invalid native reference identity: ${link.sourceId}`)
    if (link.relation !== 'same-definition' && link.relation !== 'command-of-class' || (link.relation === 'command-of-class') !== (source.kind === 'command' && identity.database === 'job')) throw new Error(`Invalid native reference relation: ${link.sourceId}`)
    if (!matchesBaseline(catalog, link.sourceId) || !matchesBaseline(catalog, link.targetId)) throw new Error(`Native reference entity differs from reviewed baseline: ${link.sourceId}`)
    if (source.name !== link.evidence.sourceName || source.kind !== link.evidence.sourceKind || Object.entries(link.evidence.sourceFields).some(([field, value]) => source.fields[field]?.state !== 'known' || !sameValue(source.fields[field].value, value))) throw new Error(`Native reference source evidence differs: ${link.sourceId}`)
    if (!matchesRecordFields(target, link.evidence.nativeFields) || !sameValue(link.evidence.nativeFields.ID, identity.databaseId) || link.evidence.relatedRecords.some(related => !matchesBaseline(catalog, related.entityId) || !matchesRecordFields(catalog.entities[related.entityId], related.nativeFields))) throw new Error(`Native reference record evidence differs: ${link.sourceId}`)
    if (!proofSufficient(link, source, target, catalog, snapshot)) throw new Error(`Native reference proof is insufficient: ${link.sourceId}`)
  }
  const dispositions = new Set<string>()
  for (const entry of manifest.dispositions) {
    const entity = catalog.entities[entry.entityId]
    if (dispositions.has(entry.entityId) || !entity || !DISPOSITION_VALUES.has(entry.disposition) || !nativeRecord(entity.legacy) || entity.legacy.supplemental !== true || entity.fields['Crystal Edit source record']) throw new Error('Invalid native reference disposition')
    if ((entry.disposition === 'native-linked') !== sourceIds.has(entry.entityId)) throw new Error('Native reference disposition disagrees with links')
    dispositions.add(entry.entityId)
  }
  for (const entity of Object.values(catalog.entities)) if (nativeRecord(entity.legacy) && entity.legacy.supplemental === true && !entity.fields['Crystal Edit source record'] && !dispositions.has(entity.id)) throw new Error(`Missing native reference disposition: ${entity.id}`)
}

export function nativeReferenceLink(catalog: CatalogSnapshot, entityId: string): NativeReferenceLink | undefined {
  const link = LINKS.get(entityId)
  if (!link || !matchesCatalog(catalog) || !matchesBaseline(catalog, entityId) || !matchesBaseline(catalog, link.targetId) || link.evidence.relatedRecords.some(related => !matchesBaseline(catalog, related.entityId))) return undefined
  return link
}

export function nativeReferenceAlternatives(catalog: CatalogSnapshot, targetId: string): readonly NativeReferenceLink[] {
  return NATIVE_REFERENCE_LINKS.links.filter(link => link.targetId === targetId && nativeReferenceLink(catalog, link.sourceId))
}

export function preferredNativeReferenceId(catalog: CatalogSnapshot, entityId: string): EntityId | undefined {
  const link = nativeReferenceLink(catalog, entityId)
  return link?.relation === 'same-definition' ? link.targetId as EntityId : undefined
}

export function nativeReferenceDisposition(catalog: CatalogSnapshot, entityId: string): NativeReferenceDisposition | undefined {
  return matchesCatalog(catalog) && matchesBaseline(catalog, entityId) ? DISPOSITIONS.get(entityId) : undefined
}

validateNativeReferenceLinks(NATIVE_REFERENCE_LINKS)
