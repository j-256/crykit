import { z } from 'zod'
import { nativeIdentity, nativeRecord, nativeSourceRecord } from './native-game.ts'
import type { CatalogEntity, CatalogSnapshot, CatalogRef, JsonValue } from './types'

const HASH = z.string().regex(/^[a-f0-9]{64}$/)
const CONDITION = z.object({ type: z.string().min(1), negated: z.boolean(), data: z.record(z.string(), z.json()) }).strict()
const MATERIAL = z.object({ family: z.enum(['item', 'equipment']), id: z.number().int().nonnegative(), count: z.number().int().positive() }).strict()
const SOURCE_FILE = z.object({ path: z.string(), sha256: HASH, size: z.number().int().positive() }).strict()
const WORLD_SCHEMA = z.object({
  schemaVersion: z.literal(1), contentDigest: HASH,
  source: z.object({ platform: z.literal('Windows'), gameVersion: z.string(), gameExecutableSha256: HASH, editorExecutableSha256: HASH, world: SOURCE_FILE, biomes: SOURCE_FILE, scope: z.string(), rights: z.string(), evidence: z.array(z.string()), nativeContentDigest: HASH, systemSha256: HASH }).strict(),
  entries: z.array(z.object({ family: z.enum(['item', 'equipment', 'recipe']), targetID: z.number().int().nonnegative(), kind: z.enum(['shop', 'chest', 'craft', 'reward', 'recovery', 'start']), entityID: z.number().int().nonnegative().optional(), biomeID: z.number().int().nonnegative().optional(), coord: z.object({ X: z.number().int(), Y: z.number().int(), Z: z.number().int() }).strict().optional(), label: z.string(), path: z.string(), conditions: z.array(CONDITION), count: z.number().int().positive().optional(), costs: z.array(MATERIAL).optional(), redirects: z.boolean().optional(), costRate: z.number().int().nonnegative().optional() }).strict()).max(100_000),
}).strict()
export const ACQUISITION_CONDITION_DATA_KEYS = Object.freeze(['Scope', 'EntityKey', 'VariableKey', 'Eval', 'VariableType', 'Flag', 'Number', 'SourceVariableScope', 'SourceVariableKey', 'LootType', 'LootValue', 'Count', 'Redirect', 'Type', 'State', 'MonsterID', 'Op', 'ActionType', 'Slot', 'SeedType', 'QuintarType', 'QuintarNature', 'RaceTrack', 'Track', 'RandomCrystals', 'RandomMonsters', 'RandomBosses', 'RandomItems', 'IncludeRecovery', 'IncludeProgression', 'ProgressionGate', 'InvalidItemID'])
const CONDITION_KEYS = new Set(ACQUISITION_CONDITION_DATA_KEYS)
const MAX_CONDITION_DEPTH = 32
export type WorldAcquisitionSnapshot = z.infer<typeof WORLD_SCHEMA>
export type AcquisitionCondition = z.infer<typeof CONDITION>
export type AcquisitionKind = 'shop' | 'drop' | 'steal' | 'chest' | 'craft' | 'reward' | 'recovery' | 'start'
export interface AcquisitionMaterial { readonly name: string; readonly count: number; readonly ref?: CatalogRef }
export interface AcquisitionRoute {
  readonly kind: AcquisitionKind
  readonly label: string
  readonly location?: string
  readonly station?: string
  readonly ref?: CatalogRef
  readonly quantity?: number
  readonly price?: number
  readonly chance?: number
  readonly success?: number
  readonly ingredients: readonly AcquisitionMaterial[]
  readonly costs: readonly AcquisitionMaterial[]
  readonly requirements: readonly AcquisitionMaterial[]
  readonly conditions: readonly string[]
  readonly coord?: { readonly X: number; readonly Y: number; readonly Z: number }
  readonly evidence: string
}
export interface ItemAcquisition {
  readonly routes: readonly AcquisitionRoute[]
  readonly worldMatched: boolean
  readonly guides: readonly { readonly field: string; readonly value: JsonValue }[]
  readonly unresolved: readonly string[]
}
const LOOT_ITEM = 1
const LOOT_EQUIPMENT = 2
const PERCENT = 100
const NATIVE_MODES = new Set(['base', 'Vanilla', 'Chaos'])
const GOLD_COPPER = 10_000
const SILVER_COPPER = 100
const ALWAYS = 'Always'
const NEVER = 'Never'
const DISABLED_INTERACTION = 'This interaction is disabled in the source'
const CONDITION_LABELS: Readonly<Record<string, string>> = Object.freeze({ CanUnderstandQuintar: 'Understand Quintars', IsGameCleared: 'Clear the game', PreviousBattleWasVictory: 'Win the preceding battle', IsDemo: 'Play the demo', IsRidingQuintar: 'Ride a Quintar', IsRidingDefaultQuintar: 'Ride the default Quintar', SkipMinigames: 'Skip minigames is enabled', InteractionTrigger: 'Triggered by proximity, touch, or another interaction', RemoteInteraction: 'Part of another NPC interaction', InteractionSequence: 'Depends on the preceding interaction' })
const EMPTY_ROUTE: Pick<AcquisitionRoute, 'ingredients' | 'costs' | 'requirements' | 'conditions'> = Object.freeze({ ingredients: [], costs: [], requirements: [], conditions: [] })

