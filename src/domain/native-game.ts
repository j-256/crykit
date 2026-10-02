import type { CatalogEntity, CatalogEntityKind, CatalogId, CatalogRevisionId, CatalogSnapshot, EntityId, GameSetupRevision, JsonValue, Knowledge, SourceRef, Timestamp } from './types'
import { CLASS_FIELDS, classFields } from './crystal-edit.ts'
import { baseGameEntityId } from './entity-identities.ts'

export const NATIVE_GAME_CATALOG_ID = 'crystal-project-windows' as CatalogId
export const NATIVE_RECORD_FIELD = 'Native source record'
export const NATIVE_SOURCE_PREFIX = 'native-game:'
export const NATIVE_SCOPE_UNVERIFIED = 'NATIVE_SCOPE_UNVERIFIED'
export const NATIVE_SNAPSHOT_SCHEMA = 1
const MAX_NATIVE_JSON_NODES = 2_000_000
const MAX_NATIVE_JSON_DEPTH = 64
const MAX_NATIVE_RECORDS = 20_000
export const NATIVE_ENUM_TYPES = ['ActionConditionEval', 'ActionConditionGroup', 'ActionConditionVar', 'ElementType', 'EquipmentType', 'ItemSpecialBonus', 'SangAbilityAttribute', 'SangAbilityModTag', 'SangAbilityScope', 'SangAbilityTarget', 'SangJobLearnNodeType', 'SangMonsterCategory', 'SangSparkAreaShape', 'SangStatModTag', 'SangStatusCategory', 'SwimType'] as const
export const NATIVE_FAMILIES = Object.freeze({ ability: 'ability', actor: 'other', biome: 'location', difficulty: 'other', equipment: 'item', gender: 'other', item: 'item', job: 'class', monster: 'monster', passive: 'passive', recipe: 'recipe', spark: 'other', status: 'status', troop: 'other' } satisfies Record<string, CatalogEntityKind>)
export type NativeFamily = keyof typeof NATIVE_FAMILIES
export type NativeRecord = Readonly<Record<string, JsonValue>>
export interface NativeGameSnapshot {
  readonly schemaVersion: number
  readonly contentDigest: string
  readonly catalogChecksum: string
  readonly capturedAt: string
  readonly source: {
    readonly platform: string
    readonly gameVersion: string
    readonly executable: { readonly path: string; readonly sha256: string; readonly size: number; readonly fileVersion: string; readonly productVersion: string; readonly assemblyVersion: string; readonly productName: string }
    readonly files: readonly { readonly path: string; readonly sha256: string; readonly size: number; readonly databaseVersion: number }[]
  }
  readonly databases: Readonly<Record<string, JsonValue>>
  readonly enums: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly identityBindings: Readonly<Record<string, string>>
  readonly identitySource: { readonly sha256: string; readonly classTreesSha256: string; readonly commit: string }
}
export interface NativeRelationship {
  readonly label: string
  readonly database: string
  readonly databaseId: number
  readonly targetId?: string
  readonly name?: string
}
export interface NativeIdentity {
  readonly database: string
  readonly databaseId: number
  readonly mode: string
}

