import type { CrystalSave } from '../interchange/crystal-save'
import { crystalEditPlanningRecord } from './crystal-edit-compatibility'
import { jsonRecord } from './crystal-edit'
import { bundledModIdentity } from './bundled-mods'
import { entityDefinitionKey } from './core'
import { modCatalogTitle, modModelRecords } from './mod-layers'
import { modRevision } from './mod-library'
import { nativeIdentity, type NativeGameSnapshot, type NativeRecord } from './native-game'
import type { CatalogRef, CatalogSnapshot, EntityRef, JsonValue } from './types'

export const SAVE_EDITOR_FAMILIES = ['job', 'ability', 'passive', 'item', 'equipment', 'gender'] as const
export type SaveEditorFamily = typeof SAVE_EDITOR_FAMILIES[number]
export type SaveEditorModeKey = 'standard' | 'vanilla' | 'chaos'
export interface SaveEditorMode { readonly value: number; readonly key: SaveEditorModeKey; readonly name: 'Standard' | 'Vanilla' | 'Chaos' }
export interface SaveEditorModePatch { readonly mode: SaveEditorMode; readonly records: Readonly<Record<SaveEditorFamily, ReadonlyMap<number, NativeRecord>>> }
export interface SaveEditorCatalog {
  readonly source: string
  readonly mode: SaveEditorMode
  readonly records: Readonly<Record<SaveEditorFamily, ReadonlyMap<number, NativeRecord>>>
  readonly baseRecords: Readonly<Record<SaveEditorFamily, ReadonlyMap<number, NativeRecord>>>
  readonly modePatches: ReadonlyMap<number, SaveEditorModePatch>
}
export interface SaveEditorModSource {
  readonly id: string
  readonly title: string
  readonly version?: string
  readonly editorVersion?: number
  readonly checksum: string
  readonly steamWorkshopFileId?: string
  readonly origin: 'bundled' | 'file'
  readonly catalog?: CatalogSnapshot
  readonly bundledKey?: string
  readonly records: Readonly<Record<SaveEditorFamily, ReadonlyMap<number, NativeRecord>>>
  readonly issues: readonly string[]
}
export interface SaveEditorDefinitionBinding { readonly family: SaveEditorFamily; readonly id: number }
export interface SaveEditorDefinitionScope {
  readonly catalogs: readonly CatalogSnapshot[]
  readonly bindings: ReadonlyMap<string, SaveEditorDefinitionBinding>
  readonly refs: Readonly<Record<SaveEditorFamily, ReadonlyMap<number, CatalogRef>>>
}
export interface SaveEditorActiveMod {
  readonly id: string
  readonly title: string
  readonly version: string
  readonly matched: boolean
  readonly sourceChecksum?: string
}
export interface SaveEditorModResolution {
  readonly catalog: SaveEditorCatalog
  readonly activeMods: readonly SaveEditorActiveMod[]
  readonly historicalModIds: readonly string[]
  readonly hasHeaderModState: boolean
  readonly issues: readonly string[]
}

const MODEL_FAMILIES: Readonly<Record<string, SaveEditorFamily | undefined>> = Object.freeze({ Jobs: 'job', Abilities: 'ability', Passives: 'passive', Items: 'item', Equipment: 'equipment', Genders: 'gender' })
const PATCH_FIELDS: Readonly<Record<SaveEditorFamily, string>> = Object.freeze({ job: 'Jobs', ability: 'Abilities', passive: 'Passives', item: 'Items', equipment: 'Equipment', gender: 'Genders' })
const REDIRECT_GROUPS: Readonly<Record<SaveEditorFamily, string>> = Object.freeze({ job: 'jobs', ability: 'abilities', passive: 'passives', item: 'items', equipment: 'equipment', gender: 'genders' })
const UNSUPPORTED_REDIRECT_GROUPS = ['animations', 'biomes', 'difficulties', 'monsters', 'recipes', 'sparks', 'statuses', 'troops', 'entities'] as const
const LEARN_NODE = Object.freeze({ ability: 2, passive: 3 })
const STANDARD_MODE: SaveEditorMode = Object.freeze({ value: 0, key: 'standard', name: 'Standard' })
const PATCH_MODE_NAMES: Readonly<Record<string, Pick<SaveEditorMode, 'key' | 'name'>>> = Object.freeze({ Vanilla: { key: 'vanilla', name: 'Vanilla' }, Chaos: { key: 'chaos', name: 'Chaos' } })

