import { jsonRecord } from './crystal-edit'
import { bundledModIdentity } from './bundled-mods'
import type { BundledLibraryMod } from './mod-library'
import { nativeIdentity } from './native-game'
import { coinAmounts } from './money'
import type { CatalogRef, CatalogSnapshot, JsonValue } from './types'

export const WORLD_MARKER_KINDS = ['chest', 'npc', 'shop', 'boss', 'encounter', 'crystal', 'home', 'entrance', 'sign', 'resource', 'object'] as const
export type WorldMarkerKind = typeof WORLD_MARKER_KINDS[number]
export interface WorldMapTarget { readonly family: string; readonly id: number; readonly name: string; readonly sourceId: string; readonly sourceRevisionId?: string }
export interface WorldMarker {
  readonly id: string
  readonly entityId: number
  readonly kind: WorldMarkerKind
  readonly sourceId: string
  readonly sourceName: string
  readonly sourceRevisionId?: string
  readonly change: 'base' | 'added' | 'modified'
  readonly name: string
  readonly region: string | null
  readonly biomeId: number
  readonly layer: number | null
  readonly x: number
  readonly y: number
  readonly z: number
  readonly description: string
  readonly targets: readonly WorldMapTarget[]
  readonly conditions?: readonly string[]
  readonly warnings?: readonly string[]
}
export interface WorldMapBounds { readonly x: number; readonly z: number; readonly width: number; readonly height: number }
export interface WorldMapRegion { readonly id: number; readonly name: string; readonly layer: number; readonly x: number; readonly z: number; readonly sourceId?: string; readonly sourceName?: string; readonly sourceRevisionId?: string; readonly change?: WorldMarker['change'] }
export interface WorldMapLayer { readonly id: number; readonly label: string; readonly image: string }
export interface WorldMapDefinition extends WorldMapTarget { readonly record?: Readonly<Record<string, JsonValue>> }
export interface WorldMapManifest {
  readonly schemaVersion: 1
  readonly source: { readonly platform: string; readonly gameVersion: string; readonly [key: string]: unknown }
  readonly bounds: WorldMapBounds
  readonly layers: readonly WorldMapLayer[]
  readonly regions: readonly WorldMapRegion[]
  readonly markers: readonly WorldMarker[]
  readonly definitions?: readonly WorldMapDefinition[]
}
export interface WorldMapModIdentity { readonly sourceId: string; readonly sourceName: string; readonly revisionId: string }
export interface WorldMapModLayer extends WorldMapModIdentity {
  readonly entities: readonly Readonly<Record<string, JsonValue>>[]
  readonly definitions: readonly WorldMapDefinition[]
  readonly warnings: readonly string[]
}
export interface WorldMapComposition { readonly markers: readonly WorldMarker[]; readonly regions: readonly WorldMapRegion[]; readonly warnings: readonly string[] }
const MAX_MODELS = 20_000
const MAX_NATIVE_ID = 0xffffffff
const MAX_ACTION_DEPTH = 32
const MAX_ACTIONS = 100_000
const MAX_COORD = 1_000_000
const SPATIAL_CELL_SIZE = 32
const MIN_MARKER_DISTANCE = 52
const DEFAULT_MAX_GROUPS = 140
const REGION_ZOOM = 3
const CLOSE_ZOOM = 8
const WINDOWS_1_6_9_LAST_VANILLA_ENTITY_ID = 3824
const MODEL_FAMILIES: Readonly<Record<string, string>> = Object.freeze({ Items: 'item', Equipment: 'equipment', Jobs: 'job', Monsters: 'monster', Troops: 'troop', Sparks: 'spark', Biomes: 'biome', Recipes: 'recipe' })
const ENTITY_KINDS: Readonly<Record<string, WorldMarkerKind>> = Object.freeze({ Npc: 'npc', Sign: 'sign', Spark: 'encounter', Door: 'entrance', HomePoint: 'home', Treasure: 'chest', Crystal: 'crystal' })
const ENTITY_TYPES = ['Npc', 'Sign', 'Spark', 'Door', 'HomePoint', 'Treasure', 'Crystal', 'Marker'] as const
const LOOT_TYPES = ['Nothing', 'Item', 'Equipment', 'Currency'] as const
const MARKER_PRIORITY: Readonly<Record<WorldMarkerKind, number>> = Object.freeze({ crystal: 9, home: 8, boss: 7, entrance: 6, shop: 5, chest: 4, npc: 3, resource: 3, object: 2, sign: 2, encounter: 1 })
const ACTION_TYPES: Readonly<Record<number, string>> = Object.freeze({ 3: 'Condition', 5: 'Shop', 8: 'AddInventory', 9: 'RemoveInventory', 27: 'Battle', 28: 'ShopRecipe', 58: 'AddToLostAndFound', 59: 'PlaySEMineOre', 69: 'HazardBurn', 71: 'Garden' })
const RESOURCE_PICKUP_TEXTURES = new Set(['Actor/Effect_Sparkle', 'Actor/Effect_Question'])
const BIOME_GEOMETRY_FIELDS = ['MapLayer', 'BaseID', 'IsMapAlt', 'MapCenterXOverride', 'MapCenterYOverride'] as const

