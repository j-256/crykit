import type {
  CatalogClaim,
  CatalogEntity,
  CatalogEntityKind,
  CatalogSnapshot,
  EntityId,
  InventoryEvent,
  JsonValue,
  Knowledge,
  PartyProgressRecord,
  Profile,
  RulesetRevision,
  RulesetRevisionId,
  SourceRef,
  Timestamp,
} from '../domain/types'
import { AppDataError } from './errors'
import { normalizeImportedFieldName } from './field-names'
import { isJsonObject, parseBoundedJson } from './json'
import type {
  EvidenceRecord,
  ImportCounts,
  ImportFormat,
  ImportPreview,
  ImportProblem,
  SourceArchiveRecord,
} from './types'
import {
  asCatalogId,
  asCatalogRevisionId,
  asImportReceiptId,
  asInventoryEventId,
  asProgressRecordId,
  createBlankProfile,
  nowTimestamp,
  randomId,
  sha256,
  stableSourceId,
} from './util'

interface ResearchArrayConfig {
  readonly group: 'reference' | 'personal' | 'mixed'
  readonly kind?: CatalogEntityKind
  readonly nameKeys?: readonly string[]
  readonly idKeys?: readonly string[]
}

const RESEARCH_ARRAYS: Readonly<Record<string, ResearchArrayConfig>> = Object.freeze({
  classes: { group: 'reference', kind: 'class', nameKeys: ['name', 'class'], idKeys: ['id', 'class_id'] },
  abilities: { group: 'reference', kind: 'ability', nameKeys: ['name', 'ability'], idKeys: ['id', 'ability_id'] },
  innates: { group: 'reference', kind: 'innate', nameKeys: ['name', 'innate'], idKeys: ['id', 'innate_id'] },
  passives: { group: 'reference', kind: 'passive', nameKeys: ['name', 'passive'], idKeys: ['id', 'passive_id'] },
  monster_magic: { group: 'reference', kind: 'monsterMagic', nameKeys: ['name', 'spell'], idKeys: ['id', 'ability_id'] },
  base_equipment: { group: 'reference', kind: 'item', nameKeys: ['name', 'item'], idKeys: ['id', 'item_id'] },
  expansion_items: { group: 'reference', kind: 'item', nameKeys: ['name', 'item'], idKeys: ['id', 'item_id'] },
  expansion_stat_components: { group: 'reference' },
  unparsed_stat_tokens: { group: 'reference' },
  expansion_locations: { group: 'reference' },
  recipes: { group: 'reference', kind: 'recipe', nameKeys: ['name', 'output'], idKeys: ['id', 'recipe_id'] },
  conflicts: { group: 'mixed' },
  sources: { group: 'mixed' },
  coverage: { group: 'reference' },
  planner_rules: { group: 'mixed' },
  progress: { group: 'personal' },
  inventory: { group: 'personal' },
  characters: { group: 'personal' },
  character_mastery: { group: 'personal' },
  learned_passives: { group: 'personal' },
  loadouts: { group: 'personal' },
  mod_overrides: { group: 'personal' },
})

const MAX_IMPORT_ID_LENGTH = 1_024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const DESCRIPTION_FIELDS = new Set(['description', 'raw description', 'effect', 'effects raw'])
const PP_FIELDS = new Set(['pp', 'pp cost'])

function importedId(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > MAX_IMPORT_ID_LENGTH || CONTROL_CHARACTER.test(value)) {
    throw new AppDataError('schema-mismatch', `${label} must be nonempty, bounded text without control characters`, {
      recoverable: true,
    })
  }
  return value
}

function uniqueEntityId(
  entities: Readonly<Record<string, CatalogEntity>>,
  preferred: string,
  sourceScopedFallback: string,
): string {
  if (!Object.hasOwn(entities, preferred)) return preferred
  let candidate = sourceScopedFallback
  let suffix = 2
  while (Object.hasOwn(entities, candidate)) {
    candidate = `${sourceScopedFallback}:duplicate:${suffix}`
    suffix += 1
  }
  return candidate
}