const PATCH_FAMILIES: Readonly<Record<string, NativeFamily>> = Object.freeze({ Abilities: 'ability', Difficulties: 'difficulty', Equipment: 'equipment', Genders: 'gender', Items: 'item', Jobs: 'job', Monsters: 'monster', Passives: 'passive', Recipes: 'recipe', Sparks: 'spark', Statuses: 'status', Troops: 'troop' })
const FAMILY_LABELS: Readonly<Record<NativeFamily, string>> = Object.freeze({ ability: 'Abilities', actor: 'Actor growth ratings', biome: 'Biomes', difficulty: 'Difficulty settings', equipment: 'Equipment', gender: 'Appearance bonuses', item: 'Items', job: 'Classes', monster: 'Monsters', passive: 'Passives', recipe: 'Recipes', spark: 'Overworld enemy behavior', status: 'Status effects', troop: 'Encounter compositions' })
const REFERENCE_FAMILIES: Readonly<Record<string, NativeFamily>> = Object.freeze({ AbilityID: 'ability', AbilityIDs: 'ability', PassiveIDs: 'passive', StatusID: 'status', InherentStatusID: 'status', MonsterID: 'monster', AllyMonsterIDFilter: 'monster', ItemID: 'item', IncreaseMaxCapacityForItemID: 'item', EquipmentID: 'equipment', PvpWeaponID: 'equipment', PvpJobID: 'job', PvpGenderID: 'gender', LocationBiomeID: 'biome', MapForBiomeID: 'biome' })
const LABELS: Readonly<Record<string, string>> = Object.freeze({ HP: 'HP', MP: 'MP', JP: 'JP', PP: 'PP', Exp: 'Experience', Money: 'Money (copper)', PAtk: 'Physical attack input', PDef: 'Physical defense input', MDef: 'Magical defense input', PPen: 'Physical penetration input', MPen: 'Magical penetration input', PCritChance: 'Physical critical chance input', PCritDmg: 'Physical critical damage input', PAccRating: 'Physical accuracy rating input', PEvaRating: 'Physical evasion rating input', PVariance: 'Physical variance input', HPCost: 'HP cost', MPCost: 'MP cost', APCost: 'AP cost', CTCost: 'CT cost', CDCost: 'Cooldown cost', NoAuto: 'Automatic stat generation disabled', NoAutoStats: 'Automatic equipment stats disabled', NoAutoCost: 'Automatic equipment price disabled', IsPvp: 'Uses player-style enemy setup', IsBoss: 'Boss', Cost: 'Cost (copper)' })
const GROUPS = Object.freeze({
  'Raw attributes': ['Str', 'Vit', 'Dex', 'Agi', 'Mnd', 'Spi', 'Spd', 'Lck'],
  'Raw combat inputs': ['PAtk', 'PPen', 'PDef', 'PCritChance', 'PCritDmg', 'PAccRating', 'PEvaRating', 'MPen', 'MDef', 'PVariance'],
  'Growth ratings': ['HPRating', 'MPRating', 'StrRating', 'VitRating', 'DexRating', 'AgiRating', 'MndRating', 'SpiRating', 'SpdRating', 'LckRating'],
  'Ability costs': ['JP', 'HPCost', 'MPCost', 'APCost', 'CTCost', 'CDCost'],
  'Ability scaling inputs': ['StrRate', 'VitRate', 'DexRate', 'AgiRate', 'MndRate', 'SpiRate', 'SpdRate', 'LckRate', 'ScalingPAtkRate', 'ScalingPower', 'BasePAtkRate', 'BasePower', 'BaseAcc', 'BaseCritChance', 'BaseCritDmg', 'BaseVar', 'PDefRate', 'MDefRate'],
})
const DETAIL_ARRAYS = new Set(['Actions', 'ItemDrops', 'ItemSteals', 'Members', 'LearnTree', 'TargetStatuses', 'UserStatuses', 'Ingredients', 'AbilityIDs', 'PassiveIDs'])
const PRESENTATION_FIELDS = new Set(['TexturePath', 'TexturePathAlt', 'TextureIndex', 'ActorTexturePathM', 'ActorTexturePathF', 'MemberTexturePathM', 'MemberTexturePathF', 'MemberTexturePathMAlt', 'MemberTexturePathFAlt', 'IconTexturePath', 'IconTextureIndex', 'IconPath', 'Color', 'BattlerColor', 'OutlineColor', 'ID', 'Name', 'SortOrder', 'ScaledOrder', 'Comments', 'Description', 'Flavor'])

export function nativeRecord(value: unknown): value is NativeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function nativeEntityId(database: string, id: number, mode = 'base'): EntityId {
  return baseGameEntityId(database, id, mode)
}

export function nativeIdentity(entity: Pick<CatalogEntity, 'fields'> & Partial<Pick<CatalogEntity, 'legacy'>>): NativeIdentity | undefined {
  const value = nativeRecord(entity.legacy) ? entity.legacy.native : undefined
  return nativeRecord(value) && typeof value.database === 'string' && typeof value.databaseId === 'number' && typeof value.mode === 'string'
    ? { database: value.database, databaseId: value.databaseId, mode: value.mode } : undefined
}