function nativeRecords(values: unknown, context: string): ReadonlyMap<number, NativeRecord> {
  if (!Array.isArray(values)) throw new Error(`Missing native ${context} definitions`)
  return new Map(values.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.ID === 'number' ? [[value.ID, value as NativeRecord] as const] : []))
}

export function createSaveEditorCatalog(snapshot: NativeGameSnapshot): SaveEditorCatalog {
  const records = {} as Record<SaveEditorFamily, ReadonlyMap<number, NativeRecord>>
  for (const family of SAVE_EDITOR_FAMILIES) records[family] = nativeRecords(snapshot.databases[family], family)
  const modePatches = new Map<number, SaveEditorModePatch>()
  if (!Array.isArray(snapshot.databases.patch)) throw new Error('Missing native patch definitions')
  for (const value of snapshot.databases.patch) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ID !== 'number' || typeof value.Name !== 'string') continue
    const identity = PATCH_MODE_NAMES[value.Name]
    if (!identity) continue
    const mode = Object.freeze({ value: value.ID + 1, ...identity })
    if (modePatches.has(mode.value)) throw new Error(`Duplicate native game mode ${mode.value}`)
    const patchRecords = {} as Record<SaveEditorFamily, ReadonlyMap<number, NativeRecord>>
    for (const family of SAVE_EDITOR_FAMILIES) patchRecords[family] = nativeRecords(value[PATCH_FIELDS[family]], `${mode.name} ${family}`)
    modePatches.set(mode.value, { mode, records: patchRecords })
  }
  for (const name of Object.keys(PATCH_MODE_NAMES)) if (![...modePatches.values()].some(patch => patch.mode.name === name)) throw new Error(`Missing native ${name} game mode`)
  return { source: `${snapshot.source.platform} PC ${snapshot.source.gameVersion}`, mode: STANDARD_MODE, records, baseRecords: records, modePatches }
}

export function saveEditorCatalogForMode(catalog: SaveEditorCatalog, value: number): SaveEditorCatalog {
  if (catalog.mode.value === value) return catalog
  if (value === STANDARD_MODE.value) return { ...catalog, mode: STANDARD_MODE, records: catalog.baseRecords }
  const patch = catalog.modePatches.get(value)
  if (!patch) throw new Error(`Unsupported game mode ${value}`)
  const records = {} as Record<SaveEditorFamily, ReadonlyMap<number, NativeRecord>>
  for (const family of SAVE_EDITOR_FAMILIES) {
    const merged = new Map(catalog.baseRecords[family])
    for (const [id, record] of patch.records[family]) {
      const base = merged.get(id)
      if (!base) throw new Error(`${patch.mode.name} mode references unknown native ${family} ${id}`)
      merged.set(id, { ...base, ...record })
    }
    records[family] = merged
  }
  return { ...catalog, source: `${catalog.source} ${patch.mode.name} mode`, mode: patch.mode, records }
}

export function createSaveEditorModSource(catalog: CatalogSnapshot, warnings: readonly { readonly code: string }[] = [], origin: SaveEditorModSource['origin'] = 'file', bundledKey?: string): SaveEditorModSource {
  const revision = modRevision(catalog)
  if (!revision) throw new Error('Choose a Crystal Edit project JSON file')
  const records = Object.fromEntries(SAVE_EDITOR_FAMILIES.map(family => [family, new Map<number, NativeRecord>()])) as Record<SaveEditorFamily, Map<number, NativeRecord>>
  const issues: string[] = []
  const unsupported = new Set<string>()
  for (const [modelKey, entity] of modModelRecords(catalog)) {
    const familyName = modelKey.split(':')[1]!
    const family = MODEL_FAMILIES[familyName]
    if (!family) { unsupported.add(familyName); continue }
    const record = crystalEditPlanningRecord(entity)
    if (!record || typeof record.ID !== 'number') { issues.push(`${familyName} definitions could not be interpreted for this editor format`); continue }
    records[family].set(record.ID, record as NativeRecord)
  }
  if (warnings.some(warning => warning.code === 'archived-models')) unsupported.add('archived models')
  const metadata = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
  const rules = jsonRecord(metadata?.gameRules) ? metadata.gameRules : undefined
  if (rules?.localization === true) issues.push('Localization projects are not supported by mod-aware save editing')
  if (unsupported.size) issues.push(`Unsupported model families are present: ${[...unsupported].sort().join(', ')}`)
  return {
    id: String(catalog.id).replace(/^crystal-edit:/, ''),
    title: modCatalogTitle(catalog),
    version: revision.declaredVersion,
    editorVersion: revision.editorVersion,
    checksum: revision.sourceDigest,
    steamWorkshopFileId: revision.steamWorkshopFileId,
    origin, catalog, ...(bundledKey ? { bundledKey } : {}),
    records,
    issues: [...new Set(issues)],
  }
}