function rawDescription(record: { readonly [key: string]: JsonValue }): string | undefined {
  const descriptions = Object.entries(record)
    .filter(([field, value]) => DESCRIPTION_FIELDS.has(normalizeImportedFieldName(field)) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value as string)
  const unique = Array.from(new Set(descriptions))
  return unique.length > 0 ? unique.join('\n') : undefined
}

function aliases(record: { readonly [key: string]: JsonValue }): readonly string[] {
  const value = record.aliases
  if (!Array.isArray(value)) return []
  return value.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0)
}

function ppCost(record: { readonly [key: string]: JsonValue }, source: SourceRef): Knowledge<number> | undefined {
  const entry = Object.entries(record).find(([field]) => PP_FIELDS.has(normalizeImportedFieldName(field)))
  if (!entry) return undefined
  const [, value] = entry
  return typeof value === 'number'
    ? { state: 'known', value, sources: [source] }
    : { state: 'unknown', reason: 'The explicit PP field is not a numeric source value', sources: [source] }
}

function objectArray(root: { readonly [key: string]: JsonValue }, key: string): readonly { readonly [key: string]: JsonValue }[] {
  const value = root[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => !isJsonObject(entry))) {
    throw new AppDataError('schema-mismatch', `Research JSON field ${key} must be an array of objects`, {
      recoverable: true,
    })
  }
  return value as readonly { readonly [key: string]: JsonValue }[]
}

function firstString(record: { readonly [key: string]: JsonValue }, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function sourceRef(digest: string, pointer: string): SourceRef {
  return { sourceId: stableSourceId(digest), locator: pointer, snapshot: `sha256:${digest}` }
}

function knowledge(value: JsonValue | undefined, source: SourceRef, key: string): Knowledge<JsonValue> {
  if (value === undefined || value === null) {
    return { state: 'unknown', reason: 'Missing or null in research source', sources: [source] }
  }
  if (key.toLocaleLowerCase().includes('formula')) {
    return { state: 'unknown', reason: 'Formula text is retained as inert source data', sources: [source] }
  }
  return { state: 'known', value, sources: [source] }
}

function collectAmbiguousEntityIds(root: { readonly [key: string]: JsonValue }, digest: string): Set<string> {
  const candidates: string[] = []
  for (const [arrayName, config] of Object.entries(RESEARCH_ARRAYS)) {
    if (!config.kind || !config.nameKeys || !config.idKeys) continue
    for (const [index, record] of objectArray(root, arrayName).entries()) {
      if (!firstString(record, config.nameKeys)) continue
      const fallbackId = `research:${digest.slice(0, 16)}:${arrayName}:${index}`
      candidates.push(importedId(firstString(record, config.idKeys) ?? fallbackId, `/${arrayName}/${index} identity`))
    }
  }
  for (const arrayName of ['expansion_locations', 'conflicts', 'planner_rules'] as const) {
    const idKeys = arrayName === 'expansion_locations' ? ['location_id', 'id'] : arrayName === 'conflicts' ? ['issue_id', 'id'] : ['rule_id', 'id']
    for (const [index, record] of objectArray(root, arrayName).entries()) {
      const fallbackId = `research:${digest.slice(0, 16)}:${arrayName}:${index}`
      candidates.push(importedId(firstString(record, idKeys) ?? fallbackId, `/${arrayName}/${index} identity`))
    }
  }
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate)) ambiguous.add(candidate)
    seen.add(candidate)
  }
  return ambiguous
}