export function nativeDefinitionLabel(entity: Pick<CatalogEntity, 'fields'> & Partial<Pick<CatalogEntity, 'legacy'>>): string | undefined {
  const identity = nativeIdentity(entity)
  if (!identity) return undefined
  const version = entity.fields['Game version']
  return `Windows ${version?.state === 'known' && typeof version.value === 'string' ? version.value : '(version unresolved)'} · ${identity.mode === 'base' ? 'base database' : `${identity.mode} mode`}`
}

export function nativeDisplayName(entity: Pick<CatalogEntity, 'name' | 'fields'> & Partial<Pick<CatalogEntity, 'legacy'>>, name = entity.name): string {
  const identity = nativeIdentity(entity)
  return identity && identity.mode !== 'base' ? `${name} (${identity.mode} mode)` : name
}

function nativeRecordSummary(family: NativeFamily, record: NativeRecord, version: string, mode: string, modeTerm = 'override'): string {
  const modeLabel = mode === 'base' ? 'base database' : `${mode} ${modeTerm}`
  return family === 'monster' ? `Windows ${version} ${modeLabel}; level ${record.Level ?? 'unknown'}. Includes raw stats, rewards, loot, and action conditions.` : `Windows ${version} ${FAMILY_LABELS[family].toLowerCase()} ${modeLabel}.`
}

export function nativeDisplayDescription(entity: Pick<CatalogEntity, 'rawDescription' | 'fields'> & Partial<Pick<CatalogEntity, 'legacy'>>): string | undefined {
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  const version = entity.fields['Game version']
  if (identity && Object.hasOwn(NATIVE_FAMILIES, identity.database) && record && version?.state === 'known' && typeof version.value === 'string') {
    const family = identity.database as NativeFamily
    if (entity.rawDescription === nativeRecordSummary(family, record, version.value, identity.mode)) return nativeRecordSummary(family, record, version.value, identity.mode, 'mode')
  }
  return entity.rawDescription
}

export function nativeSourceRecord(entity: Pick<CatalogEntity, 'fields'>): NativeRecord | undefined {
  const field = entity.fields[NATIVE_RECORD_FIELD]
  return field?.state === 'known' && nativeRecord(field.value) ? field.value : undefined
}

export function nativeScopeUncertainty(catalog: Pick<CatalogSnapshot, 'legacy'>, setup: Pick<GameSetupRevision, 'platform' | 'gameVersion'>): string | undefined {
  const source = nativeRecord(catalog.legacy) ? catalog.legacy.nativeSource : undefined
  if (!nativeRecord(source) || typeof source.platform !== 'string' || typeof source.gameVersion !== 'string') return undefined
  const platformDiffers = setup.platform.state === 'known' && setup.platform.value !== source.platform
  const versionDiffers = setup.gameVersion.state === 'known' && setup.gameVersion.value !== source.gameVersion
  if (!platformDiffers && !versionDiffers) return undefined
  const context = [setup.platform.state === 'known' ? setup.platform.value : undefined, setup.gameVersion.state === 'known' ? setup.gameVersion.value : undefined].filter(Boolean).join(' ')
  return `Equivalence between ${source.platform} ${source.gameVersion} game data and ${context} is unresolved`
}

function label(key: string): string {
  return LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/IDs$/, ' IDs').replace(/ID$/, ' ID')
}