function nativeId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_NATIVE_ID }
function coordinate(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORD }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100_000) : undefined }
function records(value: unknown): readonly Readonly<Record<string, JsonValue>>[] { return Array.isArray(value) ? value.filter(jsonRecord) : [] }
function typeName(value: JsonValue | undefined, labels: readonly string[]): string | undefined { return typeof value === 'string' ? value : nativeId(value) ? labels[value] : undefined }
function modelKey(family: string, id: number): string { return `${family}:${id}` }
function projectModelKey(sourceId: string, family: string, id: number): string { return JSON.stringify([sourceId, family, id]) }

export function worldMapModLayer(identity: WorldMapModIdentity, root: unknown): WorldMapModLayer {
  const warnings: string[] = []
  const entities: Readonly<Record<string, JsonValue>>[] = []
  const definitions: WorldMapDefinition[] = []
  if (!jsonRecord(root)) return { ...identity, entities, definitions, warnings: ['The mod source is not a Crystal Edit project object.'] }
  for (const family of ['Entities', ...Object.keys(MODEL_FAMILIES)]) {
    const value = root[family]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value) || value.length > MAX_MODELS) { warnings.push(`${family} is not a bounded model array; its map changes were skipped.`); continue }
    const counts = new Map<number, number>()
    const ambiguous = new Set<number>()
    for (const record of value) if (jsonRecord(record) && nativeId(record.ID)) counts.set(record.ID, (counts.get(record.ID) ?? 0) + 1)
    for (const record of value) {
      if (!jsonRecord(record) || !nativeId(record.ID)) { warnings.push(`${family} contains a record without a valid native ID; it was skipped.`); continue }
      if (counts.get(record.ID)! > 1) {
        warnings.push(`Duplicate ${family} #${record.ID} is ambiguous; its map changes were skipped.`)
        if (family === 'Entities' && !ambiguous.has(record.ID)) { entities.push({ ID: record.ID }); ambiguous.add(record.ID) }
        continue
      }
      if (family === 'Entities') entities.push(record)
      else {
        const name = text(record.Name)
        if (!name) { warnings.push(`${family} #${record.ID} has no name; its definition was skipped.`); continue }
        definitions.push({ family: MODEL_FAMILIES[family]!, id: record.ID, name, sourceId: identity.sourceId, sourceRevisionId: identity.revisionId, record })
      }
    }
  }
  if (root.HasCustomContent === true || jsonRecord(root.Tree) && Object.keys(root.Tree).length || Array.isArray(root.Folders) && root.Folders.length) warnings.push('Custom terrain and content assets are not rendered; markers use the bundled Windows 1.6.9 terrain.')
  return { ...identity, entities, definitions, warnings: [...new Set(warnings)] }
}

function conditionText(value: JsonValue | undefined): string | undefined {
  if (!jsonRecord(value)) return undefined
  const kind = value.ConditionType
  const negated = value.IsNegation === true
  if (kind === 0 || kind === 'Always') return negated ? 'This condition is never satisfied' : undefined
  if (kind === 1 || kind === 'Never') return negated ? undefined : 'This condition is never satisfied'
  const data = jsonRecord(value.Data) ? value.Data : {}
  const variable = text(data.VariableKey)
  if (variable) return `${negated ? 'Inverse condition for' : 'Requires story condition'} ${variable}`
  return `${negated ? 'Inverse ' : ''}story or interaction condition (${typeof kind === 'string' || typeof kind === 'number' ? kind : 'unresolved'})`
}

