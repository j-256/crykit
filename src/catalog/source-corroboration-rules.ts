import type { CatalogEntity, JsonValue, Knowledge } from '../domain/types'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, classFields, RATING_FIELDS } from '../domain/crystal-edit'
import { nativeIdentity, nativeRecord, type NativeGameSnapshot, type NativeRecord } from '../domain/native-game'
import { sameValue } from '../domain/definition-values'

export interface FieldAssessment {
  readonly status: 'corroborated' | 'partial' | 'retained'
  readonly reason: string
  readonly evidence: readonly string[]
}

export interface ReviewedMechanic {
  readonly description: string
  readonly status: 'corroborated' | 'partial'
  readonly reason: string
  readonly evidence: readonly string[]
}

export interface CorroborationContext {
  readonly snapshot: NativeGameSnapshot
  readonly identities: Readonly<Record<string, { readonly database: string; readonly databaseId: number }>>
  readonly mechanics: Readonly<Record<string, ReviewedMechanic>>
}

const RETAINED: FieldAssessment = Object.freeze({ status: 'retained', reason: 'No reviewed game-code proof for the complete claim', evidence: [] })
const WEAPON_TYPES = new Set(['Sword', 'Axe', 'Dagger', 'Rapier', 'Katana', 'Spear', 'Scythe', 'Bow', 'Staff', 'Wand', 'Book'])
const EQUIPMENT_WORDS: Readonly<Record<string, string>> = Object.freeze({ swords: 'Sword', axes: 'Axe', daggers: 'Dagger', rapiers: 'Rapier', katanas: 'Katana', spears: 'Spear', scythes: 'Scythe', bows: 'Bow', staves: 'Staff', wands: 'Wand', books: 'Book', shields: 'Shield', 'heavy helmets': 'HeavyHead', 'medium helmets': 'MediumHead', 'light helmets': 'LightHead', 'heavy armor': 'HeavyBody', 'medium armor': 'MediumBody', 'light armor': 'LightBody' })
const WIKI_RATINGS: Readonly<Record<string, keyof typeof RATING_FIELDS>> = Object.freeze({ 'Max. HP': 'HP', 'Max. MP': 'MP', Strength: 'STR', Vitality: 'VIT', Dexterity: 'DEX', Agility: 'AGI', Mind: 'MND', Spirit: 'SPI', Speed: 'SPD', Luck: 'LUK' })
const STAT_TAGS: Readonly<Record<string, string>> = Object.freeze({ Attack: 'Flat_PAtk', Defense: 'Flat_PDef', Resistance: 'Flat_MDef', 'Def pierce': 'Flat_PPen', 'Res pierce': 'Flat_MPen', Accuracy: 'Flat_PAccRating', Evasion: 'Flat_PEvaRating', Strength: 'Flat_Str', Vitality: 'Flat_Vit', Dexterity: 'Flat_Dex', Agility: 'Flat_Agi', Mind: 'Flat_Mnd', Spirit: 'Flat_Spi', Speed: 'Flat_Spd', Luck: 'Flat_Lck', 'Max hp': 'Flat_HP', 'Max mp': 'Flat_MP' })
const ORDINARY_STAT_TAGS = new Set(Object.values(STAT_TAGS))
const COMPOSITE_STATS: Readonly<Record<string, string>> = Object.freeze({ Attack: 'Attack', Defense: 'Defense', Resistance: 'Resistance', 'Def. Pierce': 'Def pierce', 'Res. Pierce': 'Res pierce', Accuracy: 'Accuracy', Evasion: 'Evasion', Strength: 'Strength', Vitality: 'Vitality', Dexterity: 'Dexterity', Agility: 'Agility', Mind: 'Mind', Spirit: 'Spirit', Speed: 'Speed', Luck: 'Luck', 'Max. HP': 'Max hp', 'Max. MP': 'Max mp' })
const CLASS_COPY_FIELDS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(CRYSTAL_EDIT_FIELDS).map(([key, field]) => [field, CLASS_FIELDS[key as keyof typeof CLASS_FIELDS]])))
const RESOURCE_COSTS = ['HP', 'MP', 'AP', 'CT', 'CD'] as const
const RATING_PER_STAR = 20
const JP_PER_LP = 100