export function validateNativeSnapshot(snapshot: NativeGameSnapshot): void {
  if (snapshot.schemaVersion !== NATIVE_SNAPSHOT_SCHEMA || !/^[a-f0-9]{64}$/.test(snapshot.contentDigest) || !/^[a-f0-9]{64}$/.test(snapshot.catalogChecksum)) throw new Error('Native snapshot schema or digest is invalid')
  if (snapshot.source.platform !== 'Windows' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(snapshot.source.gameVersion)) throw new Error('Native source platform or version is invalid')
  const executable = snapshot.source.executable
  if (executable.path !== 'Crystal Project.exe' || !Number.isSafeInteger(executable.size) || executable.size <= 0 || !/^[a-f0-9]{64}$/.test(executable.sha256) || executable.fileVersion !== executable.productVersion || executable.fileVersion !== executable.assemblyVersion || executable.productName !== 'Crystal Project' || (executable.fileVersion.endsWith('.0') ? executable.fileVersion.slice(0, -2) : executable.fileVersion) !== snapshot.source.gameVersion) throw new Error('Native executable version evidence is inconsistent')
  if (!snapshot.capturedAt.includes('T') || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error('Native snapshot date is invalid')
  const files = new Set<string>()
  for (const file of snapshot.source.files) {
    if (!/^Database\/[a-z]+\.dat$/.test(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 3 || !Number.isSafeInteger(file.databaseVersion) || file.databaseVersion < 0 || files.has(file.path)) throw new Error('Native source file inventory is invalid')
    files.add(file.path)
  }
  let nodes = 0
  const visit = (value: JsonValue, depth: number): void => {
    if (++nodes > MAX_NATIVE_JSON_NODES || depth > MAX_NATIVE_JSON_DEPTH) throw new Error('Native data exceeds its complexity limit')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Native data contains a non-finite number')
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1) }
    else if (nativeRecord(value)) for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype', 'Comments'].includes(key)) throw new Error('Native data contains an unsupported object key')
      visit(item, depth + 1)
    }
  }
  visit(snapshot.databases, 0)
  visit(snapshot.enums, 0)
  for (const name of NATIVE_ENUM_TYPES) {
    const values = snapshot.enums[name]
    if (!nativeRecord(values) || !Object.keys(values).length || Object.entries(values).some(([code, label]) => !/^-?\d+$/.test(code) || typeof label !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label))) throw new Error(`Native executable enum ${name} is invalid or missing`)
  }
  if (!/^[a-f0-9]{64}$/.test(snapshot.identitySource.classTreesSha256) || !/^[a-f0-9]{64}$/.test(snapshot.identitySource.sha256) || !/^[a-f0-9]{40}$/.test(snapshot.identitySource.commit) || Object.entries(snapshot.identityBindings).some(([key, id]) => !/^(?:job|item|equipment|ability|passive):\d+$/.test(key) || !id || id.includes('\0'))) throw new Error('Native identity crosswalk evidence is invalid')
  const records = (value: JsonValue | undefined, context: string): void => {
    if (!Array.isArray(value) || value.length > MAX_NATIVE_RECORDS) throw new Error(`${context} must be a bounded record array`)
    const ids = new Set<number>()
    for (const record of value) {
      if (record === null) continue
      if (!nativeRecord(record) || !Number.isSafeInteger(record.ID) || (record.ID as number) < 0 || typeof record.Name !== 'string' || !record.Name.trim() || ids.has(record.ID as number)) throw new Error(`${context} contains an invalid or duplicate native ID`)
      ids.add(record.ID as number)
    }
  }
  for (const family of [...Object.keys(NATIVE_FAMILIES), 'patch', 'system']) {
    if (!files.has(`Database/${family}.dat`) || snapshot.databases[family] === undefined) throw new Error(`Native snapshot is missing ${family}`)
    if (family !== 'system') records(snapshot.databases[family], family)
  }
  if (!nativeRecord(snapshot.databases.system)) throw new Error('Native system database is invalid')
  for (const key of ['BattleConfig', 'FieldConfig', 'Vocab']) if (!nativeRecord(snapshot.databases.system[key])) throw new Error(`Native system database is missing ${key}`)
  for (const key of Object.keys(snapshot.identityBindings)) {
    const [family, id] = key.split(':')
    const records = snapshot.databases[family!]
    if (!Array.isArray(records) || !records.some(record => nativeRecord(record) && record.ID === Number(id))) throw new Error('Native identity binding points to a missing record')
  }
  for (const patch of snapshot.databases.patch as readonly JsonValue[]) {
    if (!nativeRecord(patch)) continue
    for (const [field, family] of Object.entries(PATCH_FAMILIES)) if (patch[field] !== undefined) records(patch[field], `${patch.Name}/${family}`)
  }
}