interface NpcActions { readonly loot: readonly { readonly family: string; readonly id: number }[]; readonly inventoryLoot: readonly { readonly family: string; readonly id: number }[]; readonly actionTypes: readonly string[]; readonly troops: readonly number[]; readonly conditions: readonly string[]; readonly isShop: boolean; readonly warnings: readonly string[] }
function npcActions(npc: Readonly<Record<string, JsonValue>>, actionEnums: Readonly<Record<string, unknown>>): NpcActions {
  const loot: { family: string; id: number }[] = []
  const inventoryLoot: { family: string; id: number }[] = []
  const actionTypes = new Set<string>()
  const troops: number[] = []
  const conditions = new Set<string>()
  const warnings = new Set<string>()
  let isShop = false
  let nodes = 0
  const addLoot = (data: Readonly<Record<string, JsonValue>>) => {
    const kind = typeName(data.LootType, LOOT_TYPES)
    if ((kind === 'Item' || kind === 'Equipment') && nativeId(data.LootValue)) loot.push({ family: kind.toLowerCase(), id: data.LootValue })
  }
  const visit = (actions: JsonValue | undefined, depth: number) => {
    if (!Array.isArray(actions)) return
    if (depth > MAX_ACTION_DEPTH) { warnings.add('NPC action nesting exceeds the map inspection limit'); return }
    for (const action of actions) {
      if (++nodes > MAX_ACTIONS) { warnings.add('NPC actions exceed the map inspection limit'); return }
      if (!jsonRecord(action)) continue
      const data = jsonRecord(action.Data) ? action.Data : {}
      const name = typeof action.ActionType === 'string' ? action.ActionType : typeof action.ActionType === 'number' ? actionEnums[String(action.ActionType)] ?? ACTION_TYPES[action.ActionType] : undefined
      if (typeof name === 'string') actionTypes.add(name)
      const condition = conditionText(data.Condition)
      if (condition) conditions.add(condition)
      if (name === 'Shop' || name === 'ShopRecipe') {
        isShop = true
        for (const entry of records(data.Stock)) {
          if (name === 'ShopRecipe' && nativeId(entry.LootValue)) loot.push({ family: 'recipe', id: entry.LootValue })
          else addLoot(entry)
          const restriction = conditionText(entry.Condition)
          if (restriction) conditions.add(restriction)
        }
      } else if (name === 'AddInventory' || name === 'AddToLostAndFound') {
        addLoot(data)
        if (name === 'AddInventory') {
          const kind = typeName(data.LootType, LOOT_TYPES)
          if ((kind === 'Item' || kind === 'Equipment') && nativeId(data.LootValue)) inventoryLoot.push({ family: kind.toLowerCase(), id: data.LootValue })
        }
      }
      if (name === 'Battle') {
        if (nativeId(data.TroopID)) troops.push(data.TroopID)
        else warnings.add('Scripted battle troop reference is unresolved')
      }
      for (const key of ['ConditionActionsTrue', 'ConditionActionsFalse', 'Actions']) visit(data[key], depth + 1)
    }
  }
  for (const page of records(npc.Pages)) {
    const condition = conditionText(page.Condition)
    if (condition) conditions.add(condition)
    if (typeof page.TriggerType === 'number' && page.TriggerType !== 0) conditions.add('Triggered by proximity, touch, or another interaction')
    visit(page.Actions, 0)
  }
  for (const outfit of records(npc.Outfits)) { const condition = conditionText(outfit.Condition); if (condition) conditions.add(condition) }
  return { loot, inventoryLoot, actionTypes: [...actionTypes], troops, conditions: [...conditions], isShop, warnings: [...warnings] }
}