function buildCatalog(
  root: { readonly [key: string]: JsonValue },
  digest: string,
  importedAt: Timestamp,
  warnings: ImportProblem[],
  ambiguousEntityIds: Set<string>,
): CatalogSnapshot {
  for (const id of collectAmbiguousEntityIds(root, digest)) ambiguousEntityIds.add(id)
  const entities = Object.create(null) as Record<string, CatalogEntity>
  const claims: CatalogClaim[] = []
  for (const [arrayName, config] of Object.entries(RESEARCH_ARRAYS)) {
    if (!config.kind || !config.nameKeys || !config.idKeys) continue
    for (const [index, record] of objectArray(root, arrayName).entries()) {
      const pointer = `/${arrayName}/${index}`
      const source = sourceRef(digest, pointer)
      const name = firstString(record, config.nameKeys)
      if (!name) {
        warnings.push({
          severity: 'warning',
          code: 'missing-entity-name',
          message: `${arrayName} contains a row without a supported name field`,
          locator: pointer,
        })
        continue
      }
      const suppliedId = firstString(record, config.idKeys)
      const fallbackId = `research:${digest.slice(0, 16)}:${arrayName}:${index}`
      const preferredId = importedId(suppliedId ?? fallbackId, `${pointer} identity`)
      const id = uniqueEntityId(entities, preferredId, fallbackId)
      if (id !== preferredId) {
        ambiguousEntityIds.add(preferredId)
        warnings.push({
          severity: 'warning',
          code: 'duplicate-entity-id',
          message: `A duplicate source ID was preserved separately: ${preferredId}`,
          locator: pointer,
        })
      }
      const omitted = new Set([...config.nameKeys, ...config.idKeys])
      const description = rawDescription(record)
      const documentedPpCost = ppCost(record, source)
      entities[id] = {
        id: id as EntityId,
        kind: config.kind,
        name,
        aliases: aliases(record),
        fields: Object.fromEntries(
          Object.entries(record)
            .filter(([key]) => !omitted.has(key))
            .map(([key, value]) => [key, knowledge(value, source, key)]),
        ),
        sources: [source],
        ...(description === undefined ? {} : { rawDescription: description }),
        ...(documentedPpCost === undefined ? {} : { ppCost: documentedPpCost }),
      }
    }
  }
  const uniqueByName = new Map<string, CatalogEntity | null>()
  for (const entity of Object.values(entities)) {
    const key = `${entity.kind}:${entity.name.toLocaleLowerCase()}`
    uniqueByName.set(key, uniqueByName.has(key) ? null : entity)
  }
  const supplemental = [
    { array: 'expansion_stat_components', kind: 'item' as const, names: ['item', 'name'], ids: ['item_id', 'id'] },
    { array: 'unparsed_stat_tokens', kind: 'item' as const, names: ['item', 'name'], ids: ['item_id', 'id'] },
    { array: 'coverage', kind: 'class' as const, names: ['class', 'name'], ids: ['class_id', 'id'] },
  ]
  for (const config of supplemental) {
    for (const [index, record] of objectArray(root, config.array).entries()) {
      const suppliedId = firstString(record, config.ids)
      const name = firstString(record, config.names)
      const ambiguousId = suppliedId ? ambiguousEntityIds.has(suppliedId) : false
      const entity = suppliedId && !ambiguousId && entities[suppliedId]?.kind === config.kind
        ? entities[suppliedId]
        : !ambiguousId && name
          ? uniqueByName.get(`${config.kind}:${name.toLocaleLowerCase()}`) ?? undefined
          : undefined
      if (!entity) {
        warnings.push({
          severity: 'warning',
          code: ambiguousId ? 'ambiguous-entity-id' : 'unresolved-reference-row',
          message: ambiguousId
            ? `${config.array} cites a duplicated source ID and was left unlinked`
            : `${config.array} contains a row that could not be linked to one unique ${config.kind}`,
          locator: `/${config.array}/${index}`,
        })
        continue
      }
      const source = sourceRef(digest, `/${config.array}/${index}`)
      for (const [field, value] of Object.entries(record)) {
        if (config.names.includes(field) || config.ids.includes(field)) continue
        claims.push({
          entityId: entity.id,
          field: `${config.array}.${field}`,
          value: knowledge(value, source, field),
          sources: [source],
        })
      }
    }
  }
  for (const [index, record] of objectArray(root, 'expansion_locations').entries()) {
    const pointer = `/expansion_locations/${index}`
    const source = sourceRef(digest, pointer)
    const name = firstString(record, ['location', 'location_name', 'source', 'item', 'item_group', 'name']) ?? `Location row ${index + 1}`
    const suppliedId = firstString(record, ['location_id', 'id'])
    const fallbackId = `research:${digest.slice(0, 16)}:expansion_locations:${index}`
    const preferredId = importedId(suppliedId ?? fallbackId, `${pointer} identity`)
    const id = uniqueEntityId(entities, preferredId, fallbackId)
    if (id !== preferredId) {
      ambiguousEntityIds.add(preferredId)
      warnings.push({ severity: 'warning', code: 'duplicate-entity-id', message: `A duplicate source ID was preserved separately: ${preferredId}`, locator: pointer })
    }
    const description = rawDescription(record)
    const documentedPpCost = ppCost(record, source)
    entities[id] = {
      id: id as EntityId,
      kind: 'location',
      name,
      aliases: aliases(record),
      fields: Object.fromEntries(Object.entries(record).map(([key, value]) => [key, knowledge(value, source, key)])),
      sources: [source],
      ...(description === undefined ? {} : { rawDescription: description }),
      ...(documentedPpCost === undefined ? {} : { ppCost: documentedPpCost }),
    }
    const itemId = firstString(record, ['item_id', 'exact_item_id'])
    const itemName = firstString(record, ['item', 'item_name'])
    const ambiguousItemId = itemId ? ambiguousEntityIds.has(itemId) : false
    const item = itemId && !ambiguousItemId && entities[itemId]?.kind === 'item'
      ? entities[itemId]
      : !ambiguousItemId && itemName
        ? uniqueByName.get(`item:${itemName.toLocaleLowerCase()}`) ?? undefined
        : undefined
    if (item) {
      claims.push({
        entityId: item.id,
        field: 'expansion_locations.location',
        value: { state: 'known', value: name, sources: [source] },
        sources: [source],
      })
    } else if (ambiguousItemId) {
      warnings.push({
        severity: 'warning',
        code: 'ambiguous-entity-id',
        message: 'An expansion location cites a duplicated item ID and was left unlinked',
        locator: pointer,
      })
    }
  }
  for (const config of [
    { array: 'conflicts', nameKeys: ['topic', 'name'], idKeys: ['issue_id', 'id'], prefix: 'Conflict' },
    { array: 'planner_rules', nameKeys: ['rule', 'name'], idKeys: ['rule_id', 'id'], prefix: 'PlannerRule' },
  ]) {
    for (const [index, record] of objectArray(root, config.array).entries()) {
      const pointer = `/${config.array}/${index}`
      const source = sourceRef(digest, pointer)
      const name = firstString(record, config.nameKeys) ?? `${config.prefix} row ${index + 1}`
      const fallbackId = `research:${digest.slice(0, 16)}:${config.array}:${index}`
      const preferredId = importedId(firstString(record, config.idKeys) ?? fallbackId, `${pointer} identity`)
      const id = uniqueEntityId(entities, preferredId, fallbackId)
      if (id !== preferredId) {
        ambiguousEntityIds.add(preferredId)
        warnings.push({ severity: 'warning', code: 'duplicate-entity-id', message: `A duplicate source ID was preserved separately: ${preferredId}`, locator: pointer })
      }
      const description = rawDescription(record)
      const documentedPpCost = ppCost(record, source)
      entities[id] = {
        id: id as EntityId,
        kind: 'other',
        name,
        aliases: aliases(record),
        fields: Object.fromEntries(Object.entries(record).map(([key, value]) => [key, knowledge(value, source, key)])),
        sources: [source],
        ...(description === undefined ? {} : { rawDescription: description }),
        ...(documentedPpCost === undefined ? {} : { ppCost: documentedPpCost }),
      }
    }
  }
  const explicitCatalogId = typeof root.catalog_id === 'string'
    ? root.catalog_id
    : typeof root.source_namespace === 'string'
      ? root.source_namespace
      : ''
  if (explicitCatalogId) importedId(explicitCatalogId, 'Research catalog identity')
  const normalizedTopLevel = new Set([...Object.keys(RESEARCH_ARRAYS), 'player_context'])
  return {
    id: asCatalogId(explicitCatalogId || `research:${digest}`),
    revisionId: asCatalogRevisionId(`sha256:${digest}`),
    schemaVersion: '1.1.0',
    checksum: `sha256:${digest}`,
    importedAt,
    applicability: { state: 'unknown', reason: 'Exact game and mod version remain unspecified' },
    rights: { state: 'unknown', reason: 'Redistribution rights require source-by-source review' },
    entities,
    claims,
    legacy: Object.fromEntries(Object.entries(root).filter(([key]) => !normalizedTopLevel.has(key))),
  }
}

