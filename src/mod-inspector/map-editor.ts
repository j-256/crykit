import { childAt, childCount, nodeAtPath, objectProperty, parseDocument } from './document'
import type { JsonNode, ParsedDocument } from './types'

export const MAP_EDITOR_FORMAT = 34
export const INVALID_VOXEL_ID = 255
export const MAP_EDITOR_LIMITS = Object.freeze({ entities: 20_000, brushSide: 8, strokeCells: 256, historyEntries: 100, historyCodeUnits: 4 * 1024 * 1024, intMin: -2_147_483_648, intMax: 2_147_483_647, byteMax: 255 })
export const MAP_ENTITY_TYPES = Object.freeze(['Npc', 'Sign', 'Spark', 'Door', 'HomePoint', 'Treasure', 'Crystal', 'Marker'] as const)
const NPC_TYPE = 0
const FULL_COLLISION = 3
const FREE_MOUNT = 20
const STATIONARY_WANDER = 0
const NO_SHADOW = 0
const ALWAYS_CONDITION = Object.freeze({ ConditionType: 0, Data: null, IsNegation: false })
const RUNTIME_ARRAYS = Object.freeze(['Abilities', 'Animations', 'Biomes', 'Difficulties', 'Equipment', 'Genders', 'Items', 'Jobs', 'Monsters', 'Passives', 'Recipes', 'Sparks', 'Statuses', 'Troops', 'Entities'])
const MODEL_ARRAYS = Object.freeze([...RUNTIME_ARRAYS, 'Folders', 'Tree'])

export interface PlacementCoord { readonly X: number; readonly Y: number; readonly Z: number }
export interface MapPlacement { readonly id: number; readonly index: number; readonly coord: PlacementCoord; readonly biomeId: number; readonly type: string; readonly voxelId?: number; readonly hasVoxelOutfit: boolean; readonly staticVoxel: boolean; readonly name: string }
export interface MapProject { readonly placements: readonly MapPlacement[]; readonly issues: readonly string[]; readonly editable: boolean }
export interface TextPatch { readonly start: number; readonly before: string; readonly after: string }