export function composeWorldMap(manifest: WorldMapManifest, layers: readonly WorldMapModLayer[]): WorldMapComposition {
  const warnings = layers.flatMap(layer => layer.warnings.map(warning => `${layer.sourceName}: ${warning}`))
  const definitions = new Map((manifest.definitions ?? []).map(definition => [modelKey(definition.family, definition.id), definition]))
  for (const marker of manifest.markers) for (const target of marker.targets) if (!definitions.has(modelKey(target.family, target.id))) definitions.set(modelKey(target.family, target.id), target)
  for (const region of manifest.regions) if (!definitions.has(modelKey('biome', region.id))) definitions.set(modelKey('biome', region.id), { family: 'biome', id: region.id, name: region.name, sourceId: 'base' })
  const baseDefinitions = new Map(definitions)
  const baseDefinitionKeys = new Set(definitions.keys())
  for (const layer of layers) for (const definition of layer.definitions) {
    const baseline = baseDefinitions.get(modelKey(definition.family, definition.id))
    if (definition.family === 'biome' && baseline) {
      const changedFields = BIOME_GEOMETRY_FIELDS.filter(field => definition.record && Object.hasOwn(definition.record, field) && JSON.stringify(definition.record[field]) !== JSON.stringify(baseline.record?.[field]))
      if (changedFields.length) warnings.push(`${layer.sourceName}: Biome #${definition.id} changes ${changedFields.join(', ')}; bundled terrain, map layers, and region anchors are retained.`)
    }
    definitions.set(baseDefinitionKeys.has(modelKey(definition.family, definition.id)) ? modelKey(definition.family, definition.id) : projectModelKey(layer.sourceId, definition.family, definition.id), definition)
  }
  const definitionFor = (family: string, id: number, sourceId = 'base') => definitions.get(projectModelKey(sourceId, family, id)) ?? definitions.get(modelKey(family, id))
  const regions = new Map(manifest.regions.map(region => [region.id, region]))
  for (const region of regions.values()) {
    const definition = definitionFor('biome', region.id)
    const owner = definition?.sourceId !== 'base' ? layers.find(layer => layer.sourceId === definition?.sourceId && layer.revisionId === definition.sourceRevisionId) : undefined
    if (definition) regions.set(region.id, { ...region, name: definition.name, ...(owner ? { sourceId: owner.sourceId, sourceName: owner.sourceName, sourceRevisionId: owner.revisionId, change: 'modified' as const } : {}) })
  }
  const nativeEntityLimit = nativeId(manifest.source.lastVanillaEntityId) ? manifest.source.lastVanillaEntityId : WINDOWS_1_6_9_LAST_VANILLA_ENTITY_ID
  const entityKey = (id: number, sourceId: string) => id <= nativeEntityLimit ? `base:entity:${id}` : `${sourceId}:entity:${id}`
  const markers = new Map(manifest.markers.map(marker => [marker.id, marker]))
  const winners = new Map<string, { readonly layer: WorldMapModLayer; readonly entity: Readonly<Record<string, JsonValue>> }>()
  for (const layer of layers) for (const entity of layer.entities) winners.set(entityKey(entity.ID as number, layer.sourceId), { layer, entity })
  const npcsByKey = new Map<string, Readonly<Record<string, JsonValue>>>()
  for (const { entity, layer } of winners.values()) if (jsonRecord(entity.NpcData) && text(entity.NpcData.Key)) npcsByKey.set(JSON.stringify([layer.sourceId, entity.NpcData.Key]), entity.NpcData)
  const enums = jsonRecord(manifest.source.enums) && jsonRecord(manifest.source.enums.ActionType) ? manifest.source.enums.ActionType : {}
  const resolve = (family: string, id: number, markerWarnings: string[], sourceId = 'base'): WorldMapTarget => {
    const definition = definitionFor(family, id, sourceId)
    if (!definition) markerWarnings.push(`${family} #${id} is unresolved`)
    return { family, id, name: definition?.name ?? `${family} #${id} (unresolved)`, sourceId: definition?.sourceId ?? 'unresolved', ...(definition?.sourceRevisionId ? { sourceRevisionId: definition.sourceRevisionId } : {}) }
  }
  const expandTroops = (troopIds: readonly number[], markerWarnings: string[], sourceId = 'base') => troopIds.flatMap(id => {
    const troop = definitionFor('troop', id, sourceId)
    const members = troop?.record?.Members
    if (!Array.isArray(members) || members.some(member => !jsonRecord(member) || !nativeId(member.MonsterID))) markerWarnings.push(`Troop #${id} has unresolved member definitions`)
    return [resolve('troop', id, markerWarnings, sourceId), ...records(members).flatMap(member => nativeId(member.MonsterID) ? [resolve('monster', member.MonsterID, markerWarnings, troop?.sourceId)] : [])]
  })
  const bossStatus = (targets: readonly WorldMapTarget[], markerWarnings: string[]): boolean | undefined => {
    const monsters = targets.filter(target => target.family === 'monster')
    const statuses = monsters.map(target => definitionFor(target.family, target.id, target.sourceId)?.record?.IsBoss)
    if (statuses.includes(true)) return true
    if (!statuses.length || statuses.some(value => typeof value !== 'boolean')) { markerWarnings.push('Encounter boss classification is unresolved'); return undefined }
    return false
  }
  for (const [markerId, { layer, entity }] of winners) {
    const entityId = entity.ID as number
    markers.delete(markerId)
    const markerWarnings: string[] = []
    const coord = entity.Coord
    if (!jsonRecord(coord) || !coordinate(coord.X) || !coordinate(coord.Y) || !coordinate(coord.Z)) { warnings.push(`${layer.sourceName}: Entity #${entityId} has unresolved coordinates and cannot be placed.`); continue }
    const entityType = typeName(entity.EntityType, ENTITY_TYPES)
    let kind = entityType ? ENTITY_KINDS[entityType] : undefined
    if (!kind) { warnings.push(`${layer.sourceName}: Entity #${entityId} has an unsupported entity type (${entity.EntityType ?? 'unknown'}).`); continue }
    const biomeId = nativeId(entity.BiomeID) ? entity.BiomeID : 0
    const biomeDefinition = definitionFor('biome', biomeId, layer.sourceId)
    const region = biomeDefinition && !baseDefinitionKeys.has(modelKey('biome', biomeId)) ? undefined : regions.get(biomeId)
    if (!region) markerWarnings.push('Region and map layer are unresolved; coordinates are retained')
    let name: string = `${kind === 'chest' ? 'Treasure chest' : entityType} #${entityId}`
    let description = ''
    let targets: WorldMapTarget[] = []
    let conditions: readonly string[] = []
    if (kind === 'chest') {
      if (!jsonRecord(entity.TreasureData)) { warnings.push(`${layer.sourceName}: Chest #${entityId} has no treasure data.`); continue }
      const data = entity.TreasureData
      const loot = typeName(data.LootType, LOOT_TYPES)
      if ((loot === 'Item' || loot === 'Equipment') && nativeId(data.LootValue)) {
        targets = [resolve(loot.toLowerCase(), data.LootValue, markerWarnings, layer.sourceId)]
        name = targets[0]!.name
        description = `Treasure chest containing ${name}`
      } else if (loot === 'Currency' && typeof data.LootValue === 'number' && Number.isSafeInteger(data.LootValue) && data.LootValue >= 0) { name = 'Currency chest'; description = coinAmounts(data.LootValue).map(({ coin, amount }) => `${amount} ${coin}`).join(', ') }
      else if (loot === 'Nothing') { name = 'Empty chest'; description = 'This chest is empty in the source' }
      else markerWarnings.push('Treasure contents are unresolved')
    } else if (kind === 'npc') {
      if (!jsonRecord(entity.NpcData)) { warnings.push(`${layer.sourceName}: NPC #${entityId} has no NPC data.`); continue }
      const npc = entity.NpcData
      const linkedKey = text(npc.LinkedKey)
      const linked = linkedKey ? npcsByKey.get(JSON.stringify([layer.sourceId, linkedKey])) : undefined
      const outfits = records(npc.Outfits)
      const visible = outfits.some(outfit => text(outfit.TextureKey) || nativeId(outfit.VoxelID) || text(outfit.Name)?.startsWith('@'))
      const actions = npcActions(npc, enums)
      if (linkedKey && !linked) markerWarnings.push(`Linked NPC relationship ${linkedKey} is unresolved; this marker retains its own interactions`)
      if (!visible && !actions.isShop && !actions.troops.length && !actions.loot.length && !actions.actionTypes.includes('Garden')) continue
      name = outfits.map(outfit => text(outfit.Name)).find(Boolean) ?? text(npc.Key) ?? name
      targets = [...actions.loot.map(loot => resolve(loot.family, loot.id, markerWarnings, layer.sourceId)), ...expandTroops(actions.troops, markerWarnings, layer.sourceId)]
      conditions = actions.conditions
      markerWarnings.push(...actions.warnings)
      kind = actions.troops.length && bossStatus(targets, markerWarnings) === true ? 'boss' : actions.isShop ? 'shop' : actions.troops.length ? 'encounter' : 'npc'
      description = kind === 'shop' ? 'Shop stock and interaction rewards' : kind === 'boss' ? 'Scripted boss encounter' : kind === 'encounter' ? 'Scripted encounter' : 'NPC interactions and rewards'
      if (kind === 'npc') {
        const isGarden = actions.actionTypes.includes('Garden')
        const isMining = actions.actionTypes.includes('PlaySEMineOre') && actions.inventoryLoot.length > 0
        const isPickup = outfits.some(outfit => typeof outfit.TextureKey === 'string' && RESOURCE_PICKUP_TEXTURES.has(outfit.TextureKey)) && actions.inventoryLoot.length > 0
        const objectOutfit = outfits.find(outfit => nativeId(outfit.VoxelID) || typeof outfit.TextureKey === 'string' && outfit.TextureKey.startsWith('Actor/Effect_'))
        if (isGarden || isMining || isPickup) {
          kind = 'resource'
          const lootNames = [...new Set(actions.inventoryLoot.map(loot => resolve(loot.family, loot.id, markerWarnings, layer.sourceId).name))]
          const authoredName = outfits.map(outfit => text(outfit.Name)).find(Boolean)
          const seedSlot = authoredName && /^@Seed(\d+)$/.exec(authoredName)
          name = isGarden ? seedSlot ? `Garden plot ${Number(seedSlot[1]) + 1}` : authoredName ?? 'Garden plot' : `${lootNames.join(', ')} ${isMining ? 'node' : 'pickup'}`
          if (isGarden) markerWarnings.push('Planted seeds and garden state depend on the player save')
          description = isGarden ? 'Garden planting interaction' : isMining ? 'Mining node; collected items depend on the interaction conditions' : 'Ground pickup; collected items depend on the interaction conditions'
        } else if (objectOutfit) {
          kind = 'object'
          const voxelNames = jsonRecord(manifest.source.voxelNames) ? manifest.source.voxelNames : {}
          const nativeVoxelNames = [...new Set(outfits.flatMap(outfit => {
            const voxelName = nativeId(outfit.VoxelID) ? text(voxelNames[String(outfit.VoxelID)]) : undefined
            return voxelName ? [voxelName] : []
          }))]
          name = outfits.map(outfit => text(outfit.Name)).find(Boolean) ?? (nativeVoxelNames.length ? nativeVoxelNames.join(' / ') : undefined) ?? (actions.actionTypes.includes('HazardBurn') ? 'Fire' : 'Interaction point')
          description = 'World object and its interaction rewards'
        }
      }
    } else if (kind === 'encounter') {
      if (!jsonRecord(entity.SparkData)) { warnings.push(`${layer.sourceName}: Encounter #${entityId} has no encounter data.`); continue }
      const data = entity.SparkData
      const pages = records(data.TroopPages)
      targets = expandTroops(pages.flatMap(page => nativeId(page.TroopID) ? [page.TroopID] : []), markerWarnings, layer.sourceId)
      if (!targets.length) markerWarnings.push('Encounter troop references are unresolved')
      if (bossStatus(targets, markerWarnings) === true) kind = 'boss'
      const monsters = [...new Set(targets.filter(target => target.family === 'monster').map(target => target.name))]
      name = monsters.length ? monsters.join(', ') : nativeId(data.SparkID) ? resolve('spark', data.SparkID, markerWarnings, layer.sourceId).name : name
      conditions = pages.flatMap(page => { const restriction = conditionText(page.Condition); return restriction ? [restriction] : [] })
      description = kind === 'boss' ? 'Placed boss encounter' : 'Placed encounter; troop availability can depend on conditions'
    } else if (kind === 'crystal') {
      if (jsonRecord(entity.CrystalData) && nativeId(entity.CrystalData.JobID)) { targets = [resolve('job', entity.CrystalData.JobID, markerWarnings, layer.sourceId)]; name = `${targets[0]!.name} crystal` }
      else markerWarnings.push('Crystal class is unresolved')
    } else if (kind === 'entrance') {
      if (jsonRecord(entity.DoorData) && nativeId(entity.DoorData.RequiredItemID)) targets = [resolve('item', entity.DoorData.RequiredItemID, markerWarnings, layer.sourceId)]
      name = text(entity.Name) ?? 'Entrance'
    } else if (kind === 'sign') { name = jsonRecord(entity.SignData) ? text(entity.SignData.Title) ?? 'Sign' : 'Sign' }
    else if (kind === 'home') name = jsonRecord(entity.HomePointData) ? text(entity.HomePointData.Name) ?? 'Home point' : 'Home point'
    const uniqueTargets = [...new Map(targets.map(target => [projectModelKey(target.sourceId, target.family, target.id), target])).values()]
    markers.set(markerId, { id: markerId, entityId, kind, sourceId: layer.sourceId, sourceName: layer.sourceName, sourceRevisionId: layer.revisionId, change: entityId <= nativeEntityLimit ? 'modified' : 'added', name, region: region?.name ?? null, biomeId, layer: region?.layer ?? null, x: coord.X, y: coord.Y, z: coord.Z, description, targets: uniqueTargets, ...(conditions.length ? { conditions: [...new Set(conditions)] } : {}), ...(markerWarnings.length ? { warnings: [...new Set(markerWarnings)] } : {}) })
  }
  for (const [id, marker] of markers) {
    const markerWarnings = [...marker.warnings ?? []]
    const troops = marker.targets.filter(target => target.family === 'troop')
    const recomposedTargets = troops.length ? [...marker.targets.filter(target => target.family !== 'monster' && target.family !== 'troop'), ...troops.flatMap(troop => expandTroops([troop.id], markerWarnings, troop.sourceId))] : marker.targets
    const targets = [...new Map(recomposedTargets.map(target => {
      const definition = definitionFor(target.family, target.id, target.sourceId)
      const resolved = definition ? { family: target.family, id: target.id, name: definition.name, sourceId: definition.sourceId, ...(definition.sourceRevisionId ? { sourceRevisionId: definition.sourceRevisionId } : {}) } : target
      return [projectModelKey(resolved.sourceId, target.family, target.id), resolved] as const
    })).values()]
    const changedTarget = targets.find(target => {
      const previous = marker.targets.find(value => value.family === target.family && value.id === target.id)
      return target.sourceId !== 'base' && (target.name !== previous?.name || target.sourceId !== previous?.sourceId || target.sourceRevisionId !== previous?.sourceRevisionId)
    })
    const biomeDefinition = definitionFor('biome', marker.biomeId, marker.sourceId)
    const region = biomeDefinition && !baseDefinitionKeys.has(modelKey('biome', marker.biomeId)) ? undefined : regions.get(marker.biomeId)
    let kind = marker.kind
    if (kind === 'boss' || kind === 'encounter') {
      const status = bossStatus(targets, markerWarnings)
      if (status !== undefined) kind = status ? 'boss' : 'encounter'
    }
    const changedBiome = definitionFor('biome', marker.biomeId, marker.sourceId)
    const owner = changedTarget ? layers.find(layer => layer.sourceId === changedTarget.sourceId && (!changedTarget.sourceRevisionId || layer.revisionId === changedTarget.sourceRevisionId)) : changedBiome?.sourceId !== 'base' && changedBiome?.name !== marker.region ? layers.find(layer => layer.sourceId === changedBiome?.sourceId && layer.revisionId === changedBiome.sourceRevisionId) : undefined
    const chestTarget = kind === 'chest' ? targets.find(target => target.family === 'equipment' || target.family === 'item') : undefined
    const monsterNames = [...new Set(targets.filter(target => target.family === 'monster').map(target => target.name))]
    const crystalTarget = kind === 'crystal' ? targets.find(target => target.family === 'job') : undefined
    markers.set(id, { ...marker, kind, targets, ...(region ? { region: region.name } : {}), ...(chestTarget ? { name: chestTarget.name, description: `Treasure chest containing ${chestTarget.name}` } : {}), ...(crystalTarget ? { name: `${crystalTarget.name} crystal` } : {}), ...((kind === 'boss' || kind === 'encounter') && monsterNames.length ? { name: monsterNames.join(', ') } : {}), ...(markerWarnings.length ? { warnings: [...new Set(markerWarnings)] } : {}), ...(marker.change === 'base' && owner ? { sourceId: owner.sourceId, sourceName: owner.sourceName, sourceRevisionId: owner.revisionId, change: 'modified' as const } : {}) })
  }
  return { markers: [...markers.values()], regions: [...regions.values()], warnings: [...new Set(warnings)] }
}