function progressRecords(
  root: { readonly [key: string]: JsonValue },
  catalog: CatalogSnapshot,
  digest: string,
  importedAt: Timestamp,
  warnings: ImportProblem[],
  ambiguousEntityIds: ReadonlySet<string>,
): Readonly<Record<string, PartyProgressRecord>> {
  const entitiesByName = new Map<string, CatalogEntity | null>()
  for (const entity of Object.values(catalog.entities).filter((candidate) => candidate.kind === 'class')) {
    const key = entity.name.toLocaleLowerCase()
    entitiesByName.set(key, entitiesByName.has(key) ? null : entity)
  }
  const result: Record<string, PartyProgressRecord> = {}
  for (const [index, record] of objectArray(root, 'progress').entries()) {
    const pointer = `/progress/${index}`
    const name = firstString(record, ['class', 'name', 'display_name'])
    const suppliedId = firstString(record, ['class_id', 'entity_id'])
    const ambiguousId = suppliedId ? ambiguousEntityIds.has(suppliedId) : false
    const entity = suppliedId && !ambiguousId && catalog.entities[suppliedId]?.kind === 'class'
      ? catalog.entities[suppliedId]
      : !ambiguousId && name
        ? entitiesByName.get(name.toLocaleLowerCase()) ?? undefined
        : undefined
    if (!entity) {
      warnings.push({
        severity: 'warning',
        code: 'unresolved-progress-class',
        message: 'A progress row was retained but could not be linked to a class definition',
        locator: pointer,
      })
      continue
    }
    const displayName = name ?? entity.name
    const source = sourceRef(digest, pointer)
    const mastery = firstString(record, ['mastery', 'mastery_status', 'status'])?.trim().toLocaleLowerCase()
    const seal = firstString(record, ['seal', 'seal_status'])?.trim().toLocaleLowerCase()
    const location = firstString(record, ['master_location', 'location'])
    const id = asProgressRecordId(`progress:${digest.slice(0, 16)}:${index}`)
    const isMastered = mastery === 'mastered'
    const inProgress = mastery === 'in progress'
    const collected = seal === 'collected'
    const awaiting = seal === 'awaiting collection'
    result[id] = {
      id,
      revision: 0,
      subject: {
        kind: 'catalog',
        catalogId: catalog.id,
        catalogRevisionId: catalog.revisionId,
        entityId: entity.id,
      },
      displayName,
      stage: collected
        ? { state: 'known', value: 'sealAcquired', sources: [source] }
        : isMastered && awaiting
          ? { state: 'known', value: 'mastered', sources: [source] }
          : inProgress
            ? { state: 'known', value: 'unlocked', sources: [source] }
            : { state: 'unknown', reason: 'Source labels did not establish a stage', sources: [source] },
      unlocked: isMastered || inProgress
        ? { state: 'known', value: true, sources: [source] }
        : { state: 'unknown', reason: 'Unlock state was not established', sources: [source] },
      partyMastery: isMastered
        ? { state: 'known', value: true, sources: [source] }
        : inProgress
          ? { state: 'known', value: false, sources: [source] }
          : { state: 'unknown', reason: 'Party mastery was not established', sources: [source] },
      collection: collected
        ? { state: 'known', value: true, sources: [source] }
        : awaiting
          ? { state: 'known', value: false, sources: [source] }
          : { state: 'unknown', reason: 'Collection was not established', sources: [source] },
      masterLocation: location
        ? { state: 'known', value: location, sources: [source] }
        : { state: 'unknown', reason: 'Master location was not supplied', sources: [source] },
      sources: [source],
      updatedAt: importedAt,
    }
  }
  return result
}