function integer(node: JsonNode | undefined, min: number = 0, max: number = MAP_EDITOR_LIMITS.intMax): number | undefined {
  if (node?.kind !== 'number') return undefined
  const value = Number(node.raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined
}
function string(node: JsonNode | undefined): string | undefined { return node?.kind === 'string' ? node.value as string : undefined }

export function inspectMapProject(document: ParsedDocument): MapProject {
  const issues: string[] = []
  const placements: MapPlacement[] = []
  const root = document.root
  if (root.kind !== 'object') return { placements, issues: ['Map editing requires a Crystal Edit project object.'], editable: false }
  if (!string(objectProperty(root, 'ID'))?.trim()) issues.push('A project ID is required; create a new map mod or open a complete Crystal Edit export.')
  if (integer(objectProperty(root, 'EditorVersion')) !== MAP_EDITOR_FORMAT) issues.push('Map editing supports Crystal Edit format 34. Other formats stay available in the JSON editor without conversion.')
  const localization = objectProperty(root, 'IsLocalization')
  if (localization && localization.raw !== 'false') issues.push('Localization projects cannot author map placements.')
  // The non-localization runtime iterates these arrays without supplying missing families
  // Refuse partial documents instead of silently manufacturing a different project envelope
  for (const family of RUNTIME_ARRAYS) if (objectProperty(root, family)?.kind !== 'array') issues.push(`${family} must be an array in a complete project export.`)
  const biomes = objectProperty(root, 'Biomes')
  if (biomes?.kind === 'array') {
    const biomeIds = new Set<number>()
    if (childCount(biomes) > MAP_EDITOR_LIMITS.byteMax + 1) issues.push('Biome identities exceed the native byte range.')
    else for (let index = 0; index < childCount(biomes); index++) {
      const id = integer(objectProperty(childAt(biomes, index)!, 'ID'), 0, MAP_EDITOR_LIMITS.byteMax)
      if (id === undefined || biomeIds.has(id)) issues.push(`Biome at index ${index} has an unsupported or repeated identity. Its map assignment stays unresolved.`)
      if (id !== undefined) biomeIds.add(id)
    }
  }
  const entities = objectProperty(root, 'Entities')
  if (entities?.kind !== 'array' || childCount(entities) > MAP_EDITOR_LIMITS.entities) return { placements, issues: [...issues, 'Entities must be a bounded array in the project export.'], editable: false }
  const ids = new Set<number>()
  for (let index = 0; index < childCount(entities); index++) {
    const record = childAt(entities, index)!
    const id = integer(objectProperty(record, 'ID'), 1)
    const coord = objectProperty(record, 'Coord')
    const axes = ['X', 'Y', 'Z'].map(axis => integer(coord && objectProperty(coord, axis), MAP_EDITOR_LIMITS.intMin))
    const biomeId = integer(objectProperty(record, 'BiomeID'), 0, MAP_EDITOR_LIMITS.byteMax)
    const typeCode = integer(objectProperty(record, 'EntityType'))
    const type = typeCode === undefined ? undefined : MAP_ENTITY_TYPES[typeCode]
    if (id === undefined || axes.some(value => value === undefined) || biomeId === undefined || !type || objectProperty(record, `${type}Data`)?.kind !== 'object') {
      issues.push(`Entity at index ${index} has an unsupported ID, coordinate, biome or type. Its source stays unchanged.`)
      continue
    }
    if (ids.has(id)) issues.push(`Entity ID ${id} is repeated. Resolve the ambiguity in JSON before map editing.`)
    ids.add(id)
    const npc = objectProperty(record, 'NpcData')
    const outfits = npc && objectProperty(npc, 'Outfits')
    const outfit = outfits?.kind === 'array' ? childAt(outfits, 0) : undefined
    const voxelId = integer(outfit && objectProperty(outfit, 'VoxelID'), 0, MAP_EDITOR_LIMITS.byteMax)
    let hasVoxelOutfit = false
    if (outfits?.kind === 'array') for (let index = 0; index < childCount(outfits); index++) if (integer(objectProperty(childAt(outfits, index)!, 'VoxelID'), 0, INVALID_VOXEL_ID - 1) !== undefined) hasVoxelOutfit = true
    const condition = outfit && objectProperty(outfit, 'Condition')
    const pages = npc && objectProperty(npc, 'Pages')
    // Only an unconditional stationary full-collision outfit can supply preview support
    // Conditional outfits, linked NPCs and scripted pages cannot establish reliable ground
    const staticVoxel = type === 'Npc' && outfits?.kind === 'array' && childCount(outfits) === 1
      && voxelId !== undefined && voxelId > 0 && voxelId < INVALID_VOXEL_ID
      && integer(condition && objectProperty(condition, 'ConditionType')) === 0 && objectProperty(condition!, 'IsNegation')?.raw === 'false'
      && integer(objectProperty(outfit!, 'MountType')) === FREE_MOUNT && integer(objectProperty(outfit!, 'WanderType')) === STATIONARY_WANDER
      && integer(objectProperty(outfit!, 'PlayerCollision')) === FULL_COLLISION && pages?.kind === 'array' && childCount(pages) === 0
      && objectProperty(npc!, 'LinkedKey')?.raw === 'null'
    const name = string(npc && objectProperty(npc, 'Key')) || string(outfit && objectProperty(outfit, 'Name')) || `${type} #${id}`
    placements.push({ id, index, coord: { X: axes[0]!, Y: axes[1]!, Z: axes[2]! }, biomeId, type, voxelId, hasVoxelOutfit, staticVoxel, name })
  }
  // Ambiguous or malformed records stay preserved, but cannot become targets for a map mutation
  return { placements, issues, editable: issues.length === 0 }
}

function requireProject(text: string): { document: ParsedDocument; project: MapProject } {
  const document = parseDocument(text)
  const project = inspectMapProject(document)
  if (!project.editable) throw new Error(project.issues[0])
  return { document, project }
}
function validateCoord(coord: PlacementCoord): void {
  if (![coord.X, coord.Y, coord.Z].every(value => Number.isSafeInteger(value) && value >= MAP_EDITOR_LIMITS.intMin && value <= MAP_EDITOR_LIMITS.intMax)) throw new Error('Placement coordinates must be signed 32-bit integers.')
}

export function moveMapPlacement(text: string, id: number, coord: PlacementCoord): string {
  validateCoord(coord)
  const { document, project } = requireProject(text)
  const placement = project.placements.find(record => record.id === id)
  if (!placement) throw new Error('The selected placement is unavailable; select it again.')
  if (placement.hasVoxelOutfit && project.placements.some(other => other.id !== id && other.hasVoxelOutfit && other.coord.X === coord.X && other.coord.Y === coord.Y && other.coord.Z === coord.Z)) throw new Error('This move overlaps another authored voxel placement. Choose another cell or height.')
  // Patch only coordinate leaves so unknown properties, scripts and exact numeric lexemes survive
  const patches = (['X', 'Y', 'Z'] as const).flatMap(axis => {
    if (placement.coord[axis] === coord[axis]) return []
    const node = nodeAtPath(document.root, ['Entities', placement.index, 'Coord', axis])!
    return [{ start: node.start, end: node.end, value: String(coord[axis]) }]
  }).sort((a, b) => b.start - a.start)
  let result = text
  for (const patch of patches) result = result.slice(0, patch.start) + patch.value + result.slice(patch.end)
  parseDocument(result)
  return result
}

export interface VoxelBlockOptions { readonly biomeId: number; readonly voxelId: number; readonly lastNativeEntityId: number; readonly knownVoxelIds: readonly number[] }

export function addVoxelPlatform(text: string, options: VoxelBlockOptions & { readonly coord: PlacementCoord; readonly width: number; readonly depth: number }): string {
  validateCoord(options.coord)
  if (![options.width, options.depth].every(value => Number.isInteger(value) && value > 0 && value <= MAP_EDITOR_LIMITS.brushSide)) throw new Error(`Platform width and depth must be between 1 and ${MAP_EDITOR_LIMITS.brushSide}.`)
  const coords = Array.from({ length: options.width * options.depth }, (_, index) => ({ X: options.coord.X + Math.floor(index / options.depth), Y: options.coord.Y, Z: options.coord.Z + index % options.depth }))
  return addVoxelBlocks(text, coords, options, false)
}

export function paintVoxelBlocks(text: string, coords: readonly PlacementCoord[], options: VoxelBlockOptions): string {
  return addVoxelBlocks(text, coords, options, true)
}

function addVoxelBlocks(text: string, coords: readonly PlacementCoord[], options: VoxelBlockOptions, skipOccupied: boolean): string {
  const { document, project } = requireProject(text)
  if (coords.length > MAP_EDITOR_LIMITS.strokeCells) throw new Error('The brush stroke exceeds the block limit. Release and start another stroke.')
  if (!Number.isInteger(options.biomeId) || options.biomeId < 0 || options.biomeId > MAP_EDITOR_LIMITS.byteMax) throw new Error('Choose a valid biome ID.')
  if (!Number.isInteger(options.voxelId) || options.voxelId <= 0 || options.voxelId >= INVALID_VOXEL_ID || !options.knownVoxelIds.includes(options.voxelId)) throw new Error('Choose a known non-air voxel from the pinned native reference.')
  if (!Number.isInteger(options.lastNativeEntityId) || options.lastNativeEntityId < 1 || options.lastNativeEntityId >= MAP_EDITOR_LIMITS.intMax) throw new Error('The native entity ID boundary is unavailable.')
  // Any voxel outfit may become active; painting skips it without replacing its source
  // Platform authoring retains its stricter atomic overlap rejection
  const key = (coord: PlacementCoord) => `${coord.X},${coord.Y},${coord.Z}`
  const occupied = new Set(project.placements.filter(placement => placement.hasVoxelOutfit).map(placement => key(placement.coord)))
  const unique = new Map<string, PlacementCoord>()
  for (const coord of coords) {
    validateCoord(coord)
    if (occupied.has(key(coord))) {
      if (!skipOccupied) throw new Error('This platform overlaps an existing voxel placement. Choose another cell or height.')
    } else unique.set(key(coord), coord)
  }
  if (!unique.size) return text
  if (project.placements.length + unique.size > MAP_EDITOR_LIMITS.entities) throw new Error('This brush exceeds the map editor entity limit.')
  let id = Math.max(options.lastNativeEntityId, ...project.placements.map(placement => placement.id))
  if (id + unique.size > MAP_EDITOR_LIMITS.intMax) throw new Error('There are no safe entity IDs left for this brush.')
  const records: string[] = []
  for (const coord of unique.values()) {
    // The inspected loader redirects added IDs above the native boundary
    // NpcFree has zero gravity, WanderType.None keeps the authored block stationary,
    // and Full collisions create a cube rather than native stair or liquid behavior
    // The runtime dereferences outfit conditions even for unconditional objects
    records.push(JSON.stringify({ ID: ++id, Coord: coord, BiomeID: options.biomeId, EntityType: NPC_TYPE, Comments: '', NpcData: { Key: `MapBlock_${id}`, LinkedKey: null, TieToSpawn: true, UniquePerKey: false, Outfits: [{ Condition: ALWAYS_CONDITION, TextureKey: null, Name: null, PlayerCharacterLevel: null, JobID: null, Facing: 0, ShadowType: NO_SHADOW, AutoStep: false, VoxelID: options.voxelId, VoxelVariantIndex: 0, PlayerCollision: FULL_COLLISION, NpcCollision: FULL_COLLISION, MountType: FREE_MOUNT, JumpType: 0, KeepSpawned: false, WanderType: STATIONARY_WANDER, WanderSpeed: 0, WanderFrequency: 0, WanderRadius: 0, WanderRoute: [], WanderRouteIsLine: false }], Pages: [] } }))
  }
  const entities = objectProperty(document.root, 'Entities')!
  const insertion = `${project.placements.length ? ',' : ''}\n${records.join(',\n')}\n`
  // Validate the whole stroke before inserting; failures leave the original text intact
  const result = text.slice(0, entities.end - 1) + insertion + text.slice(entities.end - 1)
  parseDocument(result)
  return result
}

export function eraseVoxelBlocks(text: string, ids: readonly number[], lastNativeEntityId: number): string {
  const { document, project } = requireProject(text)
  if (!Number.isInteger(lastNativeEntityId) || lastNativeEntityId < 1 || ids.length > MAP_EDITOR_LIMITS.strokeCells) throw new Error('The block erase boundary is unavailable or the stroke exceeds its limit.')
  const selected = new Set(ids)
  if (!selected.size) return text
  for (const id of selected) {
    const placement = project.placements.find(value => value.id === id)
    // Erasing a native override would restore game state, and scripted/conditional NPCs
    // are not plain blocks even if one outfit happens to look like a cube
    if (!placement || id <= lastNativeEntityId || !placement.staticVoxel) throw new Error('Erase only added stationary voxel blocks. Native overrides and other entities stay unchanged.')
  }
  const entities = objectProperty(document.root, 'Entities')!
  const nodes = project.placements.map(placement => childAt(entities, placement.index)!)
  const ranges: { start: number; end: number }[] = []
  for (let index = 0; index < nodes.length; index++) {
    if (!selected.has(project.placements[index]!.id)) continue
    const first = index
    while (index + 1 < nodes.length && selected.has(project.placements[index + 1]!.id)) index++
    const last = index
    // Remove one adjacent separator per contiguous group without reserializing survivors
    // Unknown fields, numeric lexemes and whitespace outside removed spans remain exact
    ranges.push({ start: last === nodes.length - 1 && first > 0 ? nodes[first - 1]!.end : nodes[first]!.start, end: last < nodes.length - 1 ? nodes[last + 1]!.start : nodes[last]!.end })
  }
  let result = text
  for (const range of ranges.reverse()) result = result.slice(0, range.start) + result.slice(range.end)
  parseDocument(result)
  return result
}

export function newMapProject(id: string, timestamp: string): string {
  if (!id.trim() || !Number.isFinite(Date.parse(timestamp))) throw new Error('A project identity and timestamp are required.')
  return JSON.stringify({ ID: id, Title: 'Map placements', Description: '', Author: '', Version: '1.0', EditorVersion: MAP_EDITOR_FORMAT, SteamWorkshopFileID: 0, Timestamp: timestamp, IsLocalization: false, Language: '', HasCustomContent: false, Fonts: null, System: null, ...Object.fromEntries(MODEL_ARRAYS.map(family => [family, []])) }, null, 2)
}

export function mapTextPatch(before: string, after: string): TextPatch {
  let start = 0
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter-- }
  return { start, before: before.slice(start, endBefore), after: after.slice(start, endAfter) }
}

export function applyMapTextPatch(text: string, patch: TextPatch, direction: 'undo' | 'redo'): string {
  const expected = direction === 'undo' ? patch.after : patch.before
  const replacement = direction === 'undo' ? patch.before : patch.after
  if (text.slice(patch.start, patch.start + expected.length) !== expected) throw new Error('The document changed outside map history. Reopen the placement before editing.')
  const result = text.slice(0, patch.start) + replacement + text.slice(patch.start + expected.length)
  parseDocument(result)
  return result
}