export function markerSearch(marker: WorldMarker, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const haystack = [marker.name, marker.region, marker.kind, marker.sourceName, marker.entityId, marker.description, ...marker.targets.map(target => target.name)].join(' ').toLocaleLowerCase()
  return terms.every(term => haystack.includes(term))
}
export interface WorldMarkerFilter { readonly layer?: number | null; readonly kinds?: readonly WorldMarkerKind[]; readonly query?: string; readonly sourceIds?: readonly string[] }
export function filterWorldMarkers(markers: readonly WorldMarker[], filter: WorldMarkerFilter): readonly WorldMarker[] {
  return markers.filter(marker => (filter.layer === undefined || marker.layer === filter.layer) && (!filter.kinds || filter.kinds.includes(marker.kind)) && (!filter.sourceIds || filter.sourceIds.includes(marker.sourceId)) && (!filter.query || markerSearch(marker, filter.query)))
}
export interface WorldSpatialIndex { readonly cellSize: number; readonly cells: ReadonlyMap<string, readonly WorldMarker[]> }
export function createWorldSpatialIndex(markers: readonly WorldMarker[]): WorldSpatialIndex {
  const cells = new Map<string, WorldMarker[]>()
  for (const marker of markers) {
    const key = `${Math.floor(marker.x / SPATIAL_CELL_SIZE)},${Math.floor(marker.z / SPATIAL_CELL_SIZE)}`
    const bucket = cells.get(key) ?? []
    bucket.push(marker)
    cells.set(key, bucket)
  }
  return { cellSize: SPATIAL_CELL_SIZE, cells }
}
export function queryWorldSpatialIndex(index: WorldSpatialIndex, bounds: WorldMapBounds): readonly WorldMarker[] {
  if (![bounds.x, bounds.z, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) return []
  const matches = (marker: WorldMarker) => marker.x >= bounds.x && marker.x <= bounds.x + bounds.width && marker.z >= bounds.z && marker.z <= bounds.z + bounds.height
  const minX = Math.floor(bounds.x / index.cellSize)
  const maxX = Math.floor((bounds.x + bounds.width) / index.cellSize)
  const minZ = Math.floor(bounds.z / index.cellSize)
  const maxZ = Math.floor((bounds.z + bounds.height) / index.cellSize)
  if ((maxX - minX + 1) * (maxZ - minZ + 1) > index.cells.size * 2) return [...index.cells.values()].flatMap(bucket => bucket.filter(matches))
  const result: WorldMarker[] = []
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) for (const marker of index.cells.get(`${x},${z}`) ?? []) if (matches(marker)) result.push(marker)
  return result
}
export interface WorldMapCluster { readonly id: string; readonly x: number; readonly z: number; readonly kind: WorldMarkerKind; readonly markers: readonly WorldMarker[] }
export interface WorldMapClusterOptions { readonly zoom: number; readonly pixelsPerUnit: number; readonly maxGroups?: number }
export function worldMapClusters(markers: readonly WorldMarker[], options: WorldMapClusterOptions): readonly WorldMapCluster[] {
  if (!Number.isFinite(options.pixelsPerUnit) || options.pixelsPerUnit <= 0 || !Number.isFinite(options.zoom)) return []
  const requestedGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS
  const maxGroups = Number.isFinite(requestedGroups) ? Math.max(1, Math.floor(requestedGroups)) : DEFAULT_MAX_GROUPS
  const visible = markers.filter(marker => options.zoom >= CLOSE_ZOOM || marker.kind !== 'encounter' && marker.kind !== 'sign' && marker.kind !== 'object' && (options.zoom >= REGION_ZOOM || marker.kind !== 'npc' && marker.kind !== 'resource'))
  const sorted = [...visible].sort((a, b) => MARKER_PRIORITY[b.kind] - MARKER_PRIORITY[a.kind] || a.id.localeCompare(b.id))
  if (!sorted.length) return []
  const extent = sorted.reduce((value, marker) => ({ minX: Math.min(value.minX, marker.x), maxX: Math.max(value.maxX, marker.x), minZ: Math.min(value.minZ, marker.z), maxZ: Math.max(value.maxZ, marker.z) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity })
  const span = Math.hypot(extent.maxX - extent.minX, extent.maxZ - extent.minZ)
  let separation = MIN_MARKER_DISTANCE / options.pixelsPerUnit
  let groups: { anchor: WorldMarker; members: WorldMarker[] }[] = []
  for (;;) {
    groups = []
    for (const marker of sorted) {
      const near = groups.find(group => Math.hypot(marker.x - group.anchor.x, marker.z - group.anchor.z) < separation)
      if (near) near.members.push(marker)
      else groups.push({ anchor: marker, members: [marker] })
    }
    if (groups.length <= maxGroups) break
    separation = Math.min(span + 1, separation * 1.5)
  }
  // Fixed anchors keep neighboring hit targets apart even at grid boundaries
  return groups.map(({ anchor, members }) => ({ id: members.length === 1 ? anchor.id : `cluster:${anchor.id}`, x: anchor.x, z: anchor.z, kind: anchor.kind, markers: members }))
}

export function worldMapTargetRef(target: WorldMapTarget, catalogs: readonly CatalogSnapshot[], bundled: readonly BundledLibraryMod[] = []): CatalogRef | undefined {
  const preferred = catalogs.filter(catalog => (target.sourceId === 'base' || catalog.id === target.sourceId) && (!target.sourceRevisionId || catalog.revisionId === target.sourceRevisionId))
  for (const catalog of preferred) {
    const entity = Object.values(catalog.entities).find(entity => {
      const identity = nativeIdentity(entity)
      if (target.sourceId === 'base' && identity?.mode === 'base' && identity.database === target.family && identity.databaseId === target.id) return true
      const modelId = entity.fields['Crystal Edit model ID']
      const modelType = entity.fields['Crystal Edit model type']
      return modelId?.state === 'known' && modelId.value === target.id && modelType?.state === 'known' && typeof modelType.value === 'string' && MODEL_FAMILIES[modelType.value] === target.family
    })
    if (entity) return { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }
  }
  const reviewed = bundled.find(mod => mod.id === target.sourceId && target.sourceRevisionId && (target.sourceRevisionId === mod.sourceDigest || target.sourceRevisionId.startsWith(`${mod.sourceDigest}:`)))
  if (reviewed) for (const catalog of catalogs) {
    const entity = Object.values(catalog.entities).find(entity => {
      const identity = bundledModIdentity(entity)
      return identity?.key === reviewed.key && identity.modelId === target.id && MODEL_FAMILIES[identity.family] === target.family && identity.version === reviewed.declaredVersion && entity.sources.some(source => source.snapshot?.includes(`SHA-256 ${reviewed.sourceDigest.replace(/^sha256:/, '')}`))
    })
    if (entity) return { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }
  }
  return undefined
}