function catalogRef(catalog: CatalogSnapshot, entityId: string): CatalogRef {
  return { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entityId as CatalogRef['entityId'] }
}

function exactSource(saved: CrystalSave['header']['mods'][number], sources: readonly SaveEditorModSource[]) {
  const matches = sources.filter(source => source.id === saved.id && (source.version ?? '') === saved.version && (saved.steamWorkshopFileId === 0n || source.steamWorkshopFileId === saved.steamWorkshopFileId.toString()))
  return matches.length === 1 ? matches[0] : undefined
}

export function saveEditorDefinitionScope(save: CrystalSave, baseline: CatalogSnapshot, sources: readonly SaveEditorModSource[] = [], mode: SaveEditorMode = STANDARD_MODE): SaveEditorDefinitionScope {
  const bindings = new Map<string, SaveEditorDefinitionBinding>()
  const refs = Object.fromEntries(SAVE_EDITOR_FAMILIES.map(family => [family, new Map<number, CatalogRef>()])) as Record<SaveEditorFamily, Map<number, CatalogRef>>
  const activeSources = save.header.mods.flatMap(saved => {
    const source = exactSource(saved, sources)
    const redirects = save.header.modIdMaps.find(map => map.modId === saved.id)?.groups
    return source?.catalog && redirects ? [{ source, redirects }] : []
  })
  const overlays = new Set<string>()
  for (const { source, redirects } of activeSources) for (const family of SAVE_EDITOR_FAMILIES) for (const originalId of source.records[family].keys()) {
    const effectiveId = redirects[REDIRECT_GROUPS[family]]?.find(pair => pair.originalId === originalId)?.newId ?? originalId
    overlays.add(`${family}:${effectiveId}`)
  }
  const modeOverrides = new Set(Object.values(baseline.entities).flatMap(entity => {
    const native = nativeIdentity(entity)
    return native?.mode === mode.name && SAVE_EDITOR_FAMILIES.includes(native.database as SaveEditorFamily) ? [`${native.database}:${native.databaseId}`] : []
  }))
  const baselineEntities = Object.fromEntries(Object.entries(baseline.entities).filter(([entityId, entity]) => {
    const native = nativeIdentity(entity)
    if (native && SAVE_EDITOR_FAMILIES.includes(native.database as SaveEditorFamily)) {
      const family = native.database as SaveEditorFamily
      const ref = catalogRef(baseline, entityId)
      const overlaid = overlays.has(`${family}:${native.databaseId}`)
      const selectedMode = modeOverrides.has(`${family}:${native.databaseId}`) ? mode.name : 'base'
      if (!overlaid && (native.mode === 'base' || native.mode === mode.name)) bindings.set(entityDefinitionKey(ref), { family, id: native.databaseId })
      if (!overlaid && native.mode === selectedMode) refs[family].set(native.databaseId, ref)
      return !overlaid && native.mode === selectedMode
    }
    const bundled = bundledModIdentity(entity)
    if (!bundled) return false
    const active = activeSources.find(({ source }) => source.bundledKey === bundled.key && source.version === bundled.version)
    const family = MODEL_FAMILIES[bundled.family]
    if (!active || !family) return false
    const effectiveId = active.redirects[REDIRECT_GROUPS[family]]?.find(pair => pair.originalId === bundled.modelId)?.newId ?? bundled.modelId
    const ref = catalogRef(baseline, entityId)
    bindings.set(entityDefinitionKey(ref), { family, id: effectiveId })
    refs[family].set(effectiveId, ref)
    return true
  }))
  const catalogs: CatalogSnapshot[] = [{ ...baseline, entities: baselineEntities }]
  for (const { source, redirects } of activeSources) {
    const catalog = source.catalog!
    const entities: Record<string, (typeof catalog.entities)[string]> = {}
    for (const [modelKey, entity] of modModelRecords(catalog)) {
      const family = MODEL_FAMILIES[modelKey.split(':')[1]!]
      const originalId = Number(modelKey.split(':')[2])
      if (!family || !Number.isSafeInteger(originalId)) continue
      const effectiveId = redirects[REDIRECT_GROUPS[family]]?.find(pair => pair.originalId === originalId)?.newId ?? originalId
      const ref = catalogRef(catalog, entity.id)
      bindings.set(entityDefinitionKey(ref), { family, id: effectiveId })
      if (!refs[family].has(effectiveId)) refs[family].set(effectiveId, ref)
      entities[entity.id] = entity
    }
    catalogs.push({ ...catalog, entities })
  }
  return { catalogs, bindings, refs }
}