export function nativeRelationships(catalog: CatalogSnapshot, entity: Pick<CatalogEntity, 'fields'> & Partial<Pick<CatalogEntity, 'legacy'>>, mode?: string): readonly NativeRelationship[] {
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  if (!identity || !record) return []
  const result: NativeRelationship[] = []
  const add = (database: NativeFamily, id: JsonValue | undefined, path: string) => {
    if (id === null || id === undefined || !Number.isSafeInteger(id) || (id as number) < 0) return
    const bindings = nativeRecord(catalog.legacy) && nativeRecord(catalog.legacy.nativeIdentityBindings) ? catalog.legacy.nativeIdentityBindings : {}
    const modeBindings = nativeRecord(catalog.legacy) && nativeRecord(catalog.legacy.nativeModeIdentityBindings) ? catalog.legacy.nativeModeIdentityBindings : {}
    const baseId = bindings[`${database}:${id}`]
    const activeMode = mode ?? identity.mode
    const modeId = modeBindings[`${activeMode}:${database}:${id}`]
    const target = catalog.entities[typeof modeId === 'string' ? modeId : nativeEntityId(database, id as number, activeMode)] ?? catalog.entities[typeof baseId === 'string' ? baseId : nativeEntityId(database, id as number)]
    result.push({ label: path, database, databaseId: id as number, ...(target ? { targetId: target.id, name: target.name } : {}) })
  }
  const visit = (value: JsonValue, path: string) => {
    if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, `${path}/${index}`)); return }
    if (!nativeRecord(value)) return
    if (value.LootType === 1 || value.LootType === 2) {
      const family = value.LootType === 1 ? 'item' : 'equipment'
      const key = value.LootID !== undefined ? 'LootID' : value.LootType === 1 ? 'ItemID' : 'EquipmentID'
      add(family, value[key], `${path}/${key}`)
    }
    if (value.NodeType === 2 || value.NodeType === 3) add(value.NodeType === 2 ? 'ability' : 'passive', value.DataID, `${path}/DataID`)
    for (const [key, nested] of Object.entries(value)) {
      const family = REFERENCE_FAMILIES[key]
      if (family) {
        if (['ItemID', 'EquipmentID'].includes(key) && value.LootType !== undefined) continue
        if (Array.isArray(nested)) nested.forEach((id, index) => add(family, id, `${path}/${key}/${index}`))
        else add(family, nested, `${path}/${key}`)
      } else visit(nested, `${path}/${key}`)
    }
  }
  visit(record, '')
  return result
}