function proof(reason: string, evidence: readonly string[]): FieldAssessment {
  return { status: 'corroborated', reason, evidence }
}

function equalNumber(value: unknown, expected: JsonValue | undefined): boolean {
  return typeof expected === 'number' && (typeof value === 'number' && value === expected || typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) && Number(value) === expected)
}

function numericStat(record: NativeRecord, name: string, snapshot: NativeGameSnapshot): number | undefined {
  const tag = STAT_TAGS[name]
  if (!tag || !Array.isArray(record.StatMods)) return undefined
  const mods = record.StatMods.filter(nativeRecord).filter(mod => snapshot.enums.SangStatModTag?.[String(mod.Tag)] === tag)
  if (!mods.length || mods.some(mod => typeof mod.Value1 !== 'number')) return undefined
  return mods.reduce((sum, mod) => sum + (mod.Value1 as number), 0)
}

export function assessCatalogField(context: CorroborationContext, entity: CatalogEntity, field: string, value: Knowledge<unknown>): FieldAssessment {
  if (value.state !== 'known') return { ...RETAINED, reason: 'Unknown, conflicting, and inapplicable claims retain their evidence' }
  const mechanic = context.mechanics[entity.id]
  if (field === 'Description' && mechanic && sameValue(value.value, mechanic.description)) return { status: mechanic.status, reason: mechanic.reason, evidence: mechanic.evidence }
  const native = nativeIdentity(entity)
  const identity = native ?? context.identities[entity.id]
  if (!identity || native && native.mode !== 'base') return RETAINED
  const records = context.snapshot.databases[identity.database]
  const record = Array.isArray(records) ? records.find(candidate => nativeRecord(candidate) && candidate.ID === identity.databaseId) : undefined
  if (!nativeRecord(record)) return RETAINED
  const database = `Database/${identity.database}.dat; ID ${identity.databaseId}`
  const direct = (expected: unknown, member: string, evidence: readonly string[] = []): FieldAssessment => sameValue(value.value, expected) ? proof(`Exact native identity and ${member} agree`, [database, ...evidence]) : { ...RETAINED, reason: `The complete value does not match native ${member}`, evidence: [database, ...evidence] }
  if (field === 'Level') return equalNumber(value.value, record.Level) ? proof('The recorded level agrees', [database]) : RETAINED
  if (field === 'Value' && ['item', 'equipment'].includes(identity.database)) return equalNumber(value.value, record.Cost) ? proof('The price in copper agrees', [database, 'currency']) : RETAINED
  if (field === 'PP cost' && identity.database === 'passive') return equalNumber(value.value, record.PP) ? proof('The PP cost agrees in the inspected Windows build', [database, 'passive']) : RETAINED
  if (identity.database === 'job') {
    const fields = classFields(record, { sourceId: 'native-game' }, CLASS_FIELDS)
    const counterpart = CLASS_COPY_FIELDS[field]
    if (counterpart) {
      const expected = fields[counterpart]
      return expected?.state === 'known' ? direct(expected.value, counterpart, ['class']) : RETAINED
    }
    if (field === 'Command') return direct(record.AbilitiesName, 'AbilitiesName', ['class'])
    if (field === 'Weapons' || field === 'Armor') {
      if (typeof value.value !== 'string' || !Array.isArray(record.EquipmentTypes)) return RETAINED
      const actual = value.value.split(',').map(word => EQUIPMENT_WORDS[word.trim().toLowerCase()])
      const expected = record.EquipmentTypes.map(code => context.snapshot.enums.EquipmentType?.[String(code)]).filter((type): type is string => Boolean(type) && (field === 'Weapons' ? WEAPON_TYPES.has(type!) : !WEAPON_TYPES.has(type!) && type !== 'Accessory'))
      return actual.every(Boolean) && sameValue([...actual].sort(), [...expected].sort()) ? proof('Equipment permissions agree', [database, 'class', 'equipment-types']) : RETAINED
    }
    if (field === 'Stat growth' && nativeRecord(value.value)) {
      const entries = Object.entries(value.value)
      const matches = entries.length === Object.keys(WIKI_RATINGS).length && entries.every(([name, stars]) => {
        const stat = WIKI_RATINGS[name]
        const number = typeof stars === 'string' ? /^(\d+(?:\.\d+)?) Stars?$/.exec(stars)?.[1] : undefined
        const rating = stat ? record[RATING_FIELDS[stat]] : undefined
        return typeof rating === 'number' && rating > 0 && number !== undefined && Number(number) * RATING_PER_STAR === rating
      })
      return matches ? proof('All displayed star ratings agree with native ratings', [database, 'class-growth-display']) : RETAINED
    }
  }
  if (identity.database === 'equipment') {
    if (field === 'Hands' && typeof record.IsTwoHanded === 'boolean') return direct(record.IsTwoHanded ? 2 : 1, 'IsTwoHanded', ['equipment'])
    if (field === 'Unique' && typeof record.IsOneOnly === 'boolean') return direct(record.IsOneOnly ? 'Yes' : 'No', 'IsOneOnly', ['equipment'])
    if (field === 'Other effects' && value.value === '-' && Array.isArray(record.StatMods) && record.StatMods.every(mod => nativeRecord(mod) && ORDINARY_STAT_TAGS.has(context.snapshot.enums.SangStatModTag?.[String(mod.Tag)] ?? ''))) return proof('The record contains only ordinary flat stat modifiers', [database, 'stat-modifiers'])
    const stat = numericStat(record, field, context.snapshot)
    if (stat !== undefined) return equalNumber(value.value, stat) ? proof('The listed flat stat modifiers agree', [database, 'stat-modifiers']) : { ...RETAINED, reason: 'The listed stat differs from the native flat modifiers', evidence: [database, 'stat-modifiers'] }
    if (field.includes('/') && typeof value.value === 'string') {
      const parts = value.value.split('\n')
      const matches = parts.length > 0 && parts.every(part => {
        if (part === '1-Handed' || part === '2-Handed') return typeof record.IsTwoHanded === 'boolean' && part === `${record.IsTwoHanded ? 2 : 1}-Handed`
        const match = /^([^:]+): ([+-]?\d+)$/.exec(part)
        const name = match && COMPOSITE_STATS[match[1]!]
        const stat = name ? numericStat(record, name, context.snapshot) : undefined
        return match && stat !== undefined && Number(match[2]) === stat
      })
      if (matches) return proof('Every listed component agrees with native equipment data', [database, 'equipment', 'stat-modifiers'])
    }
  }
  if (identity.database === 'ability') {
    const cost = RESOURCE_COSTS.find(resource => field === `${resource} cost`)
    if (cost) return equalNumber(value.value, record[`${cost}Cost`]) ? proof('The resource cost agrees', [database, 'ability']) : RETAINED
    if (field === 'Cost') {
      if (!RESOURCE_COSTS.every(resource => typeof record[`${resource}Cost`] === 'number')) return RETAINED
      const costs = RESOURCE_COSTS.filter(resource => record[`${resource}Cost`] !== 0).map(resource => `${record[`${resource}Cost`]}${resource === 'HP' ? '%' : ''} ${resource}`)
      return direct(costs.join('\n') || 'None', 'resource costs', ['ability'])
    }
  }
  if (field === 'Cost' && identity.database === 'passive' && typeof record.PP === 'number') return direct(`${record.PP} PP`, 'PP', ['passive'])
  if (field === 'Learning cost' && ['ability', 'passive'].includes(identity.database) && typeof record.JP === 'number' && record.JP % JP_PER_LP === 0) return equalNumber(value.value, record.JP / JP_PER_LP) ? proof('The learning cost agrees in whole LP', [database, 'learning-cost']) : RETAINED
  return RETAINED
}