export function saveEditorDefinitionId(scope: SaveEditorDefinitionScope, ref: EntityRef | null | undefined, family: SaveEditorFamily): number | null | undefined {
  if (ref === null) return null
  if (!ref) return undefined
  const binding = scope.bindings.get(entityDefinitionKey(ref))
  return binding?.family === family ? binding.id : undefined
}

export function saveEditorModProjectId(id: string) {
  return id.replace(/^crystal-edit:/, '')
}

export function saveEditorModSourceKey(source: Pick<SaveEditorModSource, 'id' | 'version' | 'steamWorkshopFileId'>) {
  return `${source.id}\u0000${source.version ?? ''}\u0000${source.steamWorkshopFileId ?? ''}`
}

function cloneCatalog(catalog: SaveEditorCatalog): Record<SaveEditorFamily, Map<number, NativeRecord>> {
  return Object.fromEntries(SAVE_EDITOR_FAMILIES.map(family => [family, new Map(catalog.records[family])])) as Record<SaveEditorFamily, Map<number, NativeRecord>>
}

function mappedId(groups: CrystalSave['header']['modIdMaps'][number]['groups'], family: SaveEditorFamily, id: JsonValue): JsonValue {
  if (typeof id !== 'number') return id
  return groups[REDIRECT_GROUPS[family]]?.find(pair => pair.originalId === id)?.newId ?? id
}

function mappedIds(groups: CrystalSave['header']['modIdMaps'][number]['groups'], family: SaveEditorFamily, value: JsonValue | undefined): JsonValue | undefined {
  return Array.isArray(value) ? value.map(id => mappedId(groups, family, id)) : value
}

function effectiveRecord(family: SaveEditorFamily, record: NativeRecord, id: number, groups: CrystalSave['header']['modIdMaps'][number]['groups']): NativeRecord {
  const next = structuredClone(record) as Record<string, JsonValue>
  next.ID = id
  if (family === 'job') {
    if (Array.isArray(next.AbilityIDs)) next.AbilityIDs = mappedIds(groups, 'ability', next.AbilityIDs)!
    if (Array.isArray(next.PassiveIDs)) next.PassiveIDs = mappedIds(groups, 'passive', next.PassiveIDs)!
    if (Array.isArray(next.LearnTree)) next.LearnTree = next.LearnTree.map(column => Array.isArray(column) ? column.map(node => {
      if (!jsonRecord(node)) return node
      const target = node.NodeType === LEARN_NODE.ability ? 'ability' : node.NodeType === LEARN_NODE.passive ? 'passive' : undefined
      return target ? { ...node, DataID: mappedId(groups, target, node.DataID) } : node
    }) : column)
  }
  if (family === 'item') {
    if (next.AbilityID !== undefined && next.AbilityID !== null) next.AbilityID = mappedId(groups, 'ability', next.AbilityID)
    if (next.IncreaseMaxCapacityForItemID !== undefined && next.IncreaseMaxCapacityForItemID !== null) next.IncreaseMaxCapacityForItemID = mappedId(groups, 'item', next.IncreaseMaxCapacityForItemID)
  }
  return next
}