export function validateWorldAcquisition(value: unknown): asserts value is WorldAcquisitionSnapshot {
  const snapshot = WORLD_SCHEMA.parse(value)
  const validateCondition = (condition: AcquisitionCondition, depth: number): void => {
    if (depth > MAX_CONDITION_DEPTH) throw new Error('Acquisition condition nesting exceeds the limit')
    for (const [key, entry] of Object.entries(condition.data)) {
      if (key === 'LHS' || key === 'RHS') validateCondition(CONDITION.parse(entry), depth + 1)
      else if (!CONDITION_KEYS.has(key) || !['boolean', 'string', 'number'].includes(typeof entry)) throw new Error('Unsupported acquisition condition data')
    }
  }
  for (const entry of snapshot.entries) for (const condition of entry.conditions) validateCondition(condition, 0)
}

function entityRef(catalog: CatalogSnapshot, entity: CatalogEntity): CatalogRef {
  return { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }
}

function selectedRecords(catalog: CatalogSnapshot, mode: string): ReadonlyMap<string, CatalogEntity> {
  const entries = Object.values(catalog.entities).filter(entity => { const identity = nativeIdentity(entity); return identity && (identity.mode === 'base' || identity.mode === mode) })
  const result = new Map<string, CatalogEntity>()
  for (const entity of entries.sort((a, b) => Number(nativeIdentity(a)?.mode !== 'base') - Number(nativeIdentity(b)?.mode !== 'base'))) {
    const identity = nativeIdentity(entity)!
    result.set(`${identity.database}:${identity.databaseId}`, entity)
  }
  return result
}

function material(catalog: CatalogSnapshot, records: ReadonlyMap<string, CatalogEntity>, family: string, id: number, count: number): AcquisitionMaterial {
  const target = records.get(`${family}:${id}`)
  return { name: target?.name ?? 'Item definition unresolved', count, ...(target ? { ref: entityRef(catalog, target) } : {}) }
}

function conditionDescription(condition: AcquisitionCondition, records: ReadonlyMap<string, CatalogEntity>): string[] {
  const { type, negated, data } = condition
  const name = (family: string, id: JsonValue | undefined) => typeof id === 'number' ? records.get(`${family}:${id}`)?.name : undefined
  if (type === ALWAYS && !negated || type === NEVER && negated) return []
  if (type === ALWAYS && negated || type === NEVER && !negated) return [DISABLED_INTERACTION]
  if (type === 'Operation' && nativeRecord(data.LHS) && nativeRecord(data.RHS)) {
    const left = conditionDescription(data.LHS as unknown as AcquisitionCondition, records)
    const right = conditionDescription(data.RHS as unknown as AcquisitionCondition, records)
    if (data.Op === 'And' && !negated) return [...left, ...right]
    if (data.Op === 'Or' && !negated) {
      if (left.includes(DISABLED_INTERACTION)) return right
      if (right.includes(DISABLED_INTERACTION)) return left
      return left.length && right.length ? [`Either ${left.join('; ')} or ${right.join('; ')}`] : []
    }
    return ['Additional story or interaction conditions apply']
  }
  const label = CONDITION_LABELS[type]
  if (label) return [negated ? `Requires the opposite: ${label.toLowerCase()}` : label]
  if (type === 'CheckInventory') {
    const family = data.LootType === 'Item' ? 'item' : data.LootType === 'Equipment' ? 'equipment' : undefined
    const itemName = family && name(family, data.LootValue)
    if (itemName && typeof data.Count === 'number') return [negated ? `Have fewer than ${data.Count} ${itemName}` : `Have at least ${data.Count} ${itemName}`]
  }
  if (type === 'CheckCrystalCount' && typeof data.Count === 'number') return [negated ? `Unlock fewer than ${data.Count} crystals` : `Unlock at least ${data.Count} crystals`]
  if (type === 'IsJobMastered' || type === 'IsJobPresent') {
    const job = name('job', data.Number)
    if (job) return [negated ? `${job} ${type === 'IsJobMastered' ? 'is not mastered by a party member' : 'is not in the party'}` : `${type === 'IsJobMastered' ? 'Have a party member who has mastered' : 'Include a party member using'} ${job}`]
  }
  if (type === 'Random') return ['Random interaction; availability can vary']
  if (type === 'Randomizer') return [negated ? 'Depends on the randomizer configuration and item mapping' : typeof data.InvalidItemID === 'number' ? 'Randomizer recovery; depends on the current item mapping' : 'Requires the indicated randomizer configuration']
  return ['Additional story or interaction conditions apply']
}