export function buildNativeCatalog(snapshot: NativeGameSnapshot): CatalogSnapshot {
  validateNativeSnapshot(snapshot)
  const entities: Record<string, CatalogEntity> = {}
  const version = snapshot.source.gameVersion
  const sourceFor = (database: string, id: number, mode: string, locator: string): SourceRef => ({ sourceId: `native-game:windows:${version}`, locator: `${locator}; native ${database} ID ${id}`, snapshot: `Windows ${version}; ${mode === 'base' ? 'base database' : `${mode} patch`}; executable SHA-256 ${snapshot.source.executable.sha256}`, applicability: 'Installed Windows game data; Switch 1.6.6 and optional-mod equivalence are unresolved' })
  const add = (family: NativeFamily, record: NativeRecord, mode: string, locator: string) => {
    const id = (mode === 'base' ? snapshot.identityBindings[`${family}:${record.ID}`] : undefined) as EntityId | undefined ?? nativeEntityId(family, record.ID as number, mode)
    if (entities[id]) throw new Error(`Duplicate native entity ${id}`)
    const source = sourceFor(family, record.ID as number, mode, locator)
    const fieldSource: SourceRef = { sourceId: source.sourceId, locator: source.locator }
    const known = (value: JsonValue): Knowledge<JsonValue> => ({ state: 'known', value, sources: [fieldSource] })
    const fields: Record<string, Knowledge<JsonValue>> = { Category: known([FAMILY_LABELS[family], ...(mode === 'base' ? [] : [`${mode} mode overrides`])]), 'Game platform': known('Windows'), 'Game version': known(version), 'Mode data': known(mode === 'base' ? 'Base database' : `${mode} patch`), [NATIVE_RECORD_FIELD]: { state: 'known', value: record, sources: [source] }, ...(family === 'job' ? classFields(record, source, CLASS_FIELDS) : {}) }
    const grouped = new Set<string>()
    for (const [group, keys] of Object.entries(GROUPS)) {
      if (group === 'Ability costs' && family !== 'ability') continue
      const members = keys.filter(key => Object.hasOwn(record, key))
      if (!members.length) continue
      fields[group] = known(Object.fromEntries(members.map(key => [label(key), record[key]!])))
      members.forEach(key => grouped.add(key))
    }
    for (const [key, value] of Object.entries(record)) {
      if (grouped.has(key) || PRESENTATION_FIELDS.has(key) || DETAIL_ARRAYS.has(key) || key === 'StatMods' || key === 'AbilityMods' || key.endsWith('AnimationID') || key.startsWith('Texture') || key.endsWith('IDs') || key.endsWith('ID')) continue
      const name = key === 'Category' ? 'Native category code' : key === 'JP' && family === 'monster' ? 'JP reward' : label(key)
      const enumType = ({ EquipmentType: 'EquipmentType', Element: 'ElementType', Scope: 'SangAbilityScope', Target: 'SangAbilityTarget', Attribute: 'SangAbilityAttribute', Category: family === 'monster' ? 'SangMonsterCategory' : family === 'status' ? 'SangStatusCategory' : undefined, AreaShape: 'SangSparkAreaShape', SwimType: 'SwimType', SpecialBonus: 'ItemSpecialBonus' } as Readonly<Record<string, string | undefined>>)[key]
      const enumName = enumType && typeof value === 'number' ? snapshot.enums[enumType]?.[value] : undefined
      fields[name] = value === null ? { state: 'unknown', reason: `Native ${key} is null; effective meaning is unresolved`, sources: [source] } : known(enumName ? `${enumName} (code ${value})` : value)
    }
    if (record.Description !== undefined && record.Description !== null) fields.Description = known(record.Description)
    if (family === 'ability') {
      const costs = ['HP', 'MP', 'AP', 'CT', 'CD']
      fields.Cost = costs.every(cost => typeof record[`${cost}Cost`] === 'number') ? known(costs.filter(cost => record[`${cost}Cost`] !== 0).map(cost => `${record[`${cost}Cost`]}${cost === 'HP' ? '%' : ''} ${cost}`).join('\n') || 'None') : { state: 'unknown', reason: 'Native resource costs are incomplete', sources: [fieldSource] }
    }
    if (record.Flavor !== undefined && record.Flavor !== null) fields.Flavor = known(record.Flavor)
    const sourceDescription = typeof record.Description === 'string' && record.Description.trim() ? record.Description : undefined
    const summary = nativeRecordSummary(family, record, version, mode)
    const kind = family === 'passive' && record.IsInnate === true ? 'innate' : NATIVE_FAMILIES[family]
    const statMods = Array.isArray(record.StatMods) ? record.StatMods.filter(nativeRecord).map(mod => ({ ...mod, Name: snapshot.enums.SangStatModTag?.[String(mod.Tag)] ?? `Unresolved stat modifier ${mod.Tag}` })) : undefined
    if (statMods) fields['Stat modifiers'] = known(statMods)
    if (Array.isArray(record.AbilityMods)) fields['Ability modifiers'] = known(record.AbilityMods.filter(nativeRecord).map(mod => ({ ...mod, Name: snapshot.enums.SangAbilityModTag?.[String(mod.Tag)] ?? `Unresolved ability modifier ${mod.Tag}` })))
    entities[id] = { id, kind, name: (record.Name as string).trim(), aliases: [], rawDescription: sourceDescription ?? summary, fields, sources: [source], legacy: { native: { database: family, databaseId: record.ID!, mode } }, ...(family === 'passive' ? { ppCost: typeof record.PP === 'number' ? { state: 'known', value: record.PP, sources: [source] } : { state: 'unknown', reason: 'No numeric native PP cost', sources: [source] } } : {}) }
  }
  for (const family of Object.keys(NATIVE_FAMILIES) as NativeFamily[]) (snapshot.databases[family] as readonly JsonValue[]).forEach((record, index) => { if (nativeRecord(record)) add(family, record, 'base', `Database/${family}.dat/${index}`) })
  const modeNames = new Set<string>()
  for (const [patchIndex, patch] of (snapshot.databases.patch as readonly JsonValue[]).entries()) {
    if (!nativeRecord(patch)) continue
    const mode = patch.Name as string
    if (mode === 'base' || modeNames.has(mode)) throw new Error('Native patch mode names must be unique')
    modeNames.add(mode)
    for (const [field, family] of Object.entries(PATCH_FAMILIES)) (patch[field] as readonly JsonValue[] | undefined)?.forEach((record, index) => { if (nativeRecord(record)) add(family, record, mode, `Database/patch.dat/${patchIndex}/${field}/${index}`) })
  }
  const classesByDefinition = new Map<string, Set<string>>()
  for (const job of Object.values(entities)) {
    const identity = nativeIdentity(job)
    if (identity?.database !== 'job') continue
    const record = nativeSourceRecord(job)!
    for (const [key, family] of [['AbilityIDs', 'ability'], ['PassiveIDs', 'passive']] as const) {
      if (!Array.isArray(record[key])) continue
      for (const id of record[key]) {
        if (typeof id !== 'number') continue
        const target = identity.mode === 'base' ? snapshot.identityBindings[`${family}:${id}`] ?? nativeEntityId(family, id) : nativeEntityId(family, id, identity.mode)
        if (!entities[target]) continue
        const names = classesByDefinition.get(target) ?? new Set<string>()
        names.add(job.name)
        classesByDefinition.set(target, names)
      }
    }
  }
  for (const [id, names] of classesByDefinition) {
    const entity = entities[id]!
    entities[id] = { ...entity, fields: { ...entity.fields, Class: { state: 'known', value: [...names], sources: [{ sourceId: entity.sources[0]!.sourceId, locator: 'Native job AbilityIDs and PassiveIDs membership in the same database mode' }] } } }
  }
  const system = snapshot.databases.system as NativeRecord
  for (const [index, [key, value]] of Object.entries(system).entries()) {
    const id = nativeEntityId('system', index)
    const source = sourceFor('system', index, 'base', `Database/system.dat/${key}`)
    entities[id] = { id, kind: 'other', name: `Game ${label(key).toLowerCase()}`, aliases: [], fields: { Category: { state: 'known', value: ['Game configuration'] }, 'Game version': { state: 'known', value: version }, [label(key)]: { state: 'known', value, sources: [source] } }, sources: [source] }
  }
  return { id: NATIVE_GAME_CATALOG_ID, revisionId: `windows-${version}:${snapshot.contentDigest}` as CatalogRevisionId, schemaVersion: 'native-game-1', checksum: `builtin:sha256:${snapshot.catalogChecksum}`, importedAt: snapshot.capturedAt as Timestamp, applicability: { state: 'known', value: `Windows ${version} native reference data; Switch 1.6.6 equivalence unresolved` }, rights: { state: 'unknown', reason: 'Crystal Project game data has source-specific rights; no AGPL or CC-BY-SA content grant is asserted' }, entities, claims: [], legacy: { nativeSource: snapshot.source as unknown as JsonValue, nativeIdentityBindings: snapshot.identityBindings, nativeEnums: snapshot.enums, sourceContentDigest: snapshot.contentDigest, modeNames: [...modeNames] } }
}

