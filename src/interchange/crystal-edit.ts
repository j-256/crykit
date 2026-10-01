import { importedGameRules, IMPORTED_RULES_REVISION } from '../domain/game-rules'
import { z } from 'zod'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { bundledModEntityId } from '../domain/bundled-mods'
import { gameRecordFacts } from '../domain/game-record-facts'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { MAX_ID_LENGTH } from '../domain/limits'
import { classFields, jsonRecord, LAST_VANILLA_JOB_ID, LEARN_NODE_TYPES, MAX_GROWTH_RATING, MAX_TREE_COLUMNS, MAX_TREE_ROWS, RATING_FIELDS } from '../domain/crystal-edit'
import type { CatalogEntity, CatalogEntityKind, CatalogSnapshot, JsonValue, LocalData, SourceRef } from '../domain/types'
import { AppDataError } from './errors'
import { parseBoundedJson } from './json'
import type { ImportPreview, ImportProblem } from './types'
import { asCatalogId, asCatalogRevisionId, asImportReceiptId, createBlankLocalData, nowTimestamp, randomId, sha256, stableSourceId } from './util'

export const CRYSTAL_EDIT_FORMAT = CRYSTAL_EDIT_CATALOG_SCHEMA
const MAX_MODELS = 20_000
const modelId = z.number().int().min(0).max(0xffffffff)
const ids = z.array(modelId).max(MAX_MODELS)
const node = z.object({ NodeType: modelId, DataID: modelId, PrereqLeft: z.boolean(), PrereqMiddle: z.boolean(), PrereqRight: z.boolean() }).passthrough()
const model = z.object({ ID: modelId, Name: z.string().trim().min(1).max(512), Description: z.string().max(100_000).nullable().optional() }).passthrough()
const job = model.extend({
  ...Object.fromEntries(Object.values(RATING_FIELDS).map(field => [field, z.number().finite().min(0).max(MAX_GROWTH_RATING).nullable().optional()])),
  EquipmentTypes: ids.optional(), AbilityIDs: ids.optional(), PassiveIDs: ids.optional(),
  LearnTree: z.array(z.array(node).max(MAX_TREE_ROWS)).max(MAX_TREE_COLUMNS).optional(),
  IsStartingJob: z.boolean().optional(), IsUnselectableJob: z.boolean().optional(), IsUnselectableSubJob: z.boolean().optional(), IsNotCrystalJob: z.boolean().optional(),
})
const FAMILIES: Readonly<Record<string, CatalogEntityKind>> = Object.freeze({ Jobs: 'class', Abilities: 'ability', Passives: 'passive', Equipment: 'item', Items: 'item', Monsters: 'monster', Statuses: 'status', Recipes: 'recipe', Biomes: 'location' })
const ARCHIVED_FAMILIES = ['Animations', 'Genders', 'Sparks', 'Troops', 'Entities'] as const

function hasRuleData(root: Readonly<Record<string, JsonValue>>): boolean {
  return jsonRecord(root.System) && jsonRecord(root.System.BattleConfig) || Array.isArray(root.Difficulties) && root.Difficulties.length > 0
}

export function isCrystalEdit(value: JsonValue): boolean {
  return jsonRecord(value) && typeof value.ID === 'string' && typeof value.EditorVersion === 'number' && (Object.keys(FAMILIES).some(key => Array.isArray(value[key])) || hasRuleData(value))
}