function recipeRoute(catalog: CatalogSnapshot, records: ReadonlyMap<string, CatalogEntity>, recipe: CatalogEntity): AcquisitionRoute {
  const record = nativeSourceRecord(recipe)!
  const ingredients = Array.isArray(record.Ingredients) ? record.Ingredients.filter(nativeRecord).flatMap(ingredient => {
    const family = ingredient.LootType === LOOT_ITEM ? 'item' : ingredient.LootType === LOOT_EQUIPMENT ? 'equipment' : undefined
    return family && typeof ingredient.LootID === 'number' && typeof ingredient.LootQuantity === 'number' ? [material(catalog, records, family, ingredient.LootID, ingredient.LootQuantity)] : []
  }) : []
  return { ...EMPTY_ROUTE, kind: 'craft', label: recipe.name, ref: entityRef(catalog, recipe), ingredients, ...(typeof record.Cost === 'number' ? { price: record.Cost } : {}), evidence: `Recipe ${nativeIdentity(recipe)?.databaseId}` }
}

function conditionRequirements(catalog: CatalogSnapshot, records: ReadonlyMap<string, CatalogEntity>, condition: AcquisitionCondition): AcquisitionMaterial[] {
  if (condition.negated) return []
  if (condition.type === 'Operation' && condition.data.Op === 'And') return ['LHS', 'RHS'].flatMap(key => nativeRecord(condition.data[key]) ? conditionRequirements(catalog, records, condition.data[key] as unknown as AcquisitionCondition) : [])
  if (condition.type === 'CheckInventory' && typeof condition.data.LootValue === 'number' && typeof condition.data.Count === 'number' && ['Item', 'Equipment'].includes(String(condition.data.LootType))) return [material(catalog, records, condition.data.LootType === 'Item' ? 'item' : 'equipment', condition.data.LootValue, condition.data.Count)]
  if (condition.type === 'CanUnderstandQuintar') {
    const metadata = nativeRecord(catalog.legacy) ? catalog.legacy : {}
    const enums = nativeRecord(metadata.nativeEnums) ? metadata.nativeEnums : {}
    const bonuses = nativeRecord(enums.ItemSpecialBonus) ? enums.ItemSpecialBonus : {}
    const options = [...records.values()].filter(entity => nativeIdentity(entity)?.database === 'item' && bonuses[String(nativeSourceRecord(entity)?.SpecialBonus)] === 'UnderstandQuintar')
    if (options.length === 1) return [material(catalog, records, 'item', nativeIdentity(options[0]!)!.databaseId, 1)]
  }
  return []
}

function shopPrice(cost: number, rate: number): number | undefined {
  if (!Number.isSafeInteger(cost) || cost < 0 || !Number.isSafeInteger(rate) || rate < 0 || !Number.isSafeInteger(cost * rate)) return undefined
  const value = Math.trunc(cost * rate / PERCENT)
  return rate !== PERCENT && value >= GOLD_COPPER ? Math.trunc(value / SILVER_COPPER) * SILVER_COPPER : value
}

function requirementsFor(catalog: CatalogSnapshot, records: ReadonlyMap<string, CatalogEntity>, conditions: readonly AcquisitionCondition[]): AcquisitionMaterial[] {
  const requirements = new Map<string, AcquisitionMaterial>()
  for (const requirement of conditions.flatMap(condition => conditionRequirements(catalog, records, condition))) {
    const key = requirement.ref?.entityId ?? requirement.name
    if ((requirements.get(key)?.count ?? 0) < requirement.count) requirements.set(key, requirement)
  }
  return [...requirements.values()]
}