export function assembleNativeBase(supplement: CatalogSnapshot, snapshot: NativeGameSnapshot): CatalogSnapshot {
  const native = buildNativeCatalog(snapshot)
  const entities: Record<string, CatalogEntity> = Object.fromEntries(Object.entries(supplement.entities).map(([id, entity]) => [id, { ...entity, legacy: { ...(nativeRecord(entity.legacy) ? entity.legacy : {}), supplemental: true } }]))
  for (const [id, entity] of Object.entries(native.entities)) {
    const secondary = entities[id]
    const description = nativeSourceRecord(entity)?.Description
    const supplementalDescription = secondary?.rawDescription && !(typeof description === 'string' && description.trim())
    entities[id] = secondary ? { ...secondary, ...entity, ...(supplementalDescription ? { rawDescription: secondary.rawDescription } : {}), aliases: [...new Set([...entity.aliases, ...secondary.aliases, ...(secondary.name === entity.name ? [] : [secondary.name])])], fields: { ...secondary.fields, ...entity.fields }, sources: [...entity.sources, ...secondary.sources], legacy: { ...(nativeRecord(secondary.legacy) ? secondary.legacy : {}), ...(nativeRecord(entity.legacy) ? entity.legacy : {}), supplemental: false, ...(supplementalDescription ? { nativeDescriptionSupplemental: true } : {}) } } : entity
  }
  return { ...native, id: supplement.id, revisionId: supplement.revisionId, checksum: supplement.checksum, entities, claims: supplement.claims, legacy: { ...(nativeRecord(native.legacy) ? native.legacy : {}), primarySource: 'native-game', supplementalSources: 'Community wiki, Crystal Edit class copies, modding guide, and Switch observations retain their individual provenance' } }
}