export async function previewCrystalEdit(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  const root = parseBoundedJson(bytes, filename)
  if (!isCrystalEdit(root) || !jsonRecord(root) || typeof root.ID !== 'string' || !root.ID.trim() || root.ID.length > 512 || !Number.isSafeInteger(root.EditorVersion) || (root.EditorVersion as number) < 0) {
    throw new AppDataError('schema-mismatch', 'Crystal Edit JSON requires a project ID, editor version, and model arrays', { recoverable: true })
  }
  const digest = await sha256(bytes)
  const importedAt = nowTimestamp()
  const warnings: ImportProblem[] = []
  const archived = ARCHIVED_FAMILIES.flatMap(family => Array.isArray(root[family]) && root[family].length ? [`${family}: ${root[family].length}`] : [])
  const ignored = ARCHIVED_FAMILIES.reduce((sum, family) => sum + (Array.isArray(root[family]) ? root[family].length : 0), 0)
  if (archived.length) warnings.push({ severity: 'warning', code: 'archived-models', message: `These models are retained in the original source but are not searchable reference records: ${archived.join(', ')}` })
  const entities: Record<string, CatalogEntity> = {}
  let total = 0
  const sourceId = stableSourceId(digest)
  const projectKey = encodeURIComponent(root.ID)
  if (bundledModEntityId(projectKey, 'Equipment', 0xffffffff).length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(root.ID)) throw new AppDataError('schema-mismatch', 'The Crystal Edit project ID cannot produce a bounded portable entity identity', { recoverable: true })
  const identities: Record<string, string> = {}
  for (const [family, kind] of Object.entries(FAMILIES)) {
    const records = root[family]
    if (records === undefined) continue
    if (!Array.isArray(records) || records.length > MAX_MODELS) throw new AppDataError('schema-mismatch', `${family} must be a bounded model array`, { recoverable: true })
    for (const [index, entry] of records.entries()) {
      if (++total > MAX_MODELS) throw new AppDataError('schema-mismatch', 'The export contains too many models', { recoverable: true })
      const parsed = (family === 'Jobs' ? job : model).safeParse(entry)
      if (!parsed.success) throw new AppDataError('schema-mismatch', `Invalid Crystal Edit record at /${family}/${index}: ${parsed.error.issues[0]?.message ?? 'Invalid fields'}`, { recoverable: true })
      const record = parsed.data as Record<string, JsonValue>
      const id = bundledModEntityId(projectKey, family, record.ID as number)
      identities[`crystal-edit:${family}:${record.ID}`] = id
      if (entities[id]) throw new AppDataError('schema-mismatch', `Duplicate ${family} ID ${record.ID}`, { recoverable: true })
      const source: SourceRef = { sourceId, locator: `/${family}/${index}`, snapshot: `Crystal Edit ${root.EditorVersion}; project version ${typeof root.Version === 'string' ? root.Version.slice(0, 100) : 'unspecified'}`, applicability: 'Values from this project export; references may point to base-game definitions absent from the file' }
      const fields = {
        ...gameRecordFacts(record, kind, source, NATIVE_GAME_DATA.enums),
        'Crystal Edit model ID': { state: 'known' as const, value: record.ID!, sources: [source] },
        'Crystal Edit model type': { state: 'known' as const, value: family, sources: [source] },
        'Crystal Edit source record': { state: 'known' as const, value: record, sources: [source] },
        ...(family === 'Jobs' ? classFields(record, source) : {}),
        ...(family === 'Jobs' ? { 'Class change': { state: 'known' as const, value: (record.ID as number) <= LAST_VANILLA_JOB_ID ? `Edits vanilla class ID ${record.ID}` : 'Adds a custom class', sources: [source, { sourceId: 'community:geef-modding-guide', locator: 'Crystal Edit anatomy > Editor controls and Grid viewers', applicability: 'Vanilla job IDs 0 through 23 are editable and cannot be deleted' }] } } : {}),
      }
      entities[id] = { id, kind, name: record.Name as string, aliases: [], fields, sources: [source], ...(typeof record.Description === 'string' && record.Description ? { rawDescription: record.Description } : {}) }
    }
  }
  if (!total && !hasRuleData(root)) throw new AppDataError('schema-mismatch', 'This export contains no supported reference models or game settings', { recoverable: true })
  for (const entity of Object.values(entities).filter(entity => entity.kind === 'class')) {
    const record = entity.fields['Crystal Edit source record']
    if (record?.state !== 'known' || !jsonRecord(record.value) || !Array.isArray(record.value.PassiveIDs)) continue
    const passives = Object.fromEntries(record.value.PassiveIDs.flatMap(id => {
      const target = identities[`crystal-edit:Passives:${id}`]
      return target ? [[String(id), target]] : []
    }))
    entities[entity.id] = { ...entity, legacy: { passiveEntityIds: passives } }
  }
  const missing = new Set<string>()
  for (const entity of Object.values(entities).filter(entity => entity.kind === 'class')) {
    const record = entity.fields['Crystal Edit source record']
    if (record?.state !== 'known' || !jsonRecord(record.value)) continue
    for (const [field, family] of [['AbilityIDs', 'Abilities'], ['PassiveIDs', 'Passives']] as const) {
      const values = record.value[field]
      if (Array.isArray(values)) for (const id of values) if (typeof id === 'number' && !entities[bundledModEntityId(projectKey, family, id)]) missing.add(`${family} #${id}`)
    }
    const tree = record.value.LearnTree
    if (Array.isArray(tree)) for (const column of tree) if (Array.isArray(column)) for (const cell of column) {
      if (!jsonRecord(cell)) continue
      const family = cell.NodeType === LEARN_NODE_TYPES.ability ? 'Abilities' : cell.NodeType === LEARN_NODE_TYPES.passive ? 'Passives' : undefined
      if (family && typeof cell.DataID === 'number' && !entities[bundledModEntityId(projectKey, family, cell.DataID)]) missing.add(`${family} #${cell.DataID}`)
      if (typeof cell.NodeType === 'number' && cell.NodeType > LEARN_NODE_TYPES.passive) warnings.push({ severity: 'warning', code: 'unknown-tree-node', message: `Unrecognized learn-tree node type ${cell.NodeType} was retained`, locator: entity.sources[0]?.locator })
    }
  }
  if (missing.size) warnings.push({ severity: 'warning', code: 'external-model-references', message: `${missing.size} referenced ability or passive definitions are absent. Their IDs and tree positions are retained; names, costs, and effects remain unresolved.` })
  const catalog: CatalogSnapshot = {
    id: asCatalogId(`crystal-edit:${root.ID}`), revisionId: asCatalogRevisionId(`sha256:${digest}:${IMPORTED_RULES_REVISION}`), schemaVersion: CRYSTAL_EDIT_FORMAT,
    checksum: `sha256:${digest}`, importedAt, entities, claims: [],
    applicability: { state: 'known', value: 'Crystal Edit project data; game platform and enabled-mod applicability are unverified' },
    rights: { state: 'unknown', reason: 'No content license is established by the project file' },
    legacy: { gameRules: importedGameRules(root), projectTitle: typeof root.Title === 'string' && root.Title.trim() ? root.Title.slice(0, 512) : root.ID, editorVersion: root.EditorVersion!, projectVersion: root.Version ?? null, unresolvedReferences: [...missing], crystalEditIdentities: identities },
  }
  const base = createBlankLocalData('Imported Crystal Edit references', importedAt)
  const receiptId = asImportReceiptId(`import:${digest}:${IMPORTED_RULES_REVISION}`)
  const localData: LocalData = { ...base, importReceipts: { [receiptId]: { id: receiptId, sourceFormat: CRYSTAL_EDIT_FORMAT, sourceIdentity: `sha256:${digest}`, importedAt, localDataRevision: 0 } } }
  return {
    id: randomId('import-preview'), filename, detectedFormat: CRYSTAL_EDIT_FORMAT, detectedSchema: `Crystal Edit ${root.EditorVersion}`, sourceDigest: digest,
    counts: { reference: total, personal: 0, mixed: 0, ignored }, warnings, errors: [], localData: { label: base.playthroughs[base.selectedPlaythroughId!]!.label },
    proposed: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [catalog], evidence: [], history: [], sources: [{ id: sourceId, digest, filename, mediaType: 'application/json', format: CRYSTAL_EDIT_FORMAT, importedAt, bytes: Uint8Array.from(bytes) }] },
  }
}