function inventoryEvents(
  root: { readonly [key: string]: JsonValue },
  catalog: CatalogSnapshot,
  digest: string,
  importedAt: Timestamp,
  warnings: ImportProblem[],
  ambiguousEntityIds: ReadonlySet<string>,
): Readonly<Record<string, InventoryEvent>> {
  const entitiesByName = new Map<string, CatalogEntity | null>()
  for (const entity of Object.values(catalog.entities).filter((candidate) => candidate.kind === 'item')) {
    const key = entity.name.toLocaleLowerCase()
    entitiesByName.set(key, entitiesByName.has(key) ? null : entity)
  }
  const result: Record<string, InventoryEvent> = {}
  for (const [index, record] of objectArray(root, 'inventory').entries()) {
    const pointer = `/inventory/${index}`
    if (record.acquired !== true) continue
    const name = firstString(record, ['item', 'name', 'display_name'])
    const suppliedId = firstString(record, ['item_id', 'entity_id'])
    const ambiguousId = suppliedId ? ambiguousEntityIds.has(suppliedId) : false
    const entity = suppliedId && !ambiguousId && catalog.entities[suppliedId]?.kind === 'item'
      ? catalog.entities[suppliedId]
      : !ambiguousId && name
        ? entitiesByName.get(name.toLocaleLowerCase()) ?? undefined
        : undefined
    if (!entity) {
      warnings.push({
        severity: 'warning',
        code: 'unresolved-inventory-item',
        message: 'A historical acquisition was retained but could not be linked to an item definition',
        locator: pointer,
      })
      continue
    }
    const displayName = name ?? entity.name
    const source = sourceRef(digest, pointer)
    const id = asInventoryEventId(`event:${digest.slice(0, 16)}:${index}`)
    result[id] = {
      id,
      ref: {
        kind: 'catalog',
        catalogId: catalog.id,
        catalogRevisionId: catalog.revisionId,
        entityId: entity.id,
      },
      observedName: displayName,
      kind: 'acquired',
      quantity: { state: 'unknown', reason: 'Historical acquisition did not establish an amount', sources: [source] },
      recordedAt: importedAt,
      sources: [source],
      note: 'Historical acquisition only; current possession and quantity remain unknown',
    }
  }
  return result
}