export function itemAcquisition(catalog: CatalogSnapshot, entity: CatalogEntity, world: WorldAcquisitionSnapshot | undefined, mode = nativeIdentity(entity)?.mode ?? 'base'): ItemAcquisition {
  const identity = nativeIdentity(entity)
  const guides = Object.entries(entity.fields).filter(([field, value]) => /^(Acquisition|Location|Obtain|Source|How to obtain)$/i.test(field) && value.state === 'known').flatMap(([field, value]) => value.state === 'known' ? [{ field, value: value.value }] : [])
  if (!identity || !['item', 'equipment'].includes(identity.database)) return { routes: [], worldMatched: false, guides, unresolved: ['Acquisition routes have not been mapped to this exact definition'] }
  if (!NATIVE_MODES.has(mode)) return { routes: [], worldMatched: false, guides, unresolved: ['Acquisition routes are unresolved for this game mode'] }
  const records = selectedRecords(catalog, mode)
  const routes: AcquisitionRoute[] = []
  const unresolved: string[] = []
  for (const source of records.values()) {
    const sourceIdentity = nativeIdentity(source)!
    const record = nativeSourceRecord(source)
    if (!record) continue
    if (sourceIdentity.database === 'monster') {
      for (const [field, kind] of [['ItemDrops', 'drop'], ['ItemSteals', 'steal']] as const) {
        if (!Array.isArray(record[field])) { unresolved.push('Some monster loot tables are unresolved'); continue }
        for (const loot of record[field].filter(nativeRecord)) {
          const family = loot.LootType === LOOT_ITEM ? 'item' : loot.LootType === LOOT_EQUIPMENT ? 'equipment' : undefined
          const id = family === 'item' ? loot.ItemID : loot.EquipmentID
          if (family !== identity.database || id !== identity.databaseId || loot.LootChance === 0) continue
          const biomeID = record.LocationBiomeID
          const location = typeof biomeID === 'number' ? records.get(`biome:${biomeID}`)?.name : undefined
          routes.push({ ...EMPTY_ROUTE, kind, label: `${source.name}${typeof record.Level === 'number' ? ` (level ${record.Level})` : ''}`, ref: entityRef(catalog, source), location, ...(typeof loot.LootChance === 'number' ? { chance: loot.LootChance } : {}), ...(kind === 'steal' && typeof loot.StealChance === 'number' ? { success: loot.StealChance } : {}), evidence: `Monster ${sourceIdentity.databaseId} ${field}` })
        }
      }
    }
    if (sourceIdentity.database === 'recipe' && record.LootType === (identity.database === 'item' ? LOOT_ITEM : LOOT_EQUIPMENT) && record.LootID === identity.databaseId) routes.push(recipeRoute(catalog, records, source))
  }
  const metadata = nativeRecord(catalog.legacy) ? catalog.legacy : {}
  const nativeSource = nativeRecord(metadata.nativeSource) ? metadata.nativeSource : {}
  const executable = nativeRecord(nativeSource.executable) ? nativeSource.executable : {}
  const worldMatched = Boolean(world && metadata.sourceContentDigest === world.source.nativeContentDigest && executable.sha256 === world.source.gameExecutableSha256 && nativeSource.platform === world.source.platform && nativeSource.gameVersion === world.source.gameVersion)
  if (worldMatched && world) {
    for (const entry of world.entries) {
      const recipe = entry.family === 'recipe' ? records.get(`recipe:${entry.targetID}`) : undefined
      const recipeRecord = recipe && nativeSourceRecord(recipe)
      const matches = entry.family === identity.database && entry.targetID === identity.databaseId || recipeRecord && recipeRecord.LootType === (identity.database === 'item' ? LOOT_ITEM : LOOT_EQUIPMENT) && recipeRecord.LootID === identity.databaseId
      if (!matches) continue
      const conditions = [...new Set(entry.conditions.flatMap(condition => conditionDescription(condition, records)))]
      if (conditions.includes(DISABLED_INTERACTION)) continue
      const target = records.get(`${identity.database}:${identity.databaseId}`)
      const cost = target && nativeSourceRecord(target)?.Cost
      const route: Partial<AcquisitionRoute> = recipe ? recipeRoute(catalog, records, recipe) : EMPTY_ROUTE
      const price = entry.kind === 'shop' && typeof cost === 'number' && entry.costRate !== undefined ? shopPrice(cost, entry.costRate) : recipe && route.price !== undefined && entry.costRate !== undefined ? Math.trunc(route.price * entry.costRate / PERCENT) : undefined
      routes.push({ ...EMPTY_ROUTE, ...route, kind: entry.kind, label: recipe ? recipe.name : entry.label, ...(recipe ? { station: entry.label } : {}), location: entry.biomeID === undefined ? undefined : records.get(`biome:${entry.biomeID}`)?.name, coord: entry.coord, quantity: entry.count, ...(price === undefined ? {} : { price }), costs: (entry.costs ?? []).map(cost => material(catalog, records, cost.family, cost.id, cost.count)), requirements: requirementsFor(catalog, records, entry.conditions), conditions, evidence: `${entry.entityID === undefined ? 'System' : `World entity ${entry.entityID}`} ${entry.path}` })
    }
  } else unresolved.push('World acquisition routes are not verified for this source revision')
  const withStations = new Set(routes.filter(route => route.kind === 'craft' && route.station).map(route => route.ref?.entityId))
  const filtered = routes.filter(route => route.kind !== 'craft' || route.station || !withStations.has(route.ref?.entityId))
  return { routes: filtered, worldMatched, guides, unresolved: [...new Set(unresolved)] }
}