export function resolveSaveEditorMods(save: CrystalSave, nativeCatalog: SaveEditorCatalog, sources: readonly SaveEditorModSource[] = []): SaveEditorModResolution {
  const issues: string[] = []
  let modeCatalog = nativeCatalog
  try { modeCatalog = saveEditorCatalogForMode(nativeCatalog, save.header.patchMode) }
  catch (error) { issues.push(error instanceof Error ? error.message : 'Unsupported game mode') }
  const records = cloneCatalog(modeCatalog)
  const activeIds = new Set(save.header.mods.map(mod => mod.id))
  const historicalModIds = [...new Set(save.header.modIdMaps.map(map => map.modId).filter(id => !activeIds.has(id)))]
  const activeMods: SaveEditorActiveMod[] = []
  if (save.header.mods.length && save.header.version < 25) issues.push('Mod-aware editing requires save format 25 or newer with saved ID redirects')
  for (const saved of save.header.mods) {
    const declaredMatches = sources.filter(source => source.id === saved.id && (source.version ?? '') === saved.version)
    const matches = declaredMatches.filter(source => saved.steamWorkshopFileId === 0n || source.steamWorkshopFileId === saved.steamWorkshopFileId.toString())
    activeMods.push({ id: saved.id, title: saved.title, version: saved.version, matched: matches.length === 1, ...(matches.length === 1 ? { sourceChecksum: matches[0]!.checksum } : {}) })
    if (!declaredMatches.length) { issues.push(`Add the exact ${saved.title} ${saved.version || '(unversioned)'} Crystal Edit JSON to edit this save`); continue }
    if (!matches.length) { issues.push(`${saved.title}: Steam Workshop identity does not match the save`); continue }
    if (matches.length > 1) { issues.push(`Multiple imported sources match ${saved.title} ${saved.version || '(unversioned)'}`); continue }
    const source = matches[0]!
    issues.push(...source.issues.map(issue => `${saved.title}: ${issue}`))
    const idMaps = save.header.modIdMaps.filter(map => map.modId === saved.id)
    if (idMaps.length !== 1) { issues.push(`${saved.title}: the save requires exactly one ID redirect table`); continue }
    const groups = idMaps[0]!.groups
    const unsupported = UNSUPPORTED_REDIRECT_GROUPS.filter(group => (groups[group]?.length ?? 0) > 0)
    if (unsupported.length) issues.push(`${saved.title}: unsupported saved redirects are present for ${unsupported.join(', ')}`)
    for (const family of SAVE_EDITOR_FAMILIES) {
      const pairs = groups[REDIRECT_GROUPS[family]] ?? []
      const byOriginal = new Map<number, number>()
      const newIds = new Set<number>()
      for (const pair of pairs) {
        if (!Number.isSafeInteger(pair.originalId) || pair.originalId < 0 || !Number.isSafeInteger(pair.newId) || pair.newId < 0 || byOriginal.has(pair.originalId) || newIds.has(pair.newId)) {
          issues.push(`${saved.title}: ${family} redirects are invalid or duplicated`)
          continue
        }
        byOriginal.set(pair.originalId, pair.newId)
        newIds.add(pair.newId)
      }
      for (const originalId of byOriginal.keys()) if (!source.records[family].has(originalId)) issues.push(`${saved.title}: ${family} redirect ${originalId} has no matching source definition`)
      for (const [originalId, record] of source.records[family]) {
        const redirected = byOriginal.get(originalId)
        if (modeCatalog.records[family].has(originalId) && redirected !== undefined) issues.push(`${saved.title}: native ${family} ${originalId} unexpectedly has an additive redirect`)
        if (!modeCatalog.records[family].has(originalId) && redirected === undefined) { issues.push(`${saved.title}: added ${family} ${originalId} has no saved redirect`); continue }
        const effectiveId = redirected ?? originalId
        if (redirected !== undefined && records[family].has(effectiveId)) { issues.push(`${saved.title}: redirected ${family} ${effectiveId} collides with an existing definition`); continue }
        records[family].set(effectiveId, effectiveRecord(family, record, effectiveId, groups))
      }
    }
  }
  return {
    catalog: { ...modeCatalog, source: save.header.mods.length ? `${modeCatalog.source} with ${save.header.mods.map(mod => `${mod.title} ${mod.version}`.trim()).join(', ')}` : modeCatalog.source, records },
    activeMods,
    historicalModIds,
    hasHeaderModState: save.header.isModded || save.header.mods.length > 0 || save.header.modIdMaps.length > 0,
    issues: [...new Set(issues)],
  }
}