function ruleset(
  root: { readonly [key: string]: JsonValue },
  catalog: CatalogSnapshot,
  digest: string,
  importedAt: Timestamp,
): RulesetRevision | undefined {
  const context = root.player_context
  if (!context || !isJsonObject(context)) return undefined
  const platform = typeof context.platform === 'string' && context.platform.length > 0 ? context.platform : undefined
  const source = sourceRef(digest, '/player_context/platform')
  const id = `ruleset-revision:${digest.slice(0, 16)}` as RulesetRevisionId
  return {
    id,
    rulesetId: `ruleset:${digest.slice(0, 16)}` as RulesetRevision['rulesetId'],
    revision: 1,
    label: 'Imported playthrough context',
    platform: platform
      ? { state: 'known', value: platform, sources: [source] }
      : { state: 'unknown', reason: 'Platform was not supplied' },
    gameVersion: { state: 'unknown', reason: 'Exact game version was not supplied' },
    mode: { state: 'unknown', reason: 'Standard/Vanilla mode was not supplied' },
    mods: { state: 'unknown', reason: 'Exact mod IDs, versions, and load order were not supplied' },
    ppLimit: { state: 'unknown', reason: 'No passive point limit was supplied' },
    ppCostsNonNegative: { state: 'unknown', reason: 'No complete ruleset verification was supplied' },
    slots: [],
    catalogLock: { [catalog.id]: catalog.revisionId },
    createdAt: importedAt,
  }
}

function importCounts(root: { readonly [key: string]: JsonValue }): ImportCounts {
  const result = { reference: 0, personal: 0, mixed: 0, ignored: 0 }
  for (const [name, config] of Object.entries(RESEARCH_ARRAYS)) result[config.group] += objectArray(root, name).length
  if (isJsonObject(root.player_context)) result.personal += 1
  return result
}

function evidenceRecords(
  root: { readonly [key: string]: JsonValue },
  digest: string,
): readonly EvidenceRecord[] {
  const evidence: EvidenceRecord[] = []
  for (const [name, config] of Object.entries(RESEARCH_ARRAYS)) {
    for (const [index, record] of objectArray(root, name).entries()) {
      const locator = `/${name}/${index}`
      evidence.push({
        id: `evidence:${digest}:${name}:${index}`,
        sourceDigest: digest,
        group: config.group,
        kind: `research-json-row:${name}`,
        locator,
        sources: [sourceRef(digest, locator)],
        payload: record,
        private: true,
      })
    }
  }
  if (root.player_context !== undefined) {
    evidence.push({
      id: `evidence:${digest}:player_context`,
      sourceDigest: digest,
      group: 'personal',
      kind: 'research-json-object:player_context',
      locator: '/player_context',
      sources: [sourceRef(digest, '/player_context')],
      payload: root.player_context,
      private: true,
    })
  }
  return evidence
}

export async function previewResearchJson(
  jsonBytes: Uint8Array,
  filename: string,
  options: {
    containerBytes?: Uint8Array
    containerFilename?: string
    format?: ImportFormat
  } = {},
): Promise<ImportPreview> {
  const rootValue = parseBoundedJson(jsonBytes, filename)
  if (!isJsonObject(rootValue) || rootValue.schema_version !== '1.1.0') {
    throw new AppDataError('schema-mismatch', 'Research JSON must declare schema_version 1.1.0', {
      recoverable: true,
    })
  }
  const sourceBytes = options.containerBytes ?? jsonBytes
  const sourceFilename = options.containerFilename ?? filename
  const format = options.format ?? 'research-json-1.1.0'
  const digest = await sha256(sourceBytes)
  const importedAt = nowTimestamp()
  const warnings: ImportProblem[] = [
    {
      severity: 'warning',
      code: 'private-source',
      message: 'This package may contain personal observations and will remain local',
    },
    {
      severity: 'warning',
      code: 'unreviewed-rights',
      message: 'Imported reference rows are not approved for public redistribution',
    },
  ]
  const ambiguousEntityIds = new Set<string>()
  const catalog = buildCatalog(rootValue, digest, importedAt, warnings, ambiguousEntityIds)
  const profile = createBlankProfile('Imported playthrough', importedAt)
  const importedRuleset = ruleset(rootValue, catalog, digest, importedAt)
  const receiptId = asImportReceiptId(`import:${digest}`)
  const proposedProfile: Profile = {
    ...profile,
    activeRulesetRevisionId: importedRuleset?.id,
    rulesets: importedRuleset ? { [importedRuleset.id]: importedRuleset } : {},
    progress: progressRecords(rootValue, catalog, digest, importedAt, warnings, ambiguousEntityIds),
    inventoryEvents: inventoryEvents(rootValue, catalog, digest, importedAt, warnings, ambiguousEntityIds),
    importReceipts: {
      [receiptId]: {
        id: receiptId,
        sourceFormat: format,
        sourceIdentity: `sha256:${digest}`,
        importedAt,
        profileRevision: profile.revision,
      },
    },
  }
  for (const unsupported of ['characters', 'character_mastery', 'learned_passives', 'loadouts', 'mod_overrides']) {
    if (objectArray(rootValue, unsupported).length > 0) {
      warnings.push({
        severity: 'warning',
        code: 'personal-records-retained-only',
        message: `${unsupported} records were retained as evidence but require an explicit schema mapper before application`,
        locator: `/${unsupported}`,
      })
    }
  }
  const source: SourceArchiveRecord = {
    id: stableSourceId(digest),
    digest,
    filename: sourceFilename,
    mediaType: format === 'research-zip-1.1.0' ? 'application/zip' : 'application/json',
    format,
    importedAt,
    bytes: Uint8Array.from(sourceBytes),
  }
  return {
    id: randomId('import-preview'),
    filename: sourceFilename,
    detectedFormat: format,
    detectedSchema: '1.1.0',
    sourceDigest: digest,
    counts: importCounts(rootValue),
    warnings,
    errors: [],
    profile: { label: proposedProfile.label },
    proposed: {
      profile: proposedProfile,
      lineage: { rootProfileId: proposedProfile.id },
      catalogs: [catalog],
      evidence: evidenceRecords(rootValue, digest),
      sources: [source],
      history: [],
    },
  }
}
